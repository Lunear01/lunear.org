import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  applyAction,
  createDeck,
  createGame,
  settle,
  startNextRound,
  type Action,
  type Card,
  type GameState,
  type RedactedRoundEndView,
  type Seat,
  type TableRank,
} from "liarsbar";
import { describe, expect, it } from "vitest";
import { lobbyDoName } from "../src/durable-objects/lobby";
import type { ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/liarsbar-protocol";
import { isUserInLiveGame } from "../src/game/live-check";

const STAKE = 100;
const GAME_ID = "liarsbar";

// --- User / table setup helpers, mirroring test/game-table.test.ts's conventions ---

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

/** Routes a table's creation through the real lobby (quick play), matching
 * test/lobby.test.ts's isUserInLiveGame setup — needed whenever a test wants
 * genuine LobbyDO membership rows to assert get cleared, unlike initTable()
 * above which talks to LiarsBarTableDO directly and never touches the lobby. */
function quickPlay(cookie: string): Promise<Response> {
  return SELF.fetch(`http://example.com/api/lobby/${GAME_ID}/quickplay`, {
    method: "POST",
    headers: { cookie },
  });
}

/** Polls `check` until it resolves true or `timeoutMs` elapses — used only
 * for the eventual-consistency window between a broadcast a client observes
 * and the DO's own best-effort, awaited-but-not-blocking LobbyDO notify that
 * follows it (see notifyLobbyTableCleared's doc comment in liarsbar-table.ts). */
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
  // Attach the frame queue synchronously, in the same tick as accept() — see
  // game-table.test.ts's identical comment on why this matters.
  return attachFrameQueue(ws);
}

function send(socket: FrameQueue, msg: Record<string, unknown>): void {
  socket.ws.send(JSON.stringify(msg));
}

// --- Frame queue --------------------------------------------------------------
// Mirrors game-table.test.ts's FrameQueue exactly (see its extensive header
// comment for why this is a forward-scanning cursor rather than a stateless
// `messages.find(pred)`), plus a `raw` log of the untouched wire text for the
// redaction test's "grep the raw frames" requirement below.

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

function roundEndView(m: ServerMessage): RedactedRoundEndView | null {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "roundEnd") return null;
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

// --- Scripted deck ------------------------------------------------------------
//
// A 20-card deck (6 Q + 6 K + 6 A + 2 Jokers) split into 4 fixed 5-card
// blocks, one per seat. dealHands() always re-slices the SAME deck into
// fresh per-seat hands every round (see games/liarsbar/src/deal.ts), so with
// the table rank fixed at "Q" and every bullet chamber fixed at 1 (dies on
// the very first lost challenge), the exact same deck/rank/bullets override
// drives a fully deterministic 3-round game every time it's applied,
// regardless of how many rounds a given test plays through:
//   - seat0 always holds real Qs (Q1-Q5) whenever dealt a hand.
//   - seat2 always holds a real Q (Q6) plus filler (A1-A4).
//   - seat1's Q-less K1-K5 block and seat3's Q-less A5/A6/K6/Joker/Joker
//     block only ever matter while those seats are still alive to be dealt
//     to — their content is irrelevant beyond "some non-empty hand" (see
//     applyPlay's othersWithCards / auto-challenge check in game.ts).
const SEAT0_IDS = ["Q1", "Q2", "Q3", "Q4", "Q5"];
const SEAT1_IDS = ["K1", "K2", "K3", "K4", "K5"];
const SEAT2_IDS = ["Q6", "A1", "A2", "A3", "A4"];
const SEAT3_IDS = ["A5", "A6", "K6", "JOKER1", "JOKER2"];

const TEST_TABLE_RANK: TableRank = "Q";
const TEST_BULLETS: Record<Seat, number> = { 0: 1, 1: 1, 2: 1, 3: 1 };
const TEST_FIRST_SEAT: Seat = 0;

function buildScriptedDeck(): Card[] {
  const full = createDeck();
  const byId = new Map(full.map((c) => [c.id, c]));
  const orderedIds = [...SEAT0_IDS, ...SEAT1_IDS, ...SEAT2_IDS, ...SEAT3_IDS];
  return orderedIds.map((id) => {
    const card = byId.get(id);
    if (!card) throw new Error(`buildScriptedDeck: missing card ${id}`);
    return card;
  });
}

