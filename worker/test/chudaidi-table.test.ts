import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  applyAction,
  createDeck,
  createGame,
  settle,
  type Action,
  type Card,
  type GameState,
  type Seat,
} from "chudaidi";
import { describe, expect, it } from "vitest";
import { lobbyDoName } from "../src/durable-objects/lobby";
import type { ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/chudaidi-protocol";
import { isUserInLiveGame } from "../src/game/live-check";

const STAKE = 10;
const GAME_ID = "chudaidi";

// --- User / table setup helpers, mirroring test/liarsbar-table.test.ts ---

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

function send(socket: FrameQueue, msg: Record<string, unknown>): void {
  socket.ws.send(JSON.stringify(msg));
}

// --- Frame queue (same forward-scanning cursor as the other DO tests) ---

interface FrameQueue {
  readonly ws: WebSocket;
  readonly messages: readonly ServerMessage[];
  readonly raw: readonly string[];
  nextFrameMatching(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
}

function attachFrameQueue(ws: WebSocket): FrameQueue {
  const messages: ServerMessage[] = [];
  const raw: string[] = [];
  let cursor = 0;
  let pending: {
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  ws.addEventListener("message", (event: MessageEvent) => {
    const text = event.data as string;
    raw.push(text);
    const msg = JSON.parse(text) as ServerMessage;
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
    raw,
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

// --- Scripted deck ------------------------------------------------------------
//
// Seat 0's block holds 4D (the lowest card, so seat 0 leads) and sheds all 13
// cards in three plays while every other seat passes: a 3-4-5-6-7 straight
// flush (the top of the ladder), an 8-Q straight flush, then triple kings. The other blocks are filler in
// deck order; their content never matters beyond "13 cards to pay for".
const SEAT0_IDS = ["3D", "4D", "5D", "6D", "7D", "8D", "9D", "10D", "JD", "QD", "KS", "KH", "KD"];
const SEAT0_PLAYS: readonly (readonly string[])[] = [
  ["3D", "4D", "5D", "6D", "7D"],
  ["8D", "9D", "10D", "JD", "QD"],
  ["KS", "KH", "KD"],
];

function buildScriptedDeck(): Card[] {
  const full = createDeck();
  const byId = new Map(full.map((c) => [c.id, c]));
  const seat0 = SEAT0_IDS.map((id) => byId.get(id)!);
  const rest = full.filter((c) => !SEAT0_IDS.includes(c.id));
  return [...seat0, ...rest];
}

function blockFor(deck: readonly Card[], seat: Seat): Set<string> {
  return new Set(deck.slice(seat * 13, seat * 13 + 13).map((c) => c.id));
}

/** Replays the script through the pure engine so the expected deltas are independent of the DO. */
function replayScriptedGameForExpectedDeltas(deck: Card[], activeSeats: readonly Seat[]): Readonly<Record<Seat, number>> {
  function applyOrThrow(state: GameState, seat: Seat, action: Action): GameState {
    const result = applyAction(state, seat, action);
    if (!result.ok) throw new Error(`unexpected rejection in replay: ${result.reason}`);
    return result.state;
  }
  let state: GameState = createGame({ shuffledDeck: deck, activeSeats, baseStake: STAKE });
  const others = activeSeats.filter((s) => s !== 0);
  for (const cardIds of SEAT0_PLAYS) {
    state = applyOrThrow(state, 0, { type: "play", cardIds });
    if (state.phase === "finished") break;
    for (const seat of others) state = applyOrThrow(state, seat, { type: "pass" });
  }
  if (state.phase !== "finished") throw new Error("expected replay to reach a finished state");
  return settle(state);
}

/** Ready-up every socket; resolves once seat 0 is on lead in the dealt hand. */
async function readyUpAndReachPlaying(sockets: readonly FrameQueue[]): Promise<void> {
  for (let i = 0; i < sockets.length; i++) {
    send(sockets[i], { type: "ready" });
    if (i < sockets.length - 1) {
      await sockets[i].nextFrameMatching((m) => asStateMessage(m)?.seats[i].ready === true);
    }
  }
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0);
}

/** Seat 0 sheds its hand while everyone else passes, up to the settled frame on socket 0. */
async function playScriptedHandToFinish(sockets: readonly FrameQueue[]): Promise<void> {
  for (const cardIds of SEAT0_PLAYS) {
    send(sockets[0], { type: "play", cardIds });
    if (cardIds === SEAT0_PLAYS[SEAT0_PLAYS.length - 1]) break;
    for (let i = 1; i < sockets.length; i++) {
      await sockets[i].nextFrameMatching((m) => playingView(m)?.currentTurn === i);
      send(sockets[i], { type: "pass" });
    }
    await sockets[0].nextFrameMatching((m) => {
      const view = playingView(m);
      return view?.currentTurn === 0 && view.lastPlay === null;
    });
  }
  await sockets[0].nextFrameMatching((m) => m.type === "settled");
}

async function openFourSockets(tableId: string, cookies: readonly string[]): Promise<FrameQueue[]> {
  // Sequential connects pin seat i to cookies[i].
  const sockets: FrameQueue[] = [];
  for (const cookie of cookies) sockets.push(await openTableSocket(tableId, cookie));
  return sockets;
}

// --- Tests --------------------------------------------------------------------

describe("ChuDaiDTableDO — full scripted hand", () => {
  it("plays to completion over WebSockets and settles exact D1 balances exactly once", async () => {
    const tableId = `t-full-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([
      registerUser("cdhost"),
      registerUser("cdp2"),
      registerUser("cdp3"),
      registerUser("cdp4"),
    ]);
    await initTable(tableId, users[0].cookie, STAKE);

    const stub = env.CHUDAIDI_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck });

    const before = await creditsOf(users);
    const sockets = await openFourSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets);

    // The dealt view carries the lead-card rule and the right hand.
    const dealt = playingView(sockets[0].messages.find((m) => playingView(m) !== null)!)!;
    expect(dealt.leadCardId).toBe("4D");
    expect(dealt.hand.map((c) => c.id)).toEqual(SEAT0_IDS);
    expect(dealt.handCounts).toEqual({ 0: 13, 1: 13, 2: 13, 3: 13 });

    await playScriptedHandToFinish(sockets);

    const settledMsg = sockets[0].messages.find((m) => m.type === "settled") as SettledMessage | undefined;
    expect(settledMsg).toBeDefined();
    expect(settledMsg!.round).toBe(1);

    const expected = replayScriptedGameForExpectedDeltas(deck, [0, 1, 2, 3]);
    expect(settledMsg!.deltas).toEqual(expected);
    expect(expected[0]).toBe(3 * 13 * 3 * STAKE);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);

    const after = await creditsOf(users);
    for (let i = 0; i < users.length; i++) {
      expect(after[i]).toBe(before[i] + expected[i as Seat]);
    }

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(4);
    for (let i = 0; i < users.length; i++) {
      const row = ledger.results!.find((r) => r.userId === users[i].id);
      expect(row).toBeDefined();
      expect(row!.amount).toBe(expected[i as Seat]);
      expect(row!.idempotencyKey).toBe(`settle:${tableId}:1:${users[i].id}`);
    }

    const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(`${tableId}:1`)
      .first<{ table_id: string; round: number; game_id: string; stake: number }>();
    expect(gameRow?.table_id).toBe(tableId);
    expect(gameRow?.round).toBe(1);
    expect(gameRow?.game_id).toBe("chudaidi");
    expect(gameRow?.stake).toBe(STAKE);

    // The finished view reveals every hand, and the settled state refreshes credits.
    const finishedFrame = asStateMessage(await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.view?.phase === "finished"))!;
    if (finishedFrame.view?.phase !== "finished") throw new Error("unreachable");
    expect(finishedFrame.view.winner).toBe(0);
    expect(finishedFrame.view.hands[0]).toEqual([]);
    expect(finishedFrame.view.hands[2]).toHaveLength(13);

    for (const s of sockets) s.ws.close();
  });
});

describe("ChuDaiDTableDO — rejected plays", () => {
  it("relays engine rejections as error frames without changing state", async () => {
    const tableId = `t-reject-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("cdrjh"), registerUser("cdrj2")]);
    await initTable(tableId, host.cookie, STAKE);
    await env.CHUDAIDI_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: buildScriptedDeck() });

    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    await readyUpAndReachPlaying([s0, s1]);

    send(s1, { type: "pass" });
    await s1.nextFrameMatching((m) => m.type === "error" && m.code === "not-your-turn");
    send(s0, { type: "pass" });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "cannot-pass-on-lead");
    send(s0, { type: "play", cardIds: ["3D"] });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "must-include-lead-card");
    send(s0, { type: "play", cardIds: "4D" });
    await s0.nextFrameMatching((m) => m.type === "error" && m.code === "bad-message");

    send(s0, { type: "play", cardIds: ["4D"] });
    const next = playingView(await s1.nextFrameMatching((m) => playingView(m)?.currentTurn === 1))!;
    expect(next.lastPlay?.combo.category).toBe("single");
    expect(next.handCounts[0]).toBe(12);

    s0.ws.close();
    s1.ws.close();
  });
});

