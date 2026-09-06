import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  RANK,
  applyAction,
  createDeck,
  createGame,
  settle,
  type Action,
  type Card,
  type GameState,
  type Seat,
} from "doudizhu";
import { describe, expect, it } from "vitest";
import { lobbyDoName } from "../src/durable-objects/lobby";
import type { ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/protocol";
import { isUserInLiveGame } from "../src/game/live-check";

const STAKE = 100;
const GAME_ID = "doudizhu";

// --- User / table setup helpers, mirroring test/auth.test.ts's conventions ---

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
    body: JSON.stringify({ gameId: "doudizhu", stake, visibility: "private" }),
  });
  expect(res.status).toBe(200);
}

/** Routes a table's creation through the real lobby (quick play), matching
 * test/lobby.test.ts's isUserInLiveGame setup — needed whenever a test wants
 * genuine LobbyDO membership rows to assert get cleared, unlike initTable()
 * above which talks to GameTableDO directly and never touches the lobby. */
function quickPlay(cookie: string): Promise<Response> {
  return SELF.fetch(`http://example.com/api/lobby/${GAME_ID}/quickplay`, {
    method: "POST",
    headers: { cookie },
  });
}

/** Polls `check` until it resolves true or `timeoutMs` elapses — used only
 * for the eventual-consistency window between a broadcast a client observes
 * and the DO's own best-effort, awaited-but-not-blocking LobbyDO notify that
 * follows it (see notifyLobbyTableCleared's doc comment in game-table.ts). */
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
  // Attach the frame queue synchronously, in the same tick as accept() — no
  // await in between, so there is no window in which an incoming frame could
  // reach an unattached EventTarget and be lost (EventTarget does not replay
  // past events to a listener added later).
  return attachFrameQueue(ws);
}

function send(socket: FrameQueue, msg: Record<string, unknown>): void {
  socket.ws.send(JSON.stringify(msg));
}

// --- Frame queue --------------------------------------------------------------
//
// Every inbound 'message' frame is appended to a log the instant it arrives,
// and a cursor tracks how far each caller has consumed. This is deliberately
// NOT a "search the whole history" predicate match: doudizhu's state
// broadcasts recur with identical shape every trick (e.g. currentTurn cycles
// 0 -> 1 -> 2 -> 0 on every bomb lead), so a predicate like
// `currentTurn === 1` is satisfied by every trick, not only the one being
// awaited right now. A stateless `messages.find(pred)` would resolve
// instantly against a STALE frame left over from an earlier trick, letting
// the test race ahead of the DO and fire its next action before the state it
// thinks it's reacting to has actually happened — the predicate-overshoot
// race that caused the intermittent failures in this file.
// nextFrameMatching() only ever scans forward from the last frame it
// consumed, so a frame it has already passed can never satisfy a later wait,
// and a genuinely new matching frame is found as soon as it arrives.

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

function biddingView(m: ServerMessage) {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "bidding") return null;
  return s.view;
}

function playingView(m: ServerMessage) {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "playing") return null;
  return s.view;
}

// --- Scripted deck: seat 0 gets ranks 3-7 (20 cards = five 4-of-a-kind
// bombs) split 17 dealt + 3 landlordCards; seats 1/2 split the other 34. ---

function buildScriptedDeck(): Card[] {
  const full = createDeck();
  const isLandlordRank = (c: Card) => c.rank >= RANK.Three && c.rank <= RANK.Seven;
  const landlordCards = full.filter(isLandlordRank); // 20 cards
  const farmerCards = full.filter((c) => !isLandlordRank(c)); // 34 cards
  return [...landlordCards.slice(0, 17), ...farmerCards, ...landlordCards.slice(17, 20)];
}

const LANDLORD_BOMB_RANKS = [RANK.Three, RANK.Four, RANK.Five, RANK.Six, RANK.Seven] as const;

function cardIdsForRank(rank: number): string[] {
  return createDeck()
    .filter((c) => c.rank === rank)
    .map((c) => c.id);
}

/**
 * Independently replays the same scripted bid/play sequence through the pure
 * engine (not through the DO) to derive the expected settlement — this keeps
 * the "full game" test from being tautological (it doesn't just compare the
 * DO's own settle() output to itself).
 */