/**
 * Independently replays the same scripted play/challenge sequence through
 * the pure engine (not through the DO) to derive the expected settlement —
 * this keeps the "full game" test from being tautological (it doesn't just
 * compare the DO's own settle() output to itself). Every play below is a
 * genuine table-rank card, so every challenge in this script is lost by the
 * CHALLENGER (see resolveChallenge in game.ts): seat1 dies in round 1, seat3
 * in round 2, and seat2's round-3 loss leaves seat0 as the sole survivor.
 */
function replayScriptedGameForExpectedDeltas(deck: Card[]): Readonly<Record<Seat, number>> {
  function applyOrThrow(state: GameState, seat: Seat, action: Action): GameState {
    const result = applyAction(state, seat, action);
    if (!result.ok) throw new Error(`unexpected rejection in replay: ${result.reason}`);
    return result.state;
  }
  function advancePastRoundEnd(state: GameState): GameState {
    if (state.phase !== "roundEnd") return state;
    return startNextRound(state, { shuffledDeck: deck, tableRank: TEST_TABLE_RANK });
  }

  let state: GameState = createGame({
    shuffledDeck: deck,
    tableRank: TEST_TABLE_RANK,
    bulletPositions: TEST_BULLETS,
    firstSeat: TEST_FIRST_SEAT,
    baseStake: STAKE,
  });

  state = applyOrThrow(state, 0, { type: "play", cardIds: ["Q1"] });
  state = applyOrThrow(state, 1, { type: "challenge" });
  state = advancePastRoundEnd(state); // seat1 dies -> round 2, currentTurn 2

  state = applyOrThrow(state, 2, { type: "play", cardIds: ["Q6"] });
  state = applyOrThrow(state, 3, { type: "challenge" });
  state = advancePastRoundEnd(state); // seat3 dies -> round 3, currentTurn 0

  state = applyOrThrow(state, 0, { type: "play", cardIds: ["Q2"] });
  state = applyOrThrow(state, 2, { type: "challenge" }); // seat2 dies -> only seat0 left: finished

  if (state.phase !== "finished") throw new Error("expected replay to reach a finished state");
  return settle(state);
}

/**
 * Drives 4 already-connected sockets through ready-up and up to the first
 * dealt hand, ending right as seat 0 (the scripted first seat) leads —
 * genuinely mid-hand (playing phase). Shared by every test below that needs
 * an active hand, plus playScriptedGameToFinish (which continues to a full
 * finish).
 */
async function readyUpAndReachPlaying(
  sockets: readonly [FrameQueue, FrameQueue, FrameQueue, FrameQueue],
): Promise<void> {
  // Note: don't wait for each socket's connect-time broadcastState() message
  // here — see game-table.test.ts's identical comment on why that specific
  // frame is unrecoverable by construction. Every wait below targets a
  // later, distinguishable message instead.
  send(sockets[0], { type: "ready" });
  await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[0].ready === true);
  send(sockets[1], { type: "ready" });
  await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.seats[1].ready === true);
  send(sockets[2], { type: "ready" });
  await sockets[2].nextFrameMatching((m) => asStateMessage(m)?.seats[2].ready === true);
  send(sockets[3], { type: "ready" });
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0);
}

/**
 * Drives 4 sockets through ready-up and the full 3-round scripted game to a
 * finish (see buildScriptedDeck's doc comment for why this exact script is
 * deterministic). Returns both the sockets and every "roundEnd" view
 * broadcast along the way, so callers can assert on the reveal contents.
 */
