import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  applyAction,
  createDeck,
  createGame,
  settle,
  type Action,
  type Card,
  type GameState,
  type RedactedPlayingView,
  type Seat,
} from "uno";
import { describe, expect, it } from "vitest";
import { lobbyDoName } from "../src/durable-objects/lobby";
import type { ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/uno-protocol";
import { isUserInLiveGame } from "../src/game/live-check";

const STAKE = 100;
const GAME_ID = "uno";

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

/** Variable-seat quick play: the first caller creates a public table, later callers join it. */
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

// --- Frame queue (see game-table.test.ts for the cursor rationale) ---

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

function playingView(m: ServerMessage): RedactedPlayingView | null {
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
// Two seats. createGame deals 7-card blocks in seat order, flips the next
// card (a red 5), and the rest is the draw pile top-first. Seat 0 holds a
// red 1 and six red action cards: in a 2-player game every skip, reverse,
// and draw-two hands the turn straight back, so seat 0 runs out its whole
// hand while seat 1 only ever draws. Seat 1's draws: g9a (unplayable on a
// red 1), then y1a/y1b and g1a/g1b from the two draw-twos.
const SEAT0_IDS = ["r1a", "rSa", "rSb", "rRa", "rRb", "rDa", "rDb"];
const SEAT1_IDS = ["b1a", "b2a", "b3a", "b4a", "b6a", "b7a", "b8a"];
const FLIP_IDS = ["r5a"];
const DRAW_IDS = ["g9a", "y1a", "y1b", "g1a", "g1b"];
const TEST_FIRST_SEAT: Seat = 0;
/** Seat 1's final hand: 31 points of blues, a green 9, and four 1s. */
const EXPECTED_LOSER_POINTS = 31 + 9 + 4;

function buildScriptedDeck(): Card[] {
  const full = createDeck();
  const byId = new Map(full.map((c) => [c.id, c]));
  const scripted = [...SEAT0_IDS, ...SEAT1_IDS, ...FLIP_IDS, ...DRAW_IDS];
  const used = new Set(scripted);
  const order = [...scripted, ...full.map((c) => c.id).filter((id) => !used.has(id))];
  return order.map((id) => byId.get(id)!);
}

/** The same script through the pure engine, so the DO's settlement is checked against an independent replay. */
function replayScriptedGameForExpectedDeltas(deck: Card[]): Readonly<Record<Seat, number>> {
  const noReshuffle = () => {
    throw new Error("unexpected reshuffle in replay");
  };
  function applyOrThrow(state: GameState, seat: Seat, action: Action): GameState {
    const result = applyAction(state, seat, action, noReshuffle);
    if (!result.ok) throw new Error(`unexpected rejection in replay: ${result.reason}`);
    return result.state;
  }
  let state: GameState = createGame({ shuffledDeck: deck, activeSeats: [0, 1], firstSeat: TEST_FIRST_SEAT, baseStake: STAKE });
  state = applyOrThrow(state, 0, { type: "play", cardId: "r1a" });
  state = applyOrThrow(state, 1, { type: "draw" });
  for (const id of ["rSa", "rSb", "rRa", "rRb", "rDa", "rDb"]) {
    state = applyOrThrow(state, 0, { type: "play", cardId: id });
  }
  if (state.phase !== "finished") throw new Error("expected replay to reach a finished state");
  expect(state.points[1]).toBe(EXPECTED_LOSER_POINTS);
  return settle(state);
}

async function readyUpAndReachPlaying(sockets: readonly [FrameQueue, FrameQueue]): Promise<void> {
  send(sockets[0], { type: "ready" });
  await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[0].ready === true);
  send(sockets[1], { type: "ready" });
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0);
}

async function playScriptedGameToFinish(
  tableId: string,
  cookies: readonly [string, string],
): Promise<[FrameQueue, FrameQueue]> {
  // Connect sequentially so seat 0/1 pin to cookies[0]/[1].
  const sockets: [FrameQueue, FrameQueue] = [
    await openTableSocket(tableId, cookies[0]),
    await openTableSocket(tableId, cookies[1]),
  ];
  await readyUpAndReachPlaying(sockets);

  send(sockets[0], { type: "play", cardId: "r1a" });
  await sockets[1].nextFrameMatching((m) => playingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "draw" });
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0 && playingView(m)?.handCounts[1] === 8);
  for (const id of ["rSa", "rSb", "rRa", "rRb", "rDa"]) {
    send(sockets[0], { type: "play", cardId: id });
    await sockets[0].nextFrameMatching((m) => playingView(m)?.topCard.id === id);
  }
  send(sockets[0], { type: "play", cardId: "rDb" });
  await sockets[0].nextFrameMatching((m) => m.type === "settled");
  return sockets;
}

