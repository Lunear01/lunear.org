import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  applyAction,
  createGame,
  createDeck,
  settle,
  type Action,
  type Card,
  type GameState,
  type RedactedBettingView,
  type RedactedFinishedView,
  type RedactedShowdownView,
  type Seat,
} from "poker";
import { describe, expect, it } from "vitest";
import type { NextHandMessage, ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/poker-protocol";

const STAKE = 10;
const GAME_ID = "poker";

// --- User / table setup helpers, mirroring test/game-table.test.ts's and
// test/liarsbar-table.test.ts's conventions -------------------------------

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

async function ledgerRowsForHand(tableId: string, handNo: number) {
  return env.DB.prepare(
    `SELECT user_id as userId, amount, idempotency_key as idempotencyKey
     FROM credit_ledger WHERE idempotency_key LIKE ?`,
  )
    .bind(`settle:${tableId}:${handNo}:%`)
    .all<{ userId: string; amount: number; idempotencyKey: string }>();
}

// --- Frame queue --------------------------------------------------------------
// Mirrors game-table.test.ts's / liarsbar-table.test.ts's FrameQueue exactly:
// a forward-scanning cursor (not a stateless `messages.find(pred)`), which
// matters here too — a poker 'state' broadcast recurs with the same
// currentTurn value across different streets (e.g. seat 1 acts first on
// every postflop street), so a predicate must be scoped by phase as well
// wherever that ambiguity is real. `raw` keeps the untouched wire text
// alongside each parsed message, index-for-index, for the redaction test's
// "grep the raw frame" requirement.

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

function asNextHandMessage(m: ServerMessage): NextHandMessage | null {
  return m.type === "nextHand" ? m : null;
}

/** Non-null only for a live betting street (preflop/flop/turn/river). */
function bettingView(m: ServerMessage): RedactedBettingView | null {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase === "showdown" || s.view.phase === "finished") return null;
  return s.view;
}

function showdownView(m: ServerMessage): RedactedShowdownView | null {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "showdown") return null;
  return s.view;
}

function finishedView(m: ServerMessage): RedactedFinishedView | null {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "finished") return null;
  return s.view;
}

/**
 * Readies every socket but the last (waiting for each one's own ready-ack
 * broadcast), leaving the caller to send the LAST seat's ready explicitly —
 * that message is the one that actually triggers startNewHand(), whose
 * broadcast never contains a `ready: true` for the seat that just triggered
 * it (ready flags are reset to false as part of dealing), so it can't be
 * waited for the same way the earlier ones are.
 */
async function readyAllButLast(sockets: readonly FrameQueue[]): Promise<void> {
  for (let i = 0; i < sockets.length - 1; i++) {
    send(sockets[i], { type: "ready" });
    await sockets[i].nextFrameMatching((m) => asStateMessage(m)?.seats[i]?.ready === true);
  }
}

// --- Scripted deck --------------------------------------------------------
//
// Builds a full, valid 52-card deck with specific hole cards (block-dealt in
// ascending seat order, per games/poker/src/deal.ts's dealHoleCards) and a
// specific 5-card board (dealt straight off the remaining deck in flop/turn/
// river order), with every other card filled in afterward in arbitrary
// (but valid, unique) order — never actually reached since these tests never
// deal more than 6 hole cards + 5 board cards out of the 52.
function buildDeck(seatHoles: ReadonlyArray<readonly [Seat, string, string]>, board: readonly string[]): Card[] {
  const full = createDeck();
  const byId = new Map(full.map((c) => [c.id, c] as const));
  const sorted = seatHoles.slice().sort((a, b) => a[0] - b[0]);
  const usedIds = [...sorted.flatMap(([, a, b]) => [a, b]), ...board];
  const usedSet = new Set(usedIds);
  const rest = full.filter((c) => !usedSet.has(c.id)).map((c) => c.id);
  return [...usedIds, ...rest].map((id) => {
    const card = byId.get(id);
    if (!card) throw new Error(`buildDeck: missing card ${id}`);
    return card;
  });
}

/**
 * Independently replays a scripted action sequence through the pure engine
 * (never through the DO) to derive the expected settlement deltas — this
 * keeps every settlement assertion below from being tautological (comparing
 * the DO's own settle() output to itself). An auto-fold the DO applies on a
 * leaving seat's behalf is represented here as an ordinary `{type:'fold'}`
 * step at the point it occurs — functionally identical to a player-chosen
 * fold as far as the engine (and thus settle()) is concerned.
 */