function replayScriptedGameForExpectedDeltas(deck: Card[]): Readonly<Record<Seat, number>> {
  function applyOrThrow(state: GameState, seat: Seat, action: Action): GameState {
    const result = applyAction(state, seat, action);
    if (!result.ok) throw new Error(`unexpected rejection in replay: ${result.reason}`);
    return result.state;
  }

  let state: GameState = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: STAKE });
  state = applyOrThrow(state, 0, { type: "bid", amount: 3 });

  for (let i = 0; i < LANDLORD_BOMB_RANKS.length; i++) {
    state = applyOrThrow(state, 0, { type: "play", cardIds: cardIdsForRank(LANDLORD_BOMB_RANKS[i]) });
    if (i < LANDLORD_BOMB_RANKS.length - 1) {
      state = applyOrThrow(state, 1, { type: "pass" });
      state = applyOrThrow(state, 2, { type: "pass" });
    }
  }

  if (state.phase !== "finished") throw new Error("expected replay to reach a finished state");
  return settle(state);
}

async function ledgerRowsForRound(tableId: string, round: number) {
  return env.DB.prepare(
    `SELECT user_id as userId, amount, idempotency_key as idempotencyKey
     FROM credit_ledger WHERE idempotency_key LIKE ?`,
  )
    .bind(`settle:${tableId}:${round}:%`)
    .all<{ userId: string; amount: number; idempotencyKey: string }>();
}

/**
 * Drives 3 already-connected sockets through ready-up and a bid-3 landlord
 * win, ending right as seat 0 (the landlord) leads the first trick — i.e.
 * genuinely mid-hand (playing phase), not just mid-bidding. Shared by every
 * test below that needs an active hand to leave/disconnect out of, plus
 * playScriptedGameToFinish (which continues on to a full finish).
 */
async function readyUpAndReachPlaying(sockets: readonly [FrameQueue, FrameQueue, FrameQueue]): Promise<void> {
  // Note: don't wait for each socket's connect-time broadcastState() message
  // here — the DO's fetch() handler broadcasts to a newly-accepted socket
  // before returning the 101 response, i.e. before the test can possibly
  // have a listener attached, so that specific frame is unrecoverable by
  // construction. Every wait below targets a later, distinguishable message
  // instead.
  send(sockets[0], { type: "ready" });
  await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[0].ready === true);
  send(sockets[1], { type: "ready" });
  await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.seats[1].ready === true);
  send(sockets[2], { type: "ready" });
  await sockets[0].nextFrameMatching((m) => biddingView(m) !== null);

  send(sockets[0], { type: "bid", amount: 3 });
  await sockets[0].nextFrameMatching((m) => {
    const v = playingView(m);
    return v !== null && v.currentTurn === 0 && v.lastPlay === null;
  });
}

/** Drives 3 sockets through ready-up, a bid-3 landlord win, and 5 scripted bomb leads to a finish. */
async function playScriptedGameToFinish(
  tableId: string,
  cookies: readonly [string, string, string],
): Promise<{ sockets: [FrameQueue, FrameQueue, FrameQueue] }> {
  // Connect sequentially, not via Promise.all: the DO assigns seats in the
  // order connections actually reach it (SEATS.find(s => !taken.has(s)) in
  // fetch()), which is NOT guaranteed to match the order three concurrently
  // dispatched fetches were started in. Awaiting each connect fully before
  // starting the next pins seat 0/1/2 to cookies[0]/[1]/[2] deterministically.
  const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
    await openTableSocket(tableId, cookies[0]),
    await openTableSocket(tableId, cookies[1]),
    await openTableSocket(tableId, cookies[2]),
  ];

  await readyUpAndReachPlaying(sockets);

  for (let i = 0; i < LANDLORD_BOMB_RANKS.length; i++) {
    const cardIds = cardIdsForRank(LANDLORD_BOMB_RANKS[i]);
    send(sockets[0], { type: "play", cardIds });

    if (i === LANDLORD_BOMB_RANKS.length - 1) {
      await sockets[0].nextFrameMatching((m) => m.type === "settled");
      continue;
    }

    await sockets[1].nextFrameMatching((m) => playingView(m)?.currentTurn === 1);
    send(sockets[1], { type: "pass" });
    await sockets[2].nextFrameMatching((m) => playingView(m)?.currentTurn === 2);
    send(sockets[2], { type: "pass" });
    await sockets[0].nextFrameMatching((m) => {
      const v = playingView(m);
      return v !== null && v.currentTurn === 0 && v.lastPlay === null;
    });
  }

  return { sockets };
}

