import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  applyAction,
  createDeck,
  createGame,
  handSizeFor,
  settle,
  viewFor,
  type Card,
  type FinishedState,
  type GameState,
  type Seat,
} from "pescalo";
import { describe, expect, it } from "vitest";
import { lobbyDoName } from "../src/durable-objects/lobby";
import type { ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/pescalo-protocol";
import { isUserInLiveGame } from "../src/game/live-check";

const STAKE = 10;
const GAME_ID = "pescalo";
const MAX_TURNS = 600;

// --- User / table setup helpers, mirroring test/chudaidi-table.test.ts ---

function uniqueUsername(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  return setCookie.split(";")[0];
}

async function registerUser(prefix: string): Promise<{ id: string; username: string; cookie: string }> {
  const username = uniqueUsername(prefix);
  const res = await SELF.fetch("http://example.com/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ id: string }>();
  return { id: body.id, username, cookie: extractCookie(res) };
}

async function initTable(tableId: string, hostCookie: string, stake: number): Promise<void> {
  const res = await SELF.fetch(`http://example.com/api/tables/${tableId}/init`, {
    method: "POST",
    headers: { cookie: hostCookie, "content-type": "application/json" },
    body: JSON.stringify({ gameId: GAME_ID, stake, visibility: "private" }),
  });
  expect(res.status).toBe(200);
}

function quickPlay(cookie: string): Promise<Response> {
  return SELF.fetch(`http://example.com/api/lobby/${GAME_ID}/quickplay`, {
    method: "POST",
    headers: { cookie },
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function openTableSocket(tableId: string, cookie: string): Promise<FrameQueue> {
  const res = await SELF.fetch(`http://example.com/api/tables/${GAME_ID}/${tableId}/ws`, {
    headers: { Upgrade: "websocket", cookie },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("server did not accept the websocket upgrade");
  ws.accept();
  return attachFrameQueue(ws);
}

async function openSockets(tableId: string, cookies: readonly string[]): Promise<FrameQueue[]> {
  // Sequential connects pin seat i to cookies[i].
  const sockets: FrameQueue[] = [];
  for (const cookie of cookies) sockets.push(await openTableSocket(tableId, cookie));
  return sockets;
}

function send(socket: FrameQueue, msg: Record<string, unknown>): void {
  socket.ws.send(JSON.stringify(msg));
}

// --- Frame queue (same forward-scanning cursor as the other DO tests) ---

interface FrameQueue {
  readonly ws: WebSocket;
  readonly messages: readonly ServerMessage[];
  nextFrameMatching(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
}

function attachFrameQueue(ws: WebSocket): FrameQueue {
  const messages: ServerMessage[] = [];
  let cursor = 0;
  let pending: {
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  ws.addEventListener("message", (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    messages.push(msg);
    if (pending && pending.pred(msg)) {
      const { resolve, timer } = pending;
      pending = null;
      clearTimeout(timer);
      cursor = messages.length;
      resolve(msg);
    }
  });

  return {
    ws,
    messages,
    nextFrameMatching(pred, timeoutMs = 3000) {
      for (let i = cursor; i < messages.length; i++) {
        if (pred(messages[i])) {
          cursor = i + 1;
          return Promise.resolve(messages[i]);
        }
      }
      if (pending) {
        throw new Error("nextFrameMatching does not support concurrent waiters on one socket");
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(new Error("timed out waiting for expected frame"));
        }, timeoutMs);
        pending = { pred, resolve, timer };
      });
    },
  };
}

function asStateMessage(m: ServerMessage): StateMessage | null {
  return m.type === "state" ? m : null;
}

function playingView(m: ServerMessage) {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "playing") return null;
  return s.view;
}

async function ledgerRowsForRound(tableId: string, round: number) {
  return env.DB.prepare(
    `SELECT user_id as userId, amount, idempotency_key as idempotencyKey
     FROM credit_ledger WHERE idempotency_key LIKE ?`,
  )
    .bind(`settle:${tableId}:${round}:%`)
    .all<{ userId: string; amount: number; idempotencyKey: string }>();
}

async function creditsOf(users: readonly { id: string }[]): Promise<number[]> {
  const rows = await Promise.all(
    users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
  );
  return rows.map((r) => r!.credits);
}

// --- Scripted deck and lockstep replay -------------------------------------------
//
// The DO's only randomness is the shuffle and the first seat, both fixed by
// setTestFixedDeal, so a pure-engine replay of the same asks predicts every
// frame exactly. The greedy script: ask the next seat for the lowest rank
// held. Each ask always changes the public view, so a frame equal to the
// replay's view is unambiguous.

function scriptedDeck(): Card[] {
  const deck = createDeck();
  // Interleave suits so the 7-card hands hold pairs and the game stays short.
  return [...deck.filter((_, i) => i % 2 === 0), ...deck.filter((_, i) => i % 2 === 1)];
}

function nextTarget(activeSeats: readonly Seat[], seat: Seat): Seat {
  return activeSeats[(activeSeats.indexOf(seat) + 1) % activeSeats.length];
}

function scriptedAsk(state: GameState): { seat: Seat; target: Seat; rank: number } {
  if (state.phase !== "playing") throw new Error("hand already finished");
  const seat = state.currentTurn;
  const rank = Math.min(...state.hands[seat].map((c) => c.rank));
  return { seat, target: nextTarget(state.activeSeats, seat), rank };
}

/** Plays the greedy script through the engine only; the expected final state. */
function replayScript(deck: Card[], activeSeats: readonly Seat[], firstSeat: Seat): FinishedState {
  let state: GameState = createGame({ shuffledDeck: deck, activeSeats, firstSeat, baseStake: STAKE });
  for (let i = 0; i < MAX_TURNS && state.phase === "playing"; i++) {
    const { seat, target, rank } = scriptedAsk(state);
    const result = applyAction(state, seat, { type: "ask", target, rank });
    if (!result.ok) throw new Error(`replay rejected: ${result.reason}`);
    state = result.state;
  }
  if (state.phase !== "finished") throw new Error("replay did not finish");
  return state;
}

/** Ready-up every socket; resolves once the first seat is on turn in the dealt hand. */
async function readyUpAndReachPlaying(sockets: readonly FrameQueue[], firstSeat: Seat): Promise<void> {
  for (let i = 0; i < sockets.length; i++) {
    send(sockets[i], { type: "ready" });
    if (i < sockets.length - 1) {
      await sockets[i].nextFrameMatching((m) => asStateMessage(m)?.seats[i].ready === true);
    }
  }
  await sockets[firstSeat].nextFrameMatching((m) => playingView(m)?.currentTurn === firstSeat);
}

/**
 * Sends the greedy script over WebSockets in lockstep with the engine,
 * asserting every acting seat's next frame equals the replay's view, up to
 * the settled frame on socket 0. Returns the engine's finished state.
 */
async function playScriptedHandToFinish(
  sockets: readonly FrameQueue[],
  deck: Card[],
  activeSeats: readonly Seat[],
  firstSeat: Seat,
): Promise<GameState> {
  let state: GameState = createGame({ shuffledDeck: deck, activeSeats, firstSeat, baseStake: STAKE });
  for (let i = 0; i < MAX_TURNS && state.phase === "playing"; i++) {
    const { seat, target, rank } = scriptedAsk(state);
    send(sockets[seat], { type: "ask", target, rank });
    const result = applyAction(state, seat, { type: "ask", target, rank });
    if (!result.ok) throw new Error(`replay rejected: ${result.reason}`);
    state = result.state;
    const expectedView = JSON.stringify(viewFor(state, seat));
    await sockets[seat].nextFrameMatching((m) => {
      const s = asStateMessage(m);
      return s !== null && JSON.stringify(s.view) === expectedView;
    });
  }
  if (state.phase !== "finished") throw new Error("script did not finish the hand");
  // The DO settles before it broadcasts the finished state, so the settled
  // frame already sits behind the cursor; scan the whole queue for it.
  await waitUntil(async () => sockets[0].messages.some((m) => m.type === "settled"));
  return state;
}

// --- Tests --------------------------------------------------------------------

describe("PescaloTableDO — full scripted hand", () => {
  it("plays to completion over WebSockets and settles exact D1 balances exactly once", async () => {
    const tableId = `t-full-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("pfhost"), registerUser("pfp2")]);
    await initTable(tableId, users[0].cookie, STAKE);

    const stub = env.PESCALO_TABLE_DO.getByName(tableId);
    const deck = scriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstSeat: 0 });

    const before = await creditsOf(users);
    const sockets = await openSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets, 0);

    const dealt = playingView(sockets[0].messages.find((m) => playingView(m) !== null)!)!;
    expect(dealt.hand.map((c) => c.id)).toEqual(deck.slice(0, handSizeFor(2)).map((c) => c.id));
    expect(dealt.handCounts).toEqual({ 0: 7, 1: 7, 2: 0, 3: 0, 4: 0 });
    expect(dealt.poolCount).toBe(52 - 14);

    const finished = await playScriptedHandToFinish(sockets, deck, [0, 1], 0);
    if (finished.phase !== "finished") throw new Error("unreachable");
    const expected = settle(finished);
    expect(expected).toEqual(settle(replayScript(deck, [0, 1], 0)));
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);
    expect(finished.books[0].length + finished.books[1].length).toBe(13);

    const settledMsg = sockets[0].messages.find((m) => m.type === "settled") as SettledMessage | undefined;
    expect(settledMsg).toBeDefined();
    expect(settledMsg!.round).toBe(1);
    expect(settledMsg!.deltas).toEqual(expected);

    const after = await creditsOf(users);
    for (let i = 0; i < users.length; i++) {
      expect(after[i]).toBe(before[i] + expected[i as Seat]);
    }

    const ledger = await ledgerRowsForRound(tableId, 1);
    // 13 books over two seats never tie, so both seats carry a non-zero delta.
    expect(ledger.results).toHaveLength(2);
    for (let i = 0; i < users.length; i++) {
      const row = ledger.results!.find((r) => r.userId === users[i].id);
      expect(row!.amount).toBe(expected[i as Seat]);
      expect(row!.idempotencyKey).toBe(`settle:${tableId}:1:${users[i].id}`);
    }

    const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(`${tableId}:1`)
      .first<{ table_id: string; round: number; game_id: string; stake: number; result_json: string }>();
    expect(gameRow?.game_id).toBe("pescalo");
    expect(gameRow?.stake).toBe(STAKE);
    expect(JSON.parse(gameRow!.result_json).winners).toEqual(finished.winners);

    const finishedFrame = asStateMessage(await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.view?.phase === "finished"))!;
    if (finishedFrame.view?.phase !== "finished") throw new Error("unreachable");
    expect(finishedFrame.view.winners).toEqual(finished.winners);
    expect(finishedFrame.view.books).toEqual(finished.books);

    for (const s of sockets) s.ws.close();
  });
});

describe("PescaloTableDO — rejected asks", () => {
  it("relays engine rejections as error frames without changing state", async () => {
    const tableId = `t-reject-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("prjh"), registerUser("prj2")]);
    await initTable(tableId, host.cookie, STAKE);
    const deck = scriptedDeck();
    await env.PESCALO_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: deck, firstSeat: 0 });

    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    await readyUpAndReachPlaying([s0, s1], 0);
    const dealt = playingView(s0.messages.find((m) => playingView(m) !== null)!)!;
    const held = dealt.hand[0].rank;
    const notHeld = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].find((r) => !dealt.hand.some((c) => c.rank === r))!;

    send(s1, { type: "ask", target: 0, rank: held });
    await s1.nextFrameMatching((m) => m.type === "error" && m.code === "not-your-turn");
    send(s0, { type: "ask", target: 0, rank: held });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "invalid-target");
    send(s0, { type: "ask", target: 3, rank: held });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "invalid-target");
    send(s0, { type: "ask", target: 1, rank: notHeld });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "rank-not-in-hand");
    send(s0, { type: "ask", target: 1, rank: 99 });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "invalid-rank");
    send(s0, { type: "ask", target: "1", rank: held });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "bad-message");

    send(s0, { type: "ask", target: 1, rank: held });
    const next = await s0.nextFrameMatching((m) => playingView(m)?.lastEvents.length! > 0);
    expect(playingView(next)!.lastEvents[0]).toEqual({ type: "asked", seat: 0, target: 1, rank: held });

    s0.ws.close();
    s1.ws.close();
  });
});