describe("ChuDaiDTableDO — reconnection", () => {
  it("re-seats a reconnecting user by userId and lets play continue", async () => {
    const tableId = `t-reconnect-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("cdrh"), registerUser("cdr2"), registerUser("cdr3")]);
    await initTable(tableId, users[0].cookie, STAKE);
    await env.CHUDAIDI_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: buildScriptedDeck() });

    const s0 = await openTableSocket(tableId, users[0].cookie);
    let s1 = await openTableSocket(tableId, users[1].cookie);
    const s2 = await openTableSocket(tableId, users[2].cookie);
    await readyUpAndReachPlaying([s0, s1, s2]);

    send(s0, { type: "play", cardIds: SEAT0_PLAYS[0] });
    await s1.nextFrameMatching((m) => playingView(m)?.currentTurn === 1);

    s1.ws.close(1000, "test disconnect");
    await s0.nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    s1 = await openTableSocket(tableId, users[1].cookie);
    const reconnectState = asStateMessage(await s1.nextFrameMatching((m) => m.type === "state"))!;
    expect(reconnectState.view?.viewer).toBe(1);
    expect(reconnectState.seats[1].connected).toBe(true);
    expect(reconnectState.seats[1].userId).toBe(users[1].id);
    if (reconnectState.view?.phase !== "playing") throw new Error("unreachable");
    expect(reconnectState.view.hand).toHaveLength(13);
    expect(reconnectState.view.currentTurn).toBe(1);

    send(s1, { type: "pass" });
    await s2.nextFrameMatching((m) => playingView(m)?.currentTurn === 2);

    for (const s of [s0, s1, s2]) s.ws.close();
  });
});

describe("ChuDaiDTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const tableId = `t-once-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("cdoh"), registerUser("cdo2"), registerUser("cdo3"), registerUser("cdo4")]);
    await initTable(tableId, users[0].cookie, STAKE);
    const stub = env.CHUDAIDI_TABLE_DO.getByName(tableId);
    await stub.setTestFixedDeal({ shuffledDeck: buildScriptedDeck() });

    const sockets = await openFourSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets);
    await playScriptedHandToFinish(sockets);
    for (const s of sockets) s.ws.close();

    const afterFirst = await creditsOf(users);
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(4);

    await runInDurableObject(stub, async (_instance, doState) => {
      doState.storage.sql.exec("UPDATE game_state SET settled = 0 WHERE id = 1");
    });
    await expect(stub.forceSettle()).resolves.toBeUndefined();

    expect(await creditsOf(users)).toEqual(afterFirst);
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(4);
  });
});