function expectedDeltasFromReplay(
  seats: readonly Seat[],
  dealerSeat: Seat,
  stake: number,
  deck: Card[],
  steps: ReadonlyArray<readonly [Seat, Action]>,
): Readonly<Record<Seat, number>> {
  function applyOrThrow(state: GameState, seat: Seat, action: Action): GameState {
    const result = applyAction(state, seat, action);
    if (!result.ok) {
      throw new Error(`unexpected rejection in replay: seat ${seat} ${JSON.stringify(action)} -> ${result.reason}`);
    }
    return result.state;
  }
  let state: GameState = createGame({ seats, dealerSeat, stake, shuffledDeck: deck });
  for (const [seat, action] of steps) state = applyOrThrow(state, seat, action);
  if (state.phase !== "showdown" && state.phase !== "finished") {
    throw new Error(`replay did not reach a hand-over state (phase=${state.phase})`);
  }
  return settle(state);
}

/**
 * Connects 3 sockets, readies all of them, and plays a fixed 10-action
 * script to showdown: preflop call/call/check, a flop bet/call/fold (seat0
 * folds — never reaches showdown), and checks through turn/river. Requires
 * hole cards [0,1,2] and board exactly as built by buildDeck() with THIS
 * exact seat/board assignment (callers below always use the SAME deck shape
 * for this reason). Returns the sockets (raw/messages logs intact for the
 * redaction test) and the very first preflop view, for the blind/turn-order
 * assertions.
 */
async function playToShowdown(
  tableId: string,
  cookies: readonly [string, string, string],
): Promise<{ sockets: [FrameQueue, FrameQueue, FrameQueue]; preflopView: RedactedBettingView }> {
  const sockets: [FrameQueue, FrameQueue, FrameQueue] = [
    await openTableSocket(tableId, cookies[0]),
    await openTableSocket(tableId, cookies[1]),
    await openTableSocket(tableId, cookies[2]),
  ];
  await readyAllButLast(sockets);
  send(sockets[2], { type: "ready" });
  const preflopView = bettingView(
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0),
  )!;

  send(sockets[0], { type: "call" });
  await sockets[1].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "call" });
  await sockets[2].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 2);
  send(sockets[2], { type: "check" }); // closes preflop -> flop dealt

  await sockets[1].nextFrameMatching((m) => bettingView(m)?.phase === "flop" && bettingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "bet", amount: STAKE });
  await sockets[2].nextFrameMatching((m) => bettingView(m)?.phase === "flop" && bettingView(m)?.currentTurn === 2);
  send(sockets[2], { type: "call" });
  await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "flop" && bettingView(m)?.currentTurn === 0);
  send(sockets[0], { type: "fold" }); // closes flop -> turn dealt (seat0 out for good)

  await sockets[1].nextFrameMatching((m) => bettingView(m)?.phase === "turn" && bettingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "check" });
  await sockets[2].nextFrameMatching((m) => bettingView(m)?.phase === "turn" && bettingView(m)?.currentTurn === 2);
  send(sockets[2], { type: "check" }); // closes turn -> river dealt

  await sockets[1].nextFrameMatching((m) => bettingView(m)?.phase === "river" && bettingView(m)?.currentTurn === 1);
  send(sockets[1], { type: "check" });
  await sockets[2].nextFrameMatching((m) => bettingView(m)?.phase === "river" && bettingView(m)?.currentTurn === 2);
  send(sockets[2], { type: "check" }); // closes river -> showdown

  await sockets[1].nextFrameMatching((m) => m.type === "settled");

  return { sockets, preflopView };
}

const SHOWDOWN_HOLES: ReadonlyArray<readonly [Seat, string, string]> = [
  [0, "2c", "3c"],
  [1, "Ah", "As"],
  [2, "Kh", "Kd"],
];
const SHOWDOWN_BOARD = ["2h", "7d", "9s", "Jc", "4d"];
const SHOWDOWN_SCRIPT: ReadonlyArray<readonly [Seat, Action]> = [
  [0, { type: "call" }],
  [1, { type: "call" }],
  [2, { type: "check" }],
  [1, { type: "bet", amount: STAKE }],
  [2, { type: "call" }],
  [0, { type: "fold" }],
  [1, { type: "check" }],
  [2, { type: "check" }],
  [1, { type: "check" }],
  [2, { type: "check" }],
];