describe("PescaloTableDO — reconnection", () => {
  it("re-seats a reconnecting user by userId and lets play continue", async () => {
    const tableId = `t-reconnect-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("prh"), registerUser("pr2"), registerUser("pr3")]);
    await initTable(tableId, users[0].cookie, STAKE);
    const deck = scriptedDeck();
    await env.PESCALO_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: deck, firstSeat: 1 });

    const s0 = await openTableSocket(tableId, users[0].cookie);
    let s1 = await openTableSocket(tableId, users[1].cookie);
    const s2 = await openTableSocket(tableId, users[2].cookie);
    await readyUpAndReachPlaying([s0, s1, s2], 1);

    s1.ws.close(1000, "test disconnect");
    await s0.nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    s1 = await openTableSocket(tableId, users[1].cookie);
    const reconnectState = asStateMessage(await s1.nextFrameMatching((m) => m.type === "state"))!;
    expect(reconnectState.view?.viewer).toBe(1);
    expect(reconnectState.seats[1].connected).toBe(true);
    expect(reconnectState.seats[1].userId).toBe(users[1].id);
    if (reconnectState.view?.phase !== "playing") throw new Error("unreachable");
    expect(reconnectState.view.hand).toHaveLength(handSizeFor(3));
    expect(reconnectState.view.currentTurn).toBe(1);

    const rank = reconnectState.view.hand[0].rank;
    send(s1, { type: "ask", target: 2, rank });
    await s2.nextFrameMatching((m) => playingView(m)?.lastEvents[0]?.type === "asked");

    for (const s of [s0, s1, s2]) s.ws.close();
  });
});

describe("PescaloTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const tableId = `t-once-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("poh"), registerUser("po2")]);
    await initTable(tableId, users[0].cookie, STAKE);
    const stub = env.PESCALO_TABLE_DO.getByName(tableId);
    const deck = scriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstSeat: 0 });

    const sockets = await openSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets, 0);
    await playScriptedHandToFinish(sockets, deck, [0, 1], 0);
    for (const s of sockets) s.ws.close();

    const afterFirst = await creditsOf(users);
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(2);

    await runInDurableObject(stub, async (_instance, doState) => {
      doState.storage.sql.exec("UPDATE game_state SET settled = 0 WHERE id = 1");
    });
    await expect(stub.forceSettle()).resolves.toBeUndefined();

    expect(await creditsOf(users)).toEqual(afterFirst);
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(2);
  });
});