// --- Tests --------------------------------------------------------------------

describe("GameTableDO — full scripted game", () => {
  it("plays to completion over WebSockets and settles exact D1 balances exactly once", async () => {
    const tableId = `t-full-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("fullhost"),
      registerUser("fullp2"),
      registerUser("fullp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    const users = [host, p2, p3] as const;
    const before = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );

    const { sockets } = await playScriptedGameToFinish(tableId, [
      host.cookie,
      p2.cookie,
      p3.cookie,
    ]);

    const settledMsg = sockets[0].messages.find((m) => m.type === "settled") as
      | SettledMessage
      | undefined;
    expect(settledMsg).toBeDefined();
    expect(settledMsg!.round).toBe(1);

    const expected = replayScriptedGameForExpectedDeltas(deck);
    expect(settledMsg!.deltas).toEqual(expected);

    for (let i = 0; i < users.length; i++) {
      const seat = i as Seat;
      const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(users[i].id)
        .first<{ credits: number }>();
      expect(row!.credits).toBe(before[i]!.credits + expected[seat]);
    }

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(3);
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
    expect(gameRow?.game_id).toBe("doudizhu");
    expect(gameRow?.stake).toBe(STAKE);

    for (const s of sockets) s.ws.close();
  });
});

describe("GameTableDO — reconnection", () => {
  it("re-seats a reconnecting user by userId and lets play continue", async () => {
    const tableId = `t-reconnect-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("rhost"),
      registerUser("rp2"),
      registerUser("rp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    const s0 = await openTableSocket(tableId, host.cookie);
    let s1 = await openTableSocket(tableId, p2.cookie);
    const s2 = await openTableSocket(tableId, p3.cookie);

    send(s0, { type: "ready" });
    send(s1, { type: "ready" });
    send(s2, { type: "ready" });
    await s0.nextFrameMatching((m) => biddingView(m) !== null);

    send(s0, { type: "bid", amount: 3 });
    await s0.nextFrameMatching((m) => {
      const v = playingView(m);
      return v !== null && v.currentTurn === 0 && v.lastPlay === null;
    });

    // Landlord leads the first bomb; it becomes farmer1 (seat 1)'s turn.
    send(s0, { type: "play", cardIds: cardIdsForRank(RANK.Three) });
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

    // Play continues: the reconnected seat can still legally act.
    send(s1, { type: "pass" });
    await s2.nextFrameMatching((m) => playingView(m)?.currentTurn === 2);
    send(s2, { type: "pass" });
    await s0.nextFrameMatching((m) => {
      const v = playingView(m);
      return v !== null && v.currentTurn === 0 && v.lastPlay === null;
    });

    s0.ws.close();
    s1.ws.close();
    s2.ws.close();
  });
});

describe("GameTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const tableId = `t-once-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("ohost"),
      registerUser("op2"),
      registerUser("op3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    const users = [host, p2, p3] as const;
    const { sockets } = await playScriptedGameToFinish(tableId, [host.cookie, p2.cookie, p3.cookie]);
    for (const s of sockets) s.ws.close();

    const afterFirst = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );
    const ledgerAfterFirst = await ledgerRowsForRound(tableId, 1);
    expect(ledgerAfterFirst.results).toHaveLength(3);

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
    expect(ledgerAfterRetry.results).toHaveLength(3);
  });
});