async function setUpScriptedTable(prefix: string) {
  const tableId = `t-${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const [host, p2] = await Promise.all([registerUser(`${prefix}h`), registerUser(`${prefix}p`)]);
  await initTable(tableId, host.cookie, STAKE);
  const stub = env.UNO_TABLE_DO.getByName(tableId);
  const deck = buildScriptedDeck();
  await stub.setTestFixedDeal({ shuffledDeck: deck, firstSeat: TEST_FIRST_SEAT });
  return { tableId, host, p2, stub, deck };
}

// --- Tests --------------------------------------------------------------------

describe("UnoTableDO — full scripted game", () => {
  it("plays to completion over WebSockets and settles exact D1 balances exactly once", async () => {
    const { tableId, host, p2, deck } = await setUpScriptedTable("unofull");
    const users = [host, p2] as const;
    const before = await creditsOf(users);

    const sockets = await playScriptedGameToFinish(tableId, [host.cookie, p2.cookie]);

    const settledMsg = sockets[0].messages.find((m) => m.type === "settled") as SettledMessage | undefined;
    expect(settledMsg).toBeDefined();
    expect(settledMsg!.round).toBe(1);

    const expected = replayScriptedGameForExpectedDeltas(deck);
    expect(settledMsg!.deltas).toEqual(expected);
    expect(expected[0]).toBe(Math.round((EXPECTED_LOSER_POINTS * STAKE) / 10));
    expect(expected[1]).toBe(-expected[0]);

    // The finished view exposes both hands and the loser's points.
    const finalState = asStateMessage(
      await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.view?.phase === "finished"),
    )!;
    if (finalState.view?.phase !== "finished") throw new Error("unreachable");
    expect(finalState.view.winner).toBe(0);
    expect(finalState.view.points[1]).toBe(EXPECTED_LOSER_POINTS);
    expect(finalState.view.hands[1]).toHaveLength(12);

    const after = await creditsOf(users);
    expect(after[0]).toBe(before[0] + expected[0]);
    expect(after[1]).toBe(before[1] + expected[1]);

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(2);
    for (let i = 0; i < users.length; i++) {
      const row = ledger.results!.find((r) => r.userId === users[i].id);
      expect(row?.amount).toBe(expected[i as Seat]);
      expect(row?.idempotencyKey).toBe(`settle:${tableId}:1:${users[i].id}`);
    }

    const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(`${tableId}:1`)
      .first<{ table_id: string; round: number; game_id: string; stake: number }>();
    expect(gameRow?.game_id).toBe("uno");
    expect(gameRow?.round).toBe(1);
    expect(gameRow?.stake).toBe(STAKE);

    // The post-settlement state broadcast carries refreshed seat credits.
    const afterSettle = asStateMessage(await sockets[0].nextFrameMatching((m) => asStateMessage(m) !== null))!;
    expect(afterSettle.seats[0].credits).toBe(after[0]);
    expect(afterSettle.seats[1].credits).toBe(after[1]);

    for (const s of sockets) s.ws.close();
  });
});

/** Seat 0 sheds down to its last card (rDb) with seat 1 unable to act. */
async function playUntilSeat0HoldsOneCard(
  tableId: string,
  cookies: readonly [string, string],
  lastPlay: Record<string, unknown>,
): Promise<[FrameQueue, FrameQueue]> {
  const sockets: [FrameQueue, FrameQueue] = [
    await openTableSocket(tableId, cookies[0]),
    await openTableSocket(tableId, cookies[1]),
  ];
  await readyUpAndReachPlaying(sockets);
  send(sockets[0], { type: "play", cardId: "r1a" });
  await sockets[1].nextFrameMatching((m) => playingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "draw" });
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0 && playingView(m)?.handCounts[1] === 8);
  for (const id of ["rSa", "rSb", "rRa", "rRb"]) {
    send(sockets[0], { type: "play", cardId: id });
    await sockets[0].nextFrameMatching((m) => playingView(m)?.topCard.id === id);
  }
  send(sockets[0], { type: "play", cardId: "rDa", ...lastPlay });
  await sockets[1].nextFrameMatching((m) => playingView(m)?.handCounts[0] === 1);
  return sockets;
}

describe("UnoTableDO — call UNO and catch", () => {
  it("a catch over the socket makes the silent seat draw two and closes the window", async () => {
    const { tableId, host, p2 } = await setUpScriptedTable("uct");
    const sockets = await playUntilSeat0HoldsOneCard(tableId, [host.cookie, p2.cookie], {});

    const vulnerable = playingView(sockets[1].messages[sockets[1].messages.length - 1])!;
    expect(vulnerable.unoVulnerable).toBe(0);
    expect(vulnerable.unoCalled).toEqual([]);

    send(sockets[1], { type: "catchUno", target: 0 });
    const caught = playingView(await sockets[0].nextFrameMatching((m) => playingView(m)?.handCounts[0] === 3))!;
    expect(caught.unoVulnerable).toBeNull();
    expect(caught.hand.map((c) => c.id)).toEqual(["rDb", "g1a", "g1b"]);
    expect(caught.lastEvents).toEqual([
      { type: "caught", seat: 0, by: 1 },
      { type: "drew", seat: 0, count: 2 },
    ]);

    send(sockets[1], { type: "catchUno", target: 0 });
    const err = await sockets[1].nextFrameMatching((m) => m.type === "error");
    expect(err).toMatchObject({ type: "error", code: "nothing-to-catch" });

    for (const s of sockets) s.ws.close();
  });

  it("calling UNO with the play shows the badge and leaves nothing to catch", async () => {
    const { tableId, host, p2 } = await setUpScriptedTable("ucl");
    const sockets = await playUntilSeat0HoldsOneCard(tableId, [host.cookie, p2.cookie], { uno: true });

    const called = playingView(sockets[1].messages[sockets[1].messages.length - 1])!;
    expect(called.unoVulnerable).toBeNull();
    expect(called.unoCalled).toEqual([0]);
    expect(called.lastEvents.map((e) => e.type)).toEqual(["played", "called-uno", "drew", "skipped"]);

    send(sockets[1], { type: "catchUno", target: 0 });
    const err = await sockets[1].nextFrameMatching((m) => m.type === "error");
    expect(err).toMatchObject({ type: "error", code: "nothing-to-catch" });

    // A bystander-style malformed target is refused before the engine.
    send(sockets[1], { type: "catchUno", target: "zero" });
    const bad = await sockets[1].nextFrameMatching((m) => m.type === "error");
    expect(bad).toMatchObject({ type: "error", code: "bad-message" });

    for (const s of sockets) s.ws.close();
  });
});

describe("UnoTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const { tableId, host, p2, stub } = await setUpScriptedTable("unoonce");
    const users = [host, p2] as const;
    const sockets = await playScriptedGameToFinish(tableId, [host.cookie, p2.cookie]);
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

describe("UnoTableDO — redaction", () => {
  it("never sends a seat another seat's cards or the draw pile mid-hand", async () => {
    const { tableId, host, p2 } = await setUpScriptedTable("unored");
    const sockets = await playScriptedGameToFinish(tableId, [host.cookie, p2.cookie]);

    const allowed: Record<number, Set<string>> = {
      0: new Set(SEAT0_IDS),
      1: new Set([...SEAT1_IDS, ...DRAW_IDS]),
    };
    for (let seat = 0; seat < sockets.length; seat++) {
      for (const raw of sockets[seat].raw) {
        const parsed = JSON.parse(raw) as ServerMessage;
        if (parsed.type === "state" && parsed.view?.phase === "playing") {
          expect(raw).not.toContain('"drawPile"');
          expect(raw).not.toContain('"hands"');
        }
      }
      for (const msg of sockets[seat].messages) {
        const view = playingView(msg);
        if (!view || view.viewer !== seat) continue;
        for (const card of view.hand) expect(allowed[seat].has(card.id)).toBe(true);
      }
    }
    // Seat 1 never saw seat 0's unplayed action cards before they hit the table.
    const firstPlaying = sockets[1].raw.find((r) => (JSON.parse(r) as ServerMessage).type === "state" && r.includes('"playing"'));
    expect(firstPlaying).toBeDefined();
    for (const id of SEAT0_IDS) expect(firstPlaying).not.toContain(`"${id}"`);

    for (const s of sockets) s.ws.close();
  });
});

describe("UnoTableDO — reconnection", () => {
  it("re-seats a reconnecting user by userId and lets play continue", async () => {
    const { tableId, host, p2 } = await setUpScriptedTable("unorec");
    const s0 = await openTableSocket(tableId, host.cookie);
    let s1 = await openTableSocket(tableId, p2.cookie);
    await readyUpAndReachPlaying([s0, s1]);

    send(s0, { type: "play", cardId: "r1a" });
    await s1.nextFrameMatching((m) => playingView(m)?.currentTurn === 1);

    s1.ws.close(1000, "test disconnect");
    await s0.nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    s1 = await openTableSocket(tableId, p2.cookie);
    const reconnectState = asStateMessage(await s1.nextFrameMatching((m) => m.type === "state"))!;
    expect(reconnectState.view?.viewer).toBe(1);
    expect(reconnectState.seats[1].connected).toBe(true);
    expect(reconnectState.seats[1].userId).toBe(p2.id);
    if (reconnectState.view?.phase !== "playing") throw new Error("expected playing view");
    expect(reconnectState.view.hand.map((c) => c.id)).toEqual(SEAT1_IDS);

    send(s1, { type: "draw" });
    await s0.nextFrameMatching((m) => playingView(m)?.currentTurn === 0 && playingView(m)?.handCounts[1] === 8);

    s0.ws.close();
    s1.ws.close();
  });

  it("voids the hand when a disconnect outlasts the grace window", async () => {
    const { tableId, host, p2, stub } = await setUpScriptedTable("unogr");
    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    await readyUpAndReachPlaying([s0, s1]);
    const before = await creditsOf([host, p2]);

    s1.ws.close(1000, "gone for good");
    await s0.nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const aborted = await s0.nextFrameMatching((m) => m.type === "aborted");
    expect(aborted).toMatchObject({ type: "aborted", leaver: { seat: 1, username: p2.username } });
    expect(asStateMessage(await s0.nextFrameMatching((m) => m.type === "state"))!.view).toBeNull();
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(0);
    expect(await creditsOf([host, p2])).toEqual(before);

    s0.ws.close();
  });
});

describe("UnoTableDO — deliberate leave aborts the hand", () => {
  it("ends the game for everyone immediately with no settlement and cleared lobby membership", async () => {
    const [host, p2] = await Promise.all([registerUser("unolvh"), registerUser("unolvp")]);

    // Through the real lobby so membership rows exist to be cleared.
    const { tableId } = await (await quickPlay(host.cookie)).json<{ tableId: string }>();
    const joined = await (await quickPlay(p2.cookie)).json<{ tableId: string }>();
    expect(joined.tableId).toBe(tableId);

    const stub = env.UNO_TABLE_DO.getByName(tableId);
    await stub.setTestFixedDeal({ shuffledDeck: buildScriptedDeck(), firstSeat: TEST_FIRST_SEAT });

    const sockets: [FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
    ];
    await readyUpAndReachPlaying(sockets);
    const before = await creditsOf([host, p2]);

    send(sockets[0], { type: "leave" });
    const abortedFrames = await Promise.all(sockets.map((s) => s.nextFrameMatching((m) => m.type === "aborted")));
    for (const msg of abortedFrames) {
      expect(msg).toMatchObject({ type: "aborted", leaver: { seat: 0, username: host.username } });
    }
    const finalStates = await Promise.all(sockets.map((s) => s.nextFrameMatching((m) => asStateMessage(m) !== null)));
    for (const m of finalStates) expect(asStateMessage(m)!.view).toBeNull();

    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(0);
    expect(await creditsOf([host, p2])).toEqual(before);

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    await waitUntil(async () => !(await lobbyStub.isMember(host.id)));
    expect(await lobbyStub.isMember(p2.id)).toBe(false);
    expect(await isUserInLiveGame(env, host.id)).toBe(false);
    expect(await isUserInLiveGame(env, p2.id)).toBe(false);

    // Ready-up after an abort is refused.
    send(sockets[1], { type: "ready" });
    await sockets[1].nextFrameMatching((m) => m.type === "error" && m.code === "table-aborted");

    for (const s of sockets) s.ws.close();
  });
});

describe("UnoTableDO — mid-hand joiner", () => {
  it("seats a third player as a bystander with no cards and refuses their ready-up", async () => {
    const { tableId, host, p2 } = await setUpScriptedTable("unobys");
    const p3 = await registerUser("unobys3");
    const s0 = await openTableSocket(tableId, host.cookie);
    const s1 = await openTableSocket(tableId, p2.cookie);
    await readyUpAndReachPlaying([s0, s1]);

    const s2 = await openTableSocket(tableId, p3.cookie);
    const seated = asStateMessage(await s2.nextFrameMatching((m) => asStateMessage(m)?.seats[2].userId === p3.id))!;
    expect(seated.view?.phase).toBe("playing");
    if (seated.view?.phase !== "playing") throw new Error("unreachable");
    expect(seated.view.activeSeats).toEqual([0, 1]);
    expect(seated.view.hand).toEqual([]);
    expect(seated.view.handCounts[0]).toBe(7);

    send(s2, { type: "ready" });
    await s2.nextFrameMatching((m) => m.type === "error" && m.code === "game-in-progress");
    send(s2, { type: "draw" });
    await s2.nextFrameMatching((m) => m.type === "error" && m.code === "not-your-turn");

    for (const s of [s0, s1, s2]) s.ws.close();
  });
});