describe("PescaloTableDO — redaction", () => {
  it("never sends a seat another seat's cards, and never names a hidden draw", async () => {
    const tableId = `t-redact-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("pdh"), registerUser("pd2")]);
    await initTable(tableId, users[0].cookie, STAKE);
    const deck = scriptedDeck();
    await env.PESCALO_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: deck, firstSeat: 0 });

    const sockets = await openSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets, 0);
    await playScriptedHandToFinish(sockets, deck, [0, 1], 0);

    let hiddenDraws = 0;
    for (let seat = 0; seat < sockets.length; seat++) {
      for (const msg of sockets[seat].messages) {
        const view = playingView(msg);
        if (!view) continue;
        expect(view.viewer).toBe(seat);
        const text = JSON.stringify(msg);
        expect(text).not.toContain('"hands"');
        expect(text).not.toContain('"pool"');
        for (const event of view.lastEvents) {
          if (event.type === "drew-hidden") {
            hiddenDraws++;
            expect("card" in event).toBe(false);
            expect("rank" in event).toBe(false);
          }
        }
      }
    }
    expect(hiddenDraws).toBeGreaterThan(0);

    for (const s of sockets) s.ws.close();
  });
});

describe("PescaloTableDO — deliberate leave aborts the hand", () => {
  it("ends the game for everyone immediately: no settlement, no ledger rows, cleared lobby membership", async () => {
    const users = await Promise.all([registerUser("plh"), registerUser("pl2"), registerUser("pl3")]);

    // Variable-seat quick play: the first call creates a public table, later calls join it.
    const first = await quickPlay(users[0].cookie);
    const { tableId } = await first.json<{ tableId: string }>();
    for (const u of users.slice(1)) {
      const res = await quickPlay(u.cookie);
      expect((await res.json<{ tableId: string }>()).tableId).toBe(tableId);
    }

    await env.PESCALO_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: scriptedDeck(), firstSeat: 0 });
    const sockets = await openSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets, 0);
    const before = await creditsOf(users);

    send(sockets[0], { type: "leave" });

    const abortedFrames = await Promise.all(sockets.map((s) => s.nextFrameMatching((m) => m.type === "aborted")));
    for (const msg of abortedFrames) {
      expect(msg).toMatchObject({ type: "aborted", leaver: { seat: 0, username: users[0].username } });
    }
    const finalStates = await Promise.all(sockets.map((s) => s.nextFrameMatching((m) => asStateMessage(m) !== null)));
    for (const m of finalStates) expect(asStateMessage(m)!.view).toBeNull();

    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(0);
    expect(await creditsOf(users)).toEqual(before);

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    await waitUntil(async () => !(await lobbyStub.isMember(users[0].id)));
    for (const u of users) {
      expect(await lobbyStub.isMember(u.id)).toBe(false);
      expect(await isUserInLiveGame(env, u.id)).toBe(false);
    }

    for (const s of sockets) s.ws.close();
  });
});

describe("PescaloTableDO — 3-player hand with a bystander", () => {
  it("deals 5 each, seats a mid-hand joiner as a bystander, and settles only the active seats", async () => {
    const tableId = `t-trio-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("pth"), registerUser("pt2"), registerUser("pt3"), registerUser("pt4")]);
    await initTable(tableId, users[0].cookie, STAKE);
    const deck = scriptedDeck();
    await env.PESCALO_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: deck, firstSeat: 2 });

    const players = users.slice(0, 3);
    const before = await creditsOf(players);
    const sockets = await openSockets(
      tableId,
      players.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets, 2);
    const dealt = playingView(sockets[2].messages.find((m) => playingView(m) !== null)!)!;
    expect(dealt.activeSeats).toEqual([0, 1, 2]);
    expect(dealt.handCounts).toEqual({ 0: 5, 1: 5, 2: 5, 3: 0, 4: 0 });

    const s3 = await openTableSocket(tableId, users[3].cookie);
    const bystanderState = asStateMessage(await s3.nextFrameMatching((m) => asStateMessage(m)?.seats[3].userId === users[3].id))!;
    if (bystanderState.view?.phase !== "playing") throw new Error("unreachable");
    expect(bystanderState.view.activeSeats).toEqual([0, 1, 2]);
    expect(bystanderState.view.hand).toEqual([]);
    send(s3, { type: "ready" });
    await s3.nextFrameMatching((m) => m.type === "error" && m.code === "game-in-progress");

    const finished = await playScriptedHandToFinish(sockets, deck, [0, 1, 2], 2);
    if (finished.phase !== "finished") throw new Error("unreachable");
    const expected = settle(finished);
    const settledMsg = sockets[0].messages.find((m) => m.type === "settled") as SettledMessage;
    expect(settledMsg.deltas).toEqual(expected);
    expect(expected[3]).toBe(0);
    expect(expected[4]).toBe(0);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);

    const after = await creditsOf(players);
    for (let i = 0; i < players.length; i++) expect(after[i]).toBe(before[i] + expected[i as Seat]);
    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results!.length).toBe(([0, 1, 2] as const).filter((s) => expected[s] !== 0).length);

    for (const s of [...sockets, s3]) s.ws.close();
  });
});