describe("GameTableDO — redaction", () => {
  it("only ever sends a player their own hand; landlordCards are public to all seats", async () => {
    const tableId = `t-redact-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("dhost"),
      registerUser("dp2"),
      registerUser("dp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    // Connect sequentially — see the comment in playScriptedGameToFinish on
    // why Promise.all here would race the DO's seat assignment.
    const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];

    send(sockets[0], { type: "ready" });
    send(sockets[1], { type: "ready" });
    send(sockets[2], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => biddingView(m) !== null);

    send(sockets[0], { type: "bid", amount: 3 });
    const [msg0, msg1, msg2] = await Promise.all(
      sockets.map((s) => s.nextFrameMatching((m) => playingView(m) !== null)),
    );
    const view0 = playingView(msg0)!;
    const view1 = playingView(msg1)!;
    const view2 = playingView(msg2)!;

    expect(view0.viewer).toBe(0);
    expect(view1.viewer).toBe(1);
    expect(view2.viewer).toBe(2);

    const expectedLandlordIds = new Set([...deck.slice(0, 17), ...deck.slice(51, 54)].map((c) => c.id));
    const expectedFarmer1Ids = new Set(deck.slice(17, 34).map((c) => c.id));
    const expectedFarmer2Ids = new Set(deck.slice(34, 51).map((c) => c.id));
    const expectedLandlordCardsOnly = deck
      .slice(51, 54)
      .map((c) => c.id)
      .sort();

    const ids0 = new Set(view0.hand.map((c) => c.id));
    const ids1 = new Set(view1.hand.map((c) => c.id));
    const ids2 = new Set(view2.hand.map((c) => c.id));

    expect(ids0).toEqual(expectedLandlordIds);
    expect(ids1).toEqual(expectedFarmer1Ids);
    expect(ids2).toEqual(expectedFarmer2Ids);

    // No player's hand contains a card from another seat's hand.
    for (const id of ids1) expect(ids0.has(id)).toBe(false);
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
    for (const id of ids2) expect(ids0.has(id)).toBe(false);

    // landlordCards is intentionally public and identical for every seat.
    expect(view0.landlordCards.map((c) => c.id).sort()).toEqual(expectedLandlordCardsOnly);
    expect(view1.landlordCards.map((c) => c.id).sort()).toEqual(expectedLandlordCardsOnly);
    expect(view2.landlordCards.map((c) => c.id).sort()).toEqual(expectedLandlordCardsOnly);

    // Opponent hand sizes are exposed only as counts.
    expect(view1.handCounts).toEqual({ 0: 20, 1: 17, 2: 17 });

    for (const s of sockets) s.ws.close();
  });
});

describe("GameTableDO — deliberate leave aborts the hand", () => {
  it("ends the game for everyone immediately: no settlement, no ledger rows, cleared lobby membership", async () => {
    const [host, p2, p3] = await Promise.all([
      registerUser("lvhost"),
      registerUser("lvp2"),
      registerUser("lvp3"),
    ]);

    // Route table creation through the real lobby (quick play) rather than
    // initTable() — this is the same setup test/lobby.test.ts's
    // isUserInLiveGame tests use, and it's load-bearing here: initTable()
    // talks to GameTableDO directly and never touches LobbyDO, which would
    // make a "membership got cleared" assertion vacuously true.
    await quickPlay(host.cookie);
    await quickPlay(p2.cookie);
    const matchRes = await quickPlay(p3.cookie);
    const { tableId } = await matchRes.json<{ tableId: string }>();

    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyUpAndReachPlaying(sockets);

    const users = [host, p2, p3] as const;
    const before = await Promise.all(
      users.map((u) =>
        env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>(),
      ),
    );

    // The landlord (seat 0, host) leaves mid-trick.
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
    // websocket broadcasts (see notifyLobbyTableCleared's doc comment), so
    // membership clearing can lag slightly behind the client-visible
    // 'aborted' frame — poll rather than assert immediately.
    await waitUntil(async () => !(await lobbyStub.isMember(host.id)));
    expect(await lobbyStub.isMember(p2.id)).toBe(false);
    expect(await lobbyStub.isMember(p3.id)).toBe(false);

    expect(await isUserInLiveGame(env, host.id)).toBe(false);
    expect(await isUserInLiveGame(env, p2.id)).toBe(false);
    expect(await isUserInLiveGame(env, p3.id)).toBe(false);

    for (const s of sockets) s.ws.close();
  });
});

describe("GameTableDO — disconnect grace expiry aborts the hand", () => {
  it("aborts once the grace alarm fires for a seat that never reconnected", async () => {
    const tableId = `t-graceabort-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("gahost"),
      registerUser("gap2"),
      registerUser("gap3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyUpAndReachPlaying(sockets);

    // Seat 1 (farmer1) disconnects mid-hand and never comes back.
    sockets[1].ws.close(1000, "network drop");
    await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    // Force the grace alarm to run now instead of waiting the real 30s —
    // the DO doesn't check elapsed wall-clock time itself (see alarm()'s doc
    // comment in game-table.ts): a pending row that's still disconnected
    // when the alarm runs is genuinely due, whether the alarm fired for real
    // or was forced here.
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const abortedHost = await sockets[0].nextFrameMatching((m) => m.type === "aborted");
    expect(abortedHost).toMatchObject({ type: "aborted", leaver: { seat: 1, username: p2.username } });
    const abortedP3 = await sockets[2].nextFrameMatching((m) => m.type === "aborted");
    expect(abortedP3).toMatchObject({ type: "aborted", leaver: { seat: 1, username: p2.username } });

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(0);

    sockets[0].ws.close();
    sockets[2].ws.close();
  });
});

describe("GameTableDO — reconnect within grace cancels the pending abort", () => {
  it("does not abort on a disconnect followed by a prompt reconnect (e.g. a page refresh); play continues", async () => {
    const tableId = `t-gracecancel-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("gchost"),
      registerUser("gcp2"),
      registerUser("gcp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.GAME_TABLE_DO.getByName(tableId);
    const deck = buildScriptedDeck();
    await stub.setTestFixedDeal({ shuffledDeck: deck, firstBidder: 0 });

    const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyUpAndReachPlaying(sockets);

    // Landlord leads the first bomb; it becomes seat 1's turn.
    send(sockets[0], { type: "play", cardIds: cardIdsForRank(LANDLORD_BOMB_RANKS[0]) });
    await sockets[1].nextFrameMatching((m) => playingView(m)?.currentTurn === 1);

    sockets[1].ws.close(1000, "page refresh");
    await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === false);

    // Reconnects promptly (as a page refresh would), well inside the 30s grace.
    const reconnected = await openTableSocket(tableId, p2.cookie);
    await reconnected.nextFrameMatching((m) => asStateMessage(m)?.seats[1].connected === true);

    // The pending grace timer was actually cancelled, not just coincidentally
    // not-yet-fired: no alarm is scheduled for this table at all anymore.
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(false);

    // Play continues normally — no 'aborted' frame was ever sent to anyone.
    send(reconnected, { type: "pass" });
    await sockets[2].nextFrameMatching((m) => playingView(m)?.currentTurn === 2);
    send(sockets[2], { type: "pass" });
    await sockets[0].nextFrameMatching((m) => {
      const v = playingView(m);
      return v !== null && v.currentTurn === 0 && v.lastPlay === null;
    });

    expect(sockets[0].messages.some((m) => m.type === "aborted")).toBe(false);
    expect(reconnected.messages.some((m) => m.type === "aborted")).toBe(false);
    expect(sockets[2].messages.some((m) => m.type === "aborted")).toBe(false);

    sockets[0].ws.close();
    reconnected.ws.close();
    sockets[2].ws.close();
  });
});

describe("GameTableDO — leave before a hand starts", () => {
  it("does not abort during the waiting/ready phase; the seat just disconnects as it always has", async () => {
    const tableId = `t-leavewait-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("lwhost"),
      registerUser("lwp2"),
      registerUser("lwp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);

    const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];

    // Nobody has readied up yet — no hand in progress, so 'leave' is a no-op
    // beyond the normal disconnect bookkeeping that follows the close below.
    send(sockets[0], { type: "leave" });
    sockets[0].ws.close();
    await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.seats[0].connected === false);

    // The seat is still reserved for this user to come back to — nothing in
    // the codebase ever deletes a `seats` row today, so "frees the seat"
    // here means the existing disconnect bookkeeping (shows disconnected,
    // same user can reconnect), not a new seat-removal feature; adding one
    // was out of scope for this change.
    const rejoined = await openTableSocket(tableId, host.cookie);
    const rejoinState = await rejoined.nextFrameMatching((m) => m.type === "state");
    expect(asStateMessage(rejoinState)!.seats[0]).toMatchObject({ userId: host.id, connected: true });

    expect(sockets[1].messages.some((m) => m.type === "aborted")).toBe(false);
    expect(sockets[2].messages.some((m) => m.type === "aborted")).toBe(false);

    rejoined.ws.close();
    sockets[1].ws.close();
    sockets[2].ws.close();
  });
});