async function playScriptedGameToFinish(
  tableId: string,
  cookies: readonly [string, string, string, string],
): Promise<{ sockets: [FrameQueue, FrameQueue, FrameQueue, FrameQueue]; roundEnds: RedactedRoundEndView[] }> {
  // Connect sequentially, not via Promise.all — see game-table.test.ts's
  // identical comment on why this pins seat 0/1/2/3 to cookies[0..3]
  // deterministically.
  const sockets: [FrameQueue, FrameQueue, FrameQueue, FrameQueue] = [
    await openTableSocket(tableId, cookies[0]),
    await openTableSocket(tableId, cookies[1]),
    await openTableSocket(tableId, cookies[2]),
    await openTableSocket(tableId, cookies[3]),
  ];

  await readyUpAndReachPlaying(sockets);

  const roundEnds: RedactedRoundEndView[] = [];

  // Round 1: seat0 leads a real Q; seat1 challenges (truthful) and dies.
  send(sockets[0], { type: "play", cardIds: ["Q1"] });
  await sockets[1].nextFrameMatching((m) => playingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "challenge" });
  roundEnds.push(roundEndView(await sockets[0].nextFrameMatching((m) => roundEndView(m) !== null))!);
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 2);

  // Round 2: seat2 leads a real Q; seat3 challenges (truthful) and dies.
  send(sockets[2], { type: "play", cardIds: ["Q6"] });
  await sockets[3].nextFrameMatching((m) => playingView(m)?.currentTurn === 3);
  send(sockets[3], { type: "challenge" });
  roundEnds.push(roundEndView(await sockets[0].nextFrameMatching((m) => roundEndView(m) !== null))!);
  await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0);

  // Round 3: seat0 leads a real Q; seat2 challenges (truthful) and dies —
  // only seat0 remains alive, so this resolves straight to "finished" (no
  // roundEnd broadcast for this last challenge; its reveal instead rides
  // along on the finished view/settlement).
  send(sockets[0], { type: "play", cardIds: ["Q2"] });
  await sockets[2].nextFrameMatching((m) => playingView(m)?.currentTurn === 2);
  send(sockets[2], { type: "challenge" });
  await sockets[0].nextFrameMatching((m) => m.type === "settled");

  return { sockets, roundEnds };
}

// --- Tests --------------------------------------------------------------------