describe("PescaloTableDO — seat broadcasts carry card skins", () => {
  it("sends each occupant's equipped skin, classic for NULL and empty seats", async () => {
    const tableId = `t-skin-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("skhost"), registerUser("skp2")]);
    await env.DB.prepare("UPDATE users SET card_skin = 'nebula' WHERE id = ?").bind(host.id).run();
    await initTable(tableId, host.cookie, STAKE);

    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    const state = (await s0.nextFrameMatching((m) => m.type === "state" && m.seats[1].userId !== null)) as StateMessage;
    expect(state.seats[0].cardSkin).toBe("nebula");
    expect(state.seats[1].cardSkin).toBe("classic");
    expect(state.seats[2].cardSkin).toBe("classic");

    s0.ws.close();
    s1.ws.close();
  });
});

describe("PescaloTableDO — emotes", () => {
  it("relays a spent emote to every seat, then refuses a second send", async () => {
    const tableId = `t-emote-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("emhost"), registerUser("emp2")]);
    await env.DB.prepare("INSERT INTO user_emotes (user_id, emote_id, qty) VALUES (?, 'tomato', 1)").bind(host.id).run();
    await initTable(tableId, host.cookie, STAKE);

    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    await s0.nextFrameMatching((m) => m.type === "state" && m.seats[1].userId !== null);

    send(s0, { type: "emote", emoteId: "tomato", target: 1 });
    const expected = { type: "emote", from: 0, to: 1, emoteId: "tomato" };
    expect(await s0.nextFrameMatching((m) => m.type === "emote")).toEqual(expected);
    expect(await s1.nextFrameMatching((m) => m.type === "emote")).toEqual(expected);
    const row = await env.DB.prepare("SELECT qty FROM user_emotes WHERE user_id = ? AND emote_id = 'tomato'")
      .bind(host.id)
      .first<{ qty: number }>();
    expect(row?.qty).toBe(0);

    send(s0, { type: "emote", emoteId: "tomato", target: 1 });
    const err = await s0.nextFrameMatching((m) => m.type === "error");
    expect(["emote-empty", "emote-cooldown"]).toContain((err as { code: string }).code);

    s0.ws.close();
    s1.ws.close();
  });
});