// --- Tests --------------------------------------------------------------------

describe("PokerTableDO — 3-player scripted hand to showdown", () => {
  it("ready -> blinds/turn order -> scripted bets -> showdown reveal -> exact D1 deltas -> ledger idempotency -> zero-sum", async () => {
    const tableId = `t-full-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([registerUser("pkfhost"), registerUser("pkfp2"), registerUser("pkfp3")]);
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(SHOWDOWN_HOLES, SHOWDOWN_BOARD);
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const users = [host, p2, p3] as const;
    const before = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );

    const { sockets, preflopView } = await playToShowdown(tableId, [host.cookie, p2.cookie, p3.cookie]);

    // Dealer=0, 3-handed: SB=seat1 (5), BB=seat2 (10), first to act preflop=seat0.
    expect(preflopView).toMatchObject({ phase: "preflop", dealerSeat: 0, currentTurn: 0, currentBet: STAKE });
    expect(preflopView.players[1]).toMatchObject({ committed: 5, streetCommitted: 5 });
    expect(preflopView.players[2]).toMatchObject({ committed: STAKE, streetCommitted: STAKE });

    const settledMsg = sockets[1].messages.find((m) => m.type === "settled") as SettledMessage | undefined;
    expect(settledMsg).toBeDefined();
    expect(settledMsg!.handNo).toBe(1);

    const expected = expectedDeltasFromReplay([0, 1, 2], 0, STAKE, deck, SHOWDOWN_SCRIPT);
    expect(settledMsg!.deltas).toEqual(expected);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);

    for (let i = 0; i < users.length; i++) {
      const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(users[i].id)
        .first<{ credits: number }>();
      expect(row!.credits).toBe(before[i]!.credits + expected[i]);
    }

    const ledger = await ledgerRowsForHand(tableId, 1);
    expect(ledger.results).toHaveLength(3);
    for (let i = 0; i < users.length; i++) {
      const row = ledger.results!.find((r) => r.userId === users[i].id);
      expect(row).toBeDefined();
      expect(row!.amount).toBe(expected[i]);
      expect(row!.idempotencyKey).toBe(`settle:${tableId}:1:${users[i].id}`);
    }

    const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(`${tableId}:1`)
      .first<{ table_id: string; round: number; game_id: string; stake: number }>();
    expect(gameRow?.table_id).toBe(tableId);
    expect(gameRow?.round).toBe(1);
    expect(gameRow?.game_id).toBe("poker");
    expect(gameRow?.stake).toBe(STAKE);

    // Showdown reveal: seat0 folded and is never revealed; seat1 (aces) beats seat2 (kings).
    const sv = showdownView(await sockets[1].nextFrameMatching((m) => showdownView(m) !== null))!;
    expect(sv.reveals.map((r) => r.seat).sort()).toEqual([1, 2]);
    expect(sv.winners).toEqual([1]);
    expect(sv.amountWon).toEqual({ 0: 0, 1: 50, 2: 0 });

    for (const s of sockets) s.ws.close();
  });
});

describe("PokerTableDO — redaction", () => {
  it("never sends a seat another seat's hole cards in any pre-showdown frame", async () => {
    const tableId = `t-redact-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([registerUser("pkdhost"), registerUser("pkdp2"), registerUser("pkdp3")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(SHOWDOWN_HOLES, SHOWDOWN_BOARD);
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const { sockets } = await playToShowdown(tableId, [host.cookie, p2.cookie, p3.cookie]);

    const holesBySeat = new Map(SHOWDOWN_HOLES.map(([seat, a, b]) => [seat, [a, b]] as const));
    for (let seat = 0; seat < 3; seat++) {
      const socket = sockets[seat];
      const othersCardIds = [...holesBySeat.entries()].filter(([s]) => s !== seat).flatMap(([, cards]) => cards);

      for (let i = 0; i < socket.messages.length; i++) {
        if (bettingView(socket.messages[i]) === null) continue; // only pre-showdown frames
        const raw = socket.raw[i];
        for (const id of othersCardIds) {
          expect(raw).not.toContain(`"${id}"`);
        }
      }
    }

    for (const s of sockets) s.ws.close();
  });
});

describe("PokerTableDO — heads-up blind inversion and fold-out", () => {
  it("dealer posts the small blind and acts first preflop; folding ends the hand with no reveal", async () => {
    const tableId = `t-headsup-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("pkhuhost"), registerUser("pkhup2")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(
      [
        [0, "2c", "3c"],
        [1, "Ah", "As"],
      ],
      SHOWDOWN_BOARD,
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const users = [host, p2] as const;
    const before = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );

    const sockets = [await openTableSocket(tableId, host.cookie), await openTableSocket(tableId, p2.cookie)];
    await readyAllButLast(sockets);
    send(sockets[1], { type: "ready" });
    const preflop = bettingView(
      await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0),
    )!;

    // Heads-up inversion: dealer (seat0) posts the SMALL blind, seat1 posts the BIG blind, and
    // the dealer acts first preflop — the opposite of the 3+-handed table above.
    expect(preflop.dealerSeat).toBe(0);
    expect(preflop.currentTurn).toBe(0);
    expect(preflop.players[0]).toMatchObject({ committed: 5, streetCommitted: 5 });
    expect(preflop.players[1]).toMatchObject({ committed: STAKE, streetCommitted: STAKE });

    send(sockets[0], { type: "fold" });
    const settledMsg = (await sockets[1].nextFrameMatching((m) => m.type === "settled")) as SettledMessage;

    const expected = expectedDeltasFromReplay([0, 1], 0, STAKE, deck, [[0, { type: "fold" }]]);
    expect(expected).toEqual({ 0: -5, 1: 5 });
    expect(settledMsg.deltas).toEqual(expected);

    for (let i = 0; i < users.length; i++) {
      const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(users[i].id)
        .first<{ credits: number }>();
      expect(row!.credits).toBe(before[i]!.credits + expected[i]);
    }

    // No reveal in a fold-out finish.
    const finishedFrame = await sockets[1].nextFrameMatching((m) => finishedView(m) !== null);
    const fv = finishedView(finishedFrame)!;
    expect(fv.winner).toBe(1);
    expect((fv as unknown as Record<string, unknown>).reveals).toBeUndefined();
    expect((fv as unknown as Record<string, unknown>).holeCards).toBeUndefined();
    const rawIndex = sockets[1].messages.indexOf(finishedFrame);
    expect(sockets[1].raw[rawIndex]).not.toMatch(/"(2c|3c|Ah|As)"/);

    sockets[0].ws.close();
    sockets[1].ws.close();
  });
});

describe("PokerTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const tableId = `t-once-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("pk1host"), registerUser("pk1p2")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(
      [
        [0, "2c", "3c"],
        [1, "Ah", "As"],
      ],
      SHOWDOWN_BOARD,
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const users = [host, p2] as const;
    const sockets = [await openTableSocket(tableId, host.cookie), await openTableSocket(tableId, p2.cookie)];
    await readyAllButLast(sockets);
    send(sockets[1], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);
    send(sockets[0], { type: "fold" });
    await sockets[1].nextFrameMatching((m) => m.type === "settled");
    sockets[0].ws.close();
    sockets[1].ws.close();

    const afterFirst = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );
    const ledgerAfterFirst = await ledgerRowsForHand(tableId, 1);
    expect(ledgerAfterFirst.results).toHaveLength(2);

    // Simulate a crash between "the D1 batch committed" and "the local
    // settled flag was persisted": flip the flag back so a forced retry
    // genuinely re-attempts the D1 batch and must be saved by the
    // credit_ledger UNIQUE idempotency_key, not by the local flag alone.
    await runInDurableObject(stub, async (_instance, doState) => {
      doState.storage.sql.exec("UPDATE game_state SET settled = 0 WHERE id = 1");
    });

    await expect(stub.forceSettle()).resolves.toBeUndefined();

    const afterRetry = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );
    expect(afterRetry).toEqual(afterFirst);
    const ledgerAfterRetry = await ledgerRowsForHand(tableId, 1);
    expect(ledgerAfterRetry.results).toHaveLength(2);
  });
});

describe("PokerTableDO — mid-hand leave auto-folds without ending the hand", () => {
  it("marks leave-pending, auto-folds the moment action reaches them, settles correctly for the others, frees the seat after settlement", async () => {
    const tableId = `t-midleave-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([registerUser("pklhost"), registerUser("pklp2"), registerUser("pklp3")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(
      [
        [0, "Ah", "As"],
        [1, "2c", "3c"],
        [2, "Kh", "Kd"],
      ],
      SHOWDOWN_BOARD,
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const sockets = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyAllButLast(sockets);
    send(sockets[2], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    const users = [host, p2, p3] as const;
    const before = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );

    // Seat1 leaves while it's seat0's turn — not their own turn yet.
    send(sockets[1], { type: "leave" });
    const pending = await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.leavePending === true);
    expect(asStateMessage(pending)!.seats[1]).toMatchObject({ userId: p2.id, leavePending: true });
    // Nothing has changed hands yet — still seat0's turn, seat1 not folded.
    expect(bettingView(pending)?.currentTurn).toBe(0);
    expect(bettingView(pending)?.players[1].folded).toBe(false);

    // Seat0 acts; the auto-fold cascade skips seat1 entirely — action lands directly on seat2.
    send(sockets[0], { type: "call" });
    const afterCall = bettingView(await sockets[2].nextFrameMatching((m) => bettingView(m)?.currentTurn === 2))!;
    expect(afterCall.players[1].folded).toBe(true);

    send(sockets[2], { type: "check" }); // closes preflop -> flop dealt
    for (let i = 0; i < 3; i++) {
      await sockets[2].nextFrameMatching((m) => bettingView(m)?.currentTurn === 2);
      send(sockets[2], { type: "check" });
      await sockets[0].nextFrameMatching((m) => bettingView(m)?.currentTurn === 0);
      send(sockets[0], { type: "check" });
    }

    const settledMsg = (await sockets[0].nextFrameMatching((m) => m.type === "settled")) as SettledMessage;
    const expected = expectedDeltasFromReplay(
      [0, 1, 2],
      0,
      STAKE,
      deck,
      [
        [0, { type: "call" }],
        [1, { type: "fold" }],
        [2, { type: "check" }],
        [2, { type: "check" }],
        [0, { type: "check" }],
        [2, { type: "check" }],
        [0, { type: "check" }],
        [2, { type: "check" }],
        [0, { type: "check" }],
      ],
    );
    expect(settledMsg.deltas).toEqual(expected);
    expect(expected[1]).toBe(-5); // leaver's delta = exactly their forfeited small-blind contribution
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);

    for (let i = 0; i < users.length; i++) {
      const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(users[i].id)
        .first<{ credits: number }>();
      expect(row!.credits).toBe(before[i]!.credits + expected[i]);
    }

    const ledger = await ledgerRowsForHand(tableId, 1);
    expect(ledger.results).toHaveLength(3);

    // Seat freed after settlement: the very next ready-phase state shows it open.
    const afterSettle = await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.userId === null);
    expect(asStateMessage(afterSettle)!.seats[1]).toMatchObject({ userId: null, username: null, leavePending: false });

    sockets[0].ws.close();
    sockets[2].ws.close();
  });
});

describe("PokerTableDO — disconnect + reconnect within grace", () => {
  it("cancels the pending fold; play continues with the reconnected seat acting for itself", async () => {
    const tableId = `t-gracecancel-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([registerUser("pkgchost"), registerUser("pkgcp2"), registerUser("pkgcp3")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(SHOWDOWN_HOLES, SHOWDOWN_BOARD);
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const sockets = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyAllButLast(sockets);
    send(sockets[2], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    send(sockets[0], { type: "call" });
    await sockets[1].nextFrameMatching((m) => bettingView(m)?.currentTurn === 1);

    // Seat1 disconnects exactly on their own turn.
    sockets[1].ws.close(1000, "network drop");
    await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.connected === false);

    // Reconnects promptly (well inside the 30s grace).
    const s1 = await openTableSocket(tableId, p2.cookie);
    await s1.nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.connected === true);

    // The pending grace timer was actually cancelled, not just not-yet-fired.
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(false);

    // Play continues normally: seat1 calls for themselves — no forced fold ever happened.
    send(s1, { type: "call" });
    const afterCall = bettingView(await sockets[2].nextFrameMatching((m) => bettingView(m)?.currentTurn === 2))!;
    expect(afterCall.players[1].folded).toBe(false);

    sockets[0].ws.close();
    s1.ws.close();
    sockets[2].ws.close();
  });
});

describe("PokerTableDO — disconnect grace expiry", () => {
  it("auto-folds once the grace alarm fires for a seat that never reconnected, then frees it after settlement", async () => {
    const tableId = `t-graceexpire-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([registerUser("pkgehost"), registerUser("pkgep2"), registerUser("pkgep3")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(
      [
        [0, "Ah", "As"],
        [1, "2c", "3c"],
        [2, "Kh", "Kd"],
      ],
      SHOWDOWN_BOARD,
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const sockets = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyAllButLast(sockets);
    send(sockets[2], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    send(sockets[0], { type: "call" });
    await sockets[1].nextFrameMatching((m) => bettingView(m)?.currentTurn === 1);

    // Seat1 disconnects on their own turn and never reconnects.
    sockets[1].ws.close(1000, "network drop");
    await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.connected === false);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Auto-folded the instant the grace expired (it was already their turn).
    const afterFold = bettingView(await sockets[2].nextFrameMatching((m) => bettingView(m)?.currentTurn === 2))!;
    expect(afterFold.players[1].folded).toBe(true);

    send(sockets[2], { type: "check" }); // closes preflop -> flop dealt
    for (let i = 0; i < 3; i++) {
      await sockets[2].nextFrameMatching((m) => bettingView(m)?.currentTurn === 2);
      send(sockets[2], { type: "check" });
      await sockets[0].nextFrameMatching((m) => bettingView(m)?.currentTurn === 0);
      send(sockets[0], { type: "check" });
    }

    const settledMsg = (await sockets[0].nextFrameMatching((m) => m.type === "settled")) as SettledMessage;
    const expected = expectedDeltasFromReplay(
      [0, 1, 2],
      0,
      STAKE,
      deck,
      [
        [0, { type: "call" }],
        [1, { type: "fold" }],
        [2, { type: "check" }],
        [2, { type: "check" }],
        [0, { type: "check" }],
        [2, { type: "check" }],
        [0, { type: "check" }],
        [2, { type: "check" }],
        [0, { type: "check" }],
      ],
    );
    expect(settledMsg.deltas).toEqual(expected);
    expect(expected[1]).toBe(-5);

    const afterSettle = await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.userId === null);
    expect(asStateMessage(afterSettle)!.seats[1]).toMatchObject({ userId: null, leavePending: false });

    sockets[0].ws.close();
    sockets[2].ws.close();
  });
});

describe("PokerTableDO — drop-in and auto-deal between hands", () => {
  it("lets a new user take the open seat between hands, then auto-deals the next hand (dealer rotated) once the alarm fires", async () => {
    const tableId = `t-dropin-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3, p4] = await Promise.all([
      registerUser("pkdihost"),
      registerUser("pkdip2"),
      registerUser("pkdip3"),
      registerUser("pkdip4"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    // Hand 1: a fast fold-fold to seat2 — deck content beyond the hole cards
    // is irrelevant since nobody reaches showdown.
    const deck1 = buildDeck(
      [
        [0, "2c", "3c"],
        [1, "4c", "5c"],
        [2, "6c", "7c"],
      ],
      ["8c", "9c", "Tc", "Jc", "Qc"],
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck1, dealerSeat: 0 });

    const sockets: FrameQueue[] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyAllButLast(sockets);
    send(sockets[2], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    send(sockets[0], { type: "fold" });
    await sockets[1].nextFrameMatching((m) => bettingView(m)?.currentTurn === 1);
    send(sockets[1], { type: "fold" }); // only seat2 remains -> finished, no showdown
    await sockets[2].nextFrameMatching((m) => m.type === "settled");

    // The between-hands countdown starts right after settlement (this is
    // hand 1 -> hand 2, not the table's first-ever hand, so the manual
    // ready-up path no longer applies at all from here on).
    const nextHand = asNextHandMessage(await sockets[2].nextFrameMatching((m) => asNextHandMessage(m) !== null))!;
    expect(nextHand.at).toBeGreaterThanOrEqual(Date.now());

    // Seat0 never posted anything (UTG fold) — its zero delta is skipped.
    const ledger1 = await ledgerRowsForHand(tableId, 1);
    expect(ledger1.results).toHaveLength(2);

    // A 4th user connects between hands and takes the only open seat (3).
    const s4 = await openTableSocket(tableId, p4.cookie);
    const joinedState = await s4.nextFrameMatching((m) => asStateMessage(m) !== null);
    expect(asStateMessage(joinedState)!.seats[3]).toMatchObject({ userId: p4.id, ready: false });

    const allSockets = [...sockets, s4];

    // A stray 'ready' during the countdown is a harmless no-op: it must not
    // start hand 2 early (there's no ready-ack broadcast to wait for here —
    // that's the point).
    send(allSockets[0], { type: "ready" });

    // The alarm fires the auto-deal: all 4 seats are connected, so hand 2
    // deals immediately with the dealer rotated (hand 1's dealer was seat0
    // -> next occupied seat > 0 among [0,1,2,3] is seat1).
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const hand2Preflop = bettingView(
      await allSockets[0].nextFrameMatching((m) => asStateMessage(m)?.handNo === 2 && bettingView(m) !== null),
    )!;
    expect(hand2Preflop.dealerSeat).toBe(1);
    expect(hand2Preflop.seats).toEqual([0, 1, 2, 3]);

    for (const s of allSockets) s.ws.close();
  });
});

describe("PokerTableDO — auto-deal skips a disconnected-but-seated occupant", () => {
  it("keeps a seat that's disconnected across settlement but leaves it out of the auto-dealt next hand", async () => {
    const tableId = `t-autoskip-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("pkashost"),
      registerUser("pkasp2"),
      registerUser("pkasp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck1 = buildDeck(
      [
        [0, "2c", "3c"],
        [1, "4c", "5c"],
        [2, "6c", "7c"],
      ],
      ["8c", "9c", "Tc", "Jc", "Qc"],
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck1, dealerSeat: 0 });

    const sockets: FrameQueue[] = [
      await openTableSocket(tableId, host.cookie),
      await openTableSocket(tableId, p2.cookie),
      await openTableSocket(tableId, p3.cookie),
    ];
    await readyAllButLast(sockets);
    send(sockets[2], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    // Seat2 (the big blind) disconnects mid-hand, before their turn is ever
    // reached: they're never marked leave-pending (their 30s grace never
    // expires) and the hand ends by the other two folding around them, so
    // their disconnect-grace row is silently cancelled at settlement (see
    // trySettle's unconditional `DELETE FROM pending_disconnects`) rather
    // than ever firing. This is the only way a seat can genuinely be
    // disconnected-but-seated once a hand has settled: a disconnect
    // happening DURING the between-hands countdown itself frees the seat
    // immediately instead (see the file header's "leave/exit during the
    // countdown works normally" rule).
    sockets[2].ws.close(1000, "network drop");
    await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[2]?.connected === false);

    send(sockets[0], { type: "fold" });
    await sockets[1].nextFrameMatching((m) => bettingView(m)?.currentTurn === 1);
    send(sockets[1], { type: "fold" }); // only seat2 remains -> finished, uncontested
    await sockets[0].nextFrameMatching((m) => m.type === "settled");
    await sockets[0].nextFrameMatching((m) => asNextHandMessage(m) !== null);

    // Seat2 is still seated (never freed) but shows disconnected.
    const afterSettle = asStateMessage(await sockets[0].nextFrameMatching((m) => asStateMessage(m) !== null))!;
    expect(afterSettle.seats[2]).toMatchObject({ userId: p3.id, connected: false });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Hand 2 deals only the two connected seats — dealer rotates among just
    // those (hand 1's dealer was seat0 -> next occupied seat > 0 among
    // [0, 1] is seat1) — while seat2's occupant stays seated but out of play.
    const hand2 = asStateMessage(await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.handNo === 2))!;
    expect(bettingView(hand2)?.dealerSeat).toBe(1);
    expect(bettingView(hand2)?.seats).toEqual([0, 1]);
    expect(hand2.seats[2]).toMatchObject({ userId: p3.id, connected: false });

    // Seat2's occupant can still reconnect mid-hand-they're-not-in: the
    // engine's viewFor would throw for a seat outside state.seats during a
    // live betting street, so the DO sends a spectator-safe null view
    // instead (see viewForSeatOrSpectator) rather than crashing or leaking
    // another seat's hole cards.
    const s3reconnect = await openTableSocket(tableId, p3.cookie);
    const seat2State = asStateMessage(
      await s3reconnect.nextFrameMatching((m) => asStateMessage(m) !== null),
    )!;
    expect(seat2State.seats[2]).toMatchObject({ userId: p3.id, connected: true });
    expect(seat2State.view).toBeNull();

    sockets[0].ws.close();
    sockets[1].ws.close();
    s3reconnect.ws.close();
  });
});

describe("PokerTableDO — auto-deal falls back to manual ready-up under 2 connected occupants", () => {
  it("does not auto-deal when fewer than 2 occupied seats are connected at alarm-fire; ready-up still works afterward", async () => {
    const tableId = `t-fallback-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2, p3] = await Promise.all([
      registerUser("pkfbhost"),
      registerUser("pkfbp2"),
      registerUser("pkfbp3"),
    ]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck1 = buildDeck(
      [
        [0, "2c", "3c"],
        [1, "Ah", "As"],
      ],
      SHOWDOWN_BOARD,
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck1, dealerSeat: 0 });

    const sockets = [await openTableSocket(tableId, host.cookie), await openTableSocket(tableId, p2.cookie)];
    await readyAllButLast(sockets);
    send(sockets[1], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    send(sockets[0], { type: "fold" }); // heads-up: dealer folds -> seat1 wins uncontested
    await sockets[1].nextFrameMatching((m) => m.type === "settled");
    await sockets[1].nextFrameMatching((m) => asNextHandMessage(m) !== null);

    // Host leaves during the countdown — a leave during the countdown works
    // normally (frees the seat immediately, per the file header) — leaving
    // only 1 occupied, connected seat.
    send(sockets[0], { type: "leave" });
    await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.seats[0]?.userId === null);
    sockets[0].ws.close();

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Fewer than 2 connected occupants at fire time -> falls back to ready
    // phase: no new hand deals, handNo stays at 1.
    const afterAlarm = asStateMessage(await sockets[1].nextFrameMatching((m) => asStateMessage(m) !== null))!;
    expect(afterAlarm.handNo).toBe(1);
    expect(afterAlarm.seats[1]).toMatchObject({ userId: p2.id, ready: false });

    // Manual ready-up still works after the fallback: a 3rd player takes the
    // open seat and readying both of them up starts hand 2 the normal way.
    const s3 = await openTableSocket(tableId, p3.cookie);
    await s3.nextFrameMatching((m) => asStateMessage(m) !== null);

    send(sockets[1], { type: "ready" });
    await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.ready === true);
    send(s3, { type: "ready" });

    const hand2 = asStateMessage(await sockets[1].nextFrameMatching((m) => asStateMessage(m)?.handNo === 2))!;
    expect(hand2.seats.filter((s) => s.userId !== null)).toHaveLength(2);

    sockets[1].ws.close();
    s3.ws.close();
  });
});

describe("PokerTableDO — seat broadcasts carry live credit balances", () => {
  it("caches each seat's D1 credits on connect and refreshes them after settlement", async () => {
    const tableId = `t-credits-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("pkcrhost"), registerUser("pkcrp2")]);
    await initTable(tableId, host.cookie, STAKE);
    const stub = env.POKER_TABLE_DO.getByName(tableId);
    const deck = buildDeck(
      [
        [0, "2c", "3c"],
        [1, "Ah", "As"],
      ],
      SHOWDOWN_BOARD,
    );
    await stub.setTestFixedDeal({ shuffledDeck: deck, dealerSeat: 0 });

    const users = [host, p2] as const;
    const before = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );

    const sockets = [await openTableSocket(tableId, host.cookie), await openTableSocket(tableId, p2.cookie)];

    // Connect-time caching: the very first 'state' each seat sees already
    // carries its own occupant's real D1 balance, not a stale/zero default.
    const joined0 = asStateMessage(await sockets[0].nextFrameMatching((m) => asStateMessage(m) !== null))!;
    expect(joined0.seats[0].credits).toBe(before[0]!.credits);

    await readyAllButLast(sockets);
    send(sockets[1], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => bettingView(m)?.phase === "preflop" && bettingView(m)?.currentTurn === 0);

    send(sockets[0], { type: "fold" }); // heads-up fold-out -> seat1 wins uncontested
    await sockets[1].nextFrameMatching((m) => m.type === "settled");

    const afterSettle = asStateMessage(await sockets[0].nextFrameMatching((m) => asStateMessage(m) !== null))!;
    const after = await Promise.all(
      users.map((u) => env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>()),
    );
    const expected = expectedDeltasFromReplay([0, 1], 0, STAKE, deck, [[0, { type: "fold" }]]);

    // Broadcast credits right after settlement match the real, post-delta D1
    // balances for BOTH seats — the refresh is one batched query covering
    // every seated userId, not just the acting seat.
    expect(afterSettle.seats[0].credits).toBe(after[0]!.credits);
    expect(afterSettle.seats[1].credits).toBe(after[1]!.credits);
    expect(after[0]!.credits).toBe(before[0]!.credits + expected[0]);
    expect(after[1]!.credits).toBe(before[1]!.credits + expected[1]);

    sockets[0].ws.close();
    sockets[1].ws.close();
  });
});