describe("LiarsBarTableDO — full scripted game", () => {
  it("plays to completion over WebSockets, broadcasts each reveal, and settles exact D1 balances exactly once", async () => {
    const tableId = `t-full-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("lbfhost"),
      registerUser("lbfullp2"),
      registerUser("lbfullp3"),
      registerUser("lbfullp4"),
    ]);
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.LIARSBAR_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({
      shuffledDeck: deck,
      tableRank: TEST_TABLE_RANK,
      bulletPositions: TEST_BULLETS,
      firstSeat: TEST_FIRST_SEAT,
    });

    const users = [host, p2, p3, p4] as const;
    const before = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );

    const { sockets, roundEnds } = await playScriptedGameToFinish(tableId, [
      host.cookie,
      p2.cookie,
      p3.cookie,
      p4.cookie,
    ]);

    // Each resolved challenge's reveal — cards, truthfulness, who spun, pulls,
    // and whether they died — arrived on the roundEnd broadcast before play
    // continued.
    expect(roundEnds).toHaveLength(2);
    expect(roundEnds[0].lastReveal).toMatchObject({
      playSeat: 0,
      challengerSeat: 1,
      wasTruthful: true,
      loserSeat: 1,
      auto: false,
    });
    expect(roundEnds[0].lastReveal.cards.map((c) => c.id)).toEqual(["Q1"]);
    expect(roundEnds[0].players[1]).toEqual({ alive: false, pulls: 1 });
    expect(roundEnds[0].nextFirstSeat).toBe(2);

    expect(roundEnds[1].lastReveal).toMatchObject({
      playSeat: 2,
      challengerSeat: 3,
      wasTruthful: true,
      loserSeat: 3,
      auto: false,
    });
    expect(roundEnds[1].lastReveal.cards.map((c) => c.id)).toEqual(["Q6"]);
    expect(roundEnds[1].players[3]).toEqual({ alive: false, pulls: 1 });
    expect(roundEnds[1].nextFirstSeat).toBe(0);

    const settledMsg = sockets[0].messages.find((m) => m.type === "settled") as
      | SettledMessage
      | undefined;
    expect(settledMsg).toBeDefined();
    expect(settledMsg!.round).toBe(1);

    const expected = replayScriptedGameForExpectedDeltas(deck);
    expect(settledMsg!.deltas).toEqual(expected);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);

    for (let i = 0; i < users.length; i++) {
      const seat = i as Seat;
      const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(users[i].id)
        .first<{ credits: number }>();
      expect(row!.credits).toBe(before[i]!.credits + expected[seat]);
    }

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(4);
    for (let i = 0; i < users.length; i++) {
      const seat = i as Seat;
      const row = ledger.results!.find((r) => r.userId === users[i].id);
      expect(row).toBeDefined();
      expect(row!.amount).toBe(expected[seat]);
      expect(row!.idempotencyKey).toBe(`settle:${tableId}:1:${users[i].id}`);
    }

    const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(`${tableId}:1`)
      .first<{ table_id: string; round: number; game_id: string; stake: number }>();
    expect(gameRow?.table_id).toBe(tableId);
    expect(gameRow?.round).toBe(1);
    expect(gameRow?.game_id).toBe("liarsbar");
    expect(gameRow?.stake).toBe(STAKE);

    for (const s of sockets) s.ws.close();
  });
});

describe("LiarsBarTableDO — seat broadcasts carry live credit balances", () => {
  it("caches each seat's D1 credits on connect and refreshes them after settlement", async () => {
    const tableId = `t-credits-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("lbcrhost"),
      registerUser("lbcrp2"),
      registerUser("lbcrp3"),
      registerUser("lbcrp4"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.LIARSBAR_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({
      shuffledDeck: deck,
      tableRank: TEST_TABLE_RANK,
      bulletPositions: TEST_BULLETS,
      firstSeat: TEST_FIRST_SEAT,
    });

    const users = [host, p2, p3, p4] as const;
    const before = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );

    // Connect sequentially so seat 0/1/2/3 pin to host/p2/p3/p4
    // deterministically (see playScriptedGameToFinish's identical comment).
    const sockets: [FrameQueue, FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
      await openTableSocket(tableId, p4.cookie),
    ];

    // Connect-time caching: by the time all 4 are seated, the broadcast
    // already carries every occupant's real D1 balance, well before any hand
    // starts — not a stale/zero default.
    const allSeated = asStateMessage(
      await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats.every((s) => s.userId !== null) === true),
    )!;
    for (let i = 0; i < users.length; i++) {
      expect(allSeated.seats[i].credits).toBe(before[i]!.credits);
    }

    await readyUpAndReachPlaying(sockets);

    // Round 1: seat0 leads a real Q; seat1 challenges (truthful) and dies.
    send(sockets[0], { type: "play", cardIds: ["Q1"] });
    await sockets[1].nextFrameMatching((m) => playingView(m)?.currentTurn === 1);
    send(sockets[1], { type: "challenge" });
    await sockets[0].nextFrameMatching((m) => roundEndView(m) !== null);
    await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 2);

    // Round 2: seat2 leads a real Q; seat3 challenges (truthful) and dies.
    send(sockets[2], { type: "play", cardIds: ["Q6"] });
    await sockets[3].nextFrameMatching((m) => playingView(m)?.currentTurn === 3);
    send(sockets[3], { type: "challenge" });
    await sockets[0].nextFrameMatching((m) => roundEndView(m) !== null);
    await sockets[0].nextFrameMatching((m) => playingView(m)?.currentTurn === 0);

    // Round 3: seat0 leads a real Q; seat2 challenges (truthful) and dies —
    // only seat0 remains alive: finished.
    send(sockets[0], { type: "play", cardIds: ["Q2"] });
    await sockets[2].nextFrameMatching((m) => playingView(m)?.currentTurn === 2);
    send(sockets[2], { type: "challenge" });
    await sockets[0].nextFrameMatching((m) => m.type === "settled");

    const expected = replayScriptedGameForExpectedDeltas(deck);
    const after = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );

    // The 'state' broadcast right after 'settled' reflects every seat's
    // post-delta D1 balance, refreshed in the same batched query that
    // produced 'settled'.newBalance.
    const afterSettle = asStateMessage(await sockets[0].nextFrameMatching((m) => asStateMessage(m) !== null))!;
    for (let i = 0; i < users.length; i++) {
      const seat = i as Seat;
      expect(after[i]!.credits).toBe(before[i]!.credits + expected[seat]);
      expect(afterSettle.seats[i].credits).toBe(after[i]!.credits);
    }

    for (const s of sockets) s.ws.close();
  });
});