describe("ChuDaiDTableDO — redaction", () => {
  it("never sends a seat another seat's hand while the hand is in play", async () => {
    const tableId = `t-redact-${crypto.randomUUID().slice(0, 8)}`;
    const users = await Promise.all([registerUser("cddh"), registerUser("cdd2"), registerUser("cdd3"), registerUser("cdd4")]);
    await initTable(tableId, users[0].cookie, STAKE);
    const deck = buildScriptedDeck();
    await env.CHUDAIDI_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: deck });

    const sockets = await openFourSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets);
    await playScriptedHandToFinish(sockets);

    for (let seat = 0; seat < sockets.length; seat++) {
      const own = blockFor(deck, seat as Seat);
      for (const msg of sockets[seat].messages) {
        const view = playingView(msg);
        if (!view) continue;
        expect(view.viewer).toBe(seat);
        for (const card of view.hand) expect(own.has(card.id)).toBe(true);
        // Raw playing frames carry no `hands` map, only the viewer's own `hand`.
        expect(JSON.stringify(msg)).not.toContain('"hands"');
      }
    }

    for (const s of sockets) s.ws.close();
  });
});

describe("ChuDaiDTableDO — deliberate leave aborts the hand", () => {
  it("ends the game for everyone immediately: no settlement, no ledger rows, cleared lobby membership", async () => {
    const users = await Promise.all([registerUser("cdlh"), registerUser("cdl2"), registerUser("cdl3")]);

    // Variable-seat quick play: the first call creates a public table, later calls join it.
    const first = await quickPlay(users[0].cookie);
    const { tableId } = await first.json<{ tableId: string }>();
    for (const u of users.slice(1)) {
      const res = await quickPlay(u.cookie);
      expect((await res.json<{ tableId: string }>()).tableId).toBe(tableId);
    }

    await env.CHUDAIDI_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: buildScriptedDeck() });
    const sockets = await openFourSockets(
      tableId,
      users.map((u) => u.cookie),
    );
    await readyUpAndReachPlaying(sockets);
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

describe("ChuDaiDTableDO — 2-player hand (minSeats)", () => {
  it("starts with two ready players, seats a mid-hand joiner as a bystander, and settles only the two active seats", async () => {
    const tableId = `t-duo-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([registerUser("cduoh"), registerUser("cduo2"), registerUser("cduo3")]);
    await initTable(tableId, host.cookie, STAKE);
    const deck = buildScriptedDeck();
    await env.CHUDAIDI_TABLE_DO.getByName(tableId).setTestFixedDeal({ shuffledDeck: deck });

    const before = await creditsOf([host, p2]);
    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    await readyUpAndReachPlaying([s0, s1]);
    const dealt = playingView(s0.messages.find((m) => playingView(m) !== null)!)!;
    expect(dealt.activeSeats).toEqual([0, 1]);
    expect(dealt.handCounts).toEqual({ 0: 13, 1: 13, 2: 0, 3: 0 });

    const s2 = await openTableSocket(tableId, p3.cookie);
    const bystanderState = asStateMessage(await s2.nextFrameMatching((m) => asStateMessage(m)?.seats[2].userId === p3.id))!;
    if (bystanderState.view?.phase !== "playing") throw new Error("unreachable");
    expect(bystanderState.view.activeSeats).toEqual([0, 1]);
    expect(bystanderState.view.hand).toEqual([]);
    send(s2, { type: "ready" });
    await s2.nextFrameMatching((m) => m.type === "error" && m.code === "game-in-progress");

    await playScriptedHandToFinish([s0, s1]);
    const settledMsg = s0.messages.find((m) => m.type === "settled") as SettledMessage;
    const expected = replayScriptedGameForExpectedDeltas(deck, [0, 1]);
    expect(settledMsg.deltas).toEqual(expected);
    expect(expected).toEqual({ 0: 13 * 3 * STAKE, 1: -13 * 3 * STAKE, 2: 0, 3: 0 });
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(2);

    const after = await creditsOf([host, p2]);
    expect(after[0]).toBe(before[0] + expected[0]);
    expect(after[1]).toBe(before[1] + expected[1]);

    for (const s of [s0, s1, s2]) s.ws.close();
  });
});

describe("ChuDaiDTableDO — seat broadcasts carry card skins", () => {
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

describe("ChuDaiDTableDO — emotes", () => {
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