describe("LiarsBarTableDO — reconnection", () => {
  it("re-seats a reconnecting user by userId and lets play continue", async () => {
    const tableId = `t-reconnect-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("lbrhost"),
      registerUser("lbrp2"),
      registerUser("lbrp3"),
      registerUser("lbrp4"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.LIARSBAR_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({
      shuffledDeck: deck,
      tableRank: TEST_TABLE_RANK,
      bulletPositions: TEST_BULLETS,
      firstSeat: TEST_FIRST_SEAT,
    });

    const s0 = await openTableSocket(tableId, host.cookie);
    let s1 = await openTableSocket(tableId, p2.cookie);
    const s2 = await openTableSocket(tableId, p3.cookie);
    const s3 = await openTableSocket(tableId, p4.cookie);

    await readyUpAndReachPlaying([s0, s1, s2, s3]);

    // Seat0 leads the first play; it becomes seat1's turn.
    send(s0, { type: "play", cardIds: ["Q1"] });
    await s1.nextFrameMatching((m) => playingView(m)?.currentTurn === 1);

    // Seat 1 disconnects mid-hand.
    s1.ws.close(1000, "test disconnect");
    await s0.nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    // Reconnect as the same user; the DO must re-seat them at seat 1 and
    // hand back their own redacted view, not a fresh/empty one.
    s1 = await openTableSocket(tableId, p2.cookie);
    const reconnectMsg = await s1.nextFrameMatching((m) => m.type === "state");
    const reconnectState = asStateMessage(reconnectMsg)!;
    expect(reconnectState.view?.viewer).toBe(1);
    expect(reconnectState.seats[1].connected).toBe(true);
    expect(reconnectState.seats[1].userId).toBe(p2.id);

    // Play continues: the reconnected seat can still legally act (as
    // scripted, challenging the pending play), driving the game into round 2.
    send(s1, { type: "challenge" });
    await s0.nextFrameMatching((m) => playingView(m)?.currentTurn === 2);

    s0.ws.close();
    s1.ws.close();
    s2.ws.close();
    s3.ws.close();
  });
});

describe("LiarsBarTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const tableId = `t-once-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("lbohost"),
      registerUser("lbop2"),
      registerUser("lbop3"),
      registerUser("lbop4"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.LIARSBAR_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({
      shuffledDeck: deck,
      tableRank: TEST_TABLE_RANK,
      bulletPositions: TEST_BULLETS,
      firstSeat: TEST_FIRST_SEAT,
    });

    const users = [host, p2, p3, p4] as const;
    const { sockets } = await playScriptedGameToFinish(tableId, [
      host.cookie,
      p2.cookie,
      p3.cookie,
      p4.cookie,
    ]);
    for (const s of sockets) s.ws.close();

    const afterFirst = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );
    const ledgerAfterFirst = await ledgerRowsForRound(tableId, 1);
    expect(ledgerAfterFirst.results).toHaveLength(4);

    // Simulate a crash between "the D1 batch committed" and "the local
    // settled flag was persisted": flip the flag back so a forced retry
    // genuinely re-attempts the D1 batch and must be saved by the
    // credit_ledger UNIQUE idempotency_key, not by the local flag alone.
    await runInDurableObject(stub, async (_instance, doState) => {
      doState.storage.sql.exec("UPDATE game_state SET settled = 0 WHERE id = 1");
    });

    await expect(stub.forceSettle()).resolves.toBeUndefined();

    const afterRetry = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );
    expect(afterRetry).toEqual(afterFirst);

    const ledgerAfterRetry = await ledgerRowsForRound(tableId, 1);
    expect(ledgerAfterRetry.results).toHaveLength(4);
  });
});

describe("LiarsBarTableDO — redaction", () => {
  it("never sends a seat another seat's hand card ids, nor any seat's bulletChamber value, in any phase", async () => {
    const tableId = `t-redact-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("lbdhost"),
      registerUser("lbdp2"),
      registerUser("lbdp3"),
      registerUser("lbdp4"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.LIARSBAR_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({
      shuffledDeck: deck,
      tableRank: TEST_TABLE_RANK,
      bulletPositions: TEST_BULLETS,
      firstSeat: TEST_FIRST_SEAT,
    });

    const { sockets } = await playScriptedGameToFinish(tableId, [
      host.cookie,
      p2.cookie,
      p3.cookie,
      p4.cookie,
    ]);

    const allowedIds: Record<Seat, Set<string>> = {
      0: new Set(SEAT0_IDS),
      1: new Set(SEAT1_IDS),
      2: new Set(SEAT2_IDS),
      3: new Set(SEAT3_IDS),
    };

    for (let seat = 0; seat < sockets.length; seat++) {
      const socket = sockets[seat];

      // The secret bulletChamber value must never appear on the wire, in any
      // phase, to any seat — grepped against the raw untouched frame text
      // (not the parsed/re-stringified object) so a stray extra field would
      // be caught even if some future refactor changed the view type.
      for (const raw of socket.raw) {
        expect(raw).not.toContain("bulletChamber");
      }

      // Every "playing" hand this seat is ever shown across all 3 rounds is
      // drawn only from its own fixed block of the scripted deck — never
      // another seat's cards.
      for (const msg of socket.messages) {
        const view = playingView(msg);
        if (!view || view.viewer !== seat) continue;
        for (const card of view.hand) {
          expect(allowedIds[seat as Seat].has(card.id)).toBe(true);
        }
      }
    }

    for (const s of sockets) s.ws.close();
  });
});

describe("LiarsBarTableDO — deliberate leave aborts the hand", () => {
  it("ends the game for everyone immediately: no settlement, no ledger rows, cleared lobby membership", async () => {
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("lblvhost"),
      registerUser("lblvp2"),
      registerUser("lblvp3"),
      registerUser("lblvp4"),
    ]);

    // Route table creation through the real lobby (quick play) rather than
    // initTable() — see game-table.test.ts's identical comment on why this
    // is load-bearing for the "membership got cleared" assertions below.
    await quickPlay(host.cookie);
    await quickPlay(p2.cookie);
    await quickPlay(p3.cookie);
    const matchRes = await quickPlay(p4.cookie);
    const { tableId } = await matchRes.json<{ tableId: string }>();

    const stub = env.LIARSBAR_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({
      shuffledDeck: deck,
      tableRank: TEST_TABLE_RANK,
      bulletPositions: TEST_BULLETS,
      firstSeat: TEST_FIRST_SEAT,
    });

    const sockets: [FrameQueue, FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
      await openTableSocket(tableId, p4.cookie),
    ];
    await readyUpAndReachPlaying(sockets);

    const users = [host, p2, p3, p4] as const;
    const before = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );

    // Seat0 (host) leaves mid-hand.
    send(sockets[0], { type: "leave" });

    const abortedFrames = await Promise.all(
      sockets.map((s) => s.nextFrameMatching((m) => m.type === "aborted")),
    );
    for (const msg of abortedFrames) {
      expect(msg).toMatchObject({ type: "aborted", leaver: { seat: 0, username: host.username } });
    }

    // A final state broadcast follows, with no active hand left to show.
    const finalStates = await Promise.all(
      sockets.map((s) => s.nextFrameMatching((m) => asStateMessage(m) !== null)),
    );
    for (const m of finalStates) {
      expect(asStateMessage(m)!.view).toBeNull();
    }

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(0);

    const after = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );
    expect(after).toEqual(before);

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    // The DO's notify-LobbyDO call is deliberately awaited after the
    // websocket broadcasts, so membership clearing can lag slightly behind
    // the client-visible 'aborted' frame — poll rather than assert immediately.
    await waitUntil(async () => !(await lobbyStub.isMember(host.id)));
    expect(await lobbyStub.isMember(p2.id)).toBe(false);
    expect(await lobbyStub.isMember(p3.id)).toBe(false);
    expect(await lobbyStub.isMember(p4.id)).toBe(false);

    expect(await isUserInLiveGame(env, host.id)).toBe(false);
    expect(await isUserInLiveGame(env, p2.id)).toBe(false);
    expect(await isUserInLiveGame(env, p3.id)).toBe(false);
    expect(await isUserInLiveGame(env, p4.id)).toBe(false);

    for (const s of sockets) s.ws.close();
  });
});
