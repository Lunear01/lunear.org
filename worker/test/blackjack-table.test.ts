import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  applyAction,
  createGame,
  createShoe,
  settle,
  type Action,
  type Card,
  type GameState,
  type RedactedActingView,
  type RedactedFinishedView,
  type Seat,
} from "blackjack";
import { describe, expect, it } from "vitest";
import type { NextHandMessage, ServerMessage, SettledMessage, StateMessage } from "../src/durable-objects/blackjack-protocol";

const STAKE = 10;
const GAME_ID = "blackjack";

// --- User / table setup helpers, mirroring test/poker-table.test.ts's conventions ---

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
  return attachFrameQueue(ws);
}

function send(socket: FrameQueue, msg: Record<string, unknown>): void {
  socket.ws.send(JSON.stringify(msg));
}

async function ledgerRowsForRound(tableId: string, handNo: number) {
  return env.DB.prepare(
    `SELECT user_id as userId, amount, idempotency_key as idempotencyKey
     FROM credit_ledger WHERE idempotency_key LIKE ?`,
  )
    .bind(`settle:${tableId}:${handNo}:%`)
    .all<{ userId: string; amount: number; idempotencyKey: string }>();
}

async function creditsOf(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(userId).first<{ credits: number }>();
  return row!.credits;
}

// --- Frame queue (same forward-scanning cursor as the other table DO tests) ---

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

function actingView(m: ServerMessage): RedactedActingView | null {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "acting") return null;
  return s.view;
}

function finishedView(m: ServerMessage): RedactedFinishedView | null {
  const s = asStateMessage(m);
  if (!s || !s.view || s.view.phase !== "finished") return null;
  return s.view;
}

/** Readies every socket but the last — the last seat's ready is what actually deals (see poker-table.test.ts). */
async function readyAllButLast(sockets: readonly FrameQueue[]): Promise<void> {
  for (let i = 0; i < sockets.length - 1; i++) {
    send(sockets[i], { type: "ready" });
    await sockets[i].nextFrameMatching((m) => asStateMessage(m)?.seats[i]?.ready === true);
  }
}

// --- Scripted shoe --------------------------------------------------------
//
// Shoe cards carry a deck index in their id ("As#2"), so scripts name cards
// by plain label and this builder hands out the next unused instance from a
// 3-deck pool. Order matches the engine's consumption exactly: seat blocks
// ascending, dealer's two, then draws in draw order; the pool's remaining
// cards pad the shoe past the engine's minimum.
function buildShoe(
  hands: ReadonlyArray<readonly [Seat, string, string]>,
  dealer: readonly [string, string],
  draws: readonly string[] = [],
): Card[] {
  const byLabel = new Map<string, Card[]>();
  for (const card of createShoe(3)) {
    const label = card.id.slice(0, card.id.indexOf("#"));
    const list = byLabel.get(label) ?? [];
    list.push(card);
    byLabel.set(label, list);
  }
  const take = (label: string): Card => {
    const card = byLabel.get(label)?.shift();
    if (!card) throw new Error(`buildShoe: pool exhausted or unknown label ${label}`);
    return card;
  };
  const sorted = hands.slice().sort((a, b) => a[0] - b[0]);
  const order = [
    ...sorted.flatMap(([, a, b]) => [take(a), take(b)]),
    take(dealer[0]),
    take(dealer[1]),
    ...draws.map(take),
  ];
  return [...order, ...[...byLabel.values()].flat()];
}

/**
 * Independently replays a scripted action sequence through the pure engine
 * to derive the expected deltas — keeps the settlement assertions below from
 * comparing the DO's settle() output to itself. A DO-side auto-stand for a
 * leaving seat appears here as an ordinary {type:'stand'} step.
 */
function expectedDeltasFromReplay(
  seats: readonly Seat[],
  stake: number,
  shoe: Card[],
  steps: ReadonlyArray<readonly [Seat, Action]>,
): Readonly<Record<Seat, number>> {
  let state: GameState = createGame({ seats, stake, shuffledShoe: shoe });
  for (const [seat, action] of steps) {
    const result = applyAction(state, seat, action);
    if (!result.ok) {
      throw new Error(`unexpected rejection in replay: seat ${seat} ${JSON.stringify(action)} -> ${result.reason}`);
    }
    state = result.state;
  }
  if (state.phase !== "finished") throw new Error(`replay did not finish the round (phase=${state.phase})`);
  return settle(state);
}

// --- Tests --------------------------------------------------------------------

describe("BlackjackTableDO — solo scripted round", () => {
  it("solo ready deals immediately; double down -> dealer draws -> exact D1 delta, ledger row, hole-card redaction, mid-round join refused", async () => {
    const tableId = `bj-solo-${crypto.randomUUID().slice(0, 8)}`;
    const [host, outsider] = await Promise.all([registerUser("bjshost"), registerUser("bjsout")]);
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.BLACKJACK_TABLE_DO.getByName(tableId);
    // Player 5c+6c (11) doubles into Th (21); dealer 2d+3d draws 4h,5h,6h to 20.
    const shoe = buildShoe([[0, "5c", "6c"]], ["2d", "3d"], ["Th", "4h", "5h", "6h"]);
    await stub.setTestFixedDeal({ shuffledShoe: shoe });

    const before = await creditsOf(host.id);

    const socket = await openTableSocket(tableId, host.cookie);
    send(socket, { type: "ready" });
    const acting = actingView(await socket.nextFrameMatching((m) => actingView(m) !== null))!;

    // MIN_SEATS_TO_START is 1: one ready seat deals the round. The dealer's
    // hole card (3d) must not appear anywhere while the up card (2d) does.
    expect(acting.currentTurn).toBe(0);
    expect(acting.dealerUpCard.id.startsWith("2d#")).toBe(true);
    expect(acting.players[0]).toMatchObject({ total: 11, bet: STAKE, done: false });
    for (let i = 0; i < socket.messages.length; i++) {
      if (actingView(socket.messages[i]) !== null) expect(socket.raw[i]).not.toContain('"3d#');
    }

    // A second user can't take a seat mid-round.
    const refused = await SELF.fetch(`http://example.com/api/tables/${GAME_ID}/${tableId}/ws`, {
      headers: { Upgrade: "websocket", cookie: outsider.cookie },
    });
    expect(refused.status).toBe(409);

    send(socket, { type: "double" });
    const settled = (await socket.nextFrameMatching((m) => m.type === "settled")) as SettledMessage;

    const expected = expectedDeltasFromReplay([0], STAKE, shoe, [[0, { type: "double" }]]);
    expect(expected).toEqual({ 0: 2 * STAKE }); // 21 beats the dealer's 20, doubled bet
    expect(settled.deltas).toEqual(expected);
    expect(settled.newBalance).toBe(before + 2 * STAKE);
    expect(await creditsOf(host.id)).toBe(before + 2 * STAKE);

    const fv = finishedView(await socket.nextFrameMatching((m) => finishedView(m) !== null))!;
    expect(fv.dealerTotal).toBe(20);
    expect(fv.dealerCards.some((c) => c.id.startsWith("3d#"))).toBe(true); // hole card revealed
    expect(fv.outcomes[0]).toBe("win");

    const ledger = await ledgerRowsForRound(tableId, 1);
    expect(ledger.results).toHaveLength(1);
    expect(ledger.results![0]).toMatchObject({
      userId: host.id,
      amount: 2 * STAKE,
      idempotencyKey: `settle:${tableId}:1:${host.id}`,
    });

    const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(`${tableId}:1`)
      .first<{ table_id: string; round: number; game_id: string; stake: number }>();
    expect(gameRow?.game_id).toBe("blackjack");
    expect(gameRow?.round).toBe(1);
    expect(gameRow?.stake).toBe(STAKE);

    socket.ws.close();
  });
});

describe("BlackjackTableDO — two seats, natural pays 3:2, not zero-sum", () => {
  it("skips the natural seat in turn order and pays both winners against the house", async () => {
    const tableId = `bj-multi-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("bjmhost"), registerUser("bjmp2")]);
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.BLACKJACK_TABLE_DO.getByName(tableId);
    // Seat0 natural (Ac+Kc); seat1 stands on 20 (Th+Jh); dealer stands on 18.
    const shoe = buildShoe(
      [
        [0, "Ac", "Kc"],
        [1, "Th", "Jh"],
      ],
      ["Ts", "8s"],
    );
    await stub.setTestFixedDeal({ shuffledShoe: shoe });

    const users = [host, p2] as const;
    const before = await Promise.all(users.map((u) => creditsOf(u.id)));

    const sockets = [await openTableSocket(tableId, host.cookie), await openTableSocket(tableId, p2.cookie)];
    await readyAllButLast(sockets);
    send(sockets[1], { type: "ready" });

    // The natural seat is done at the deal — the first turn is seat1's.
    const acting = actingView(await sockets[0].nextFrameMatching((m) => actingView(m) !== null))!;
    expect(acting.currentTurn).toBe(1);
    expect(acting.players[0]).toMatchObject({ natural: true, done: true });

    send(sockets[1], { type: "stand" });
    const settled = (await sockets[0].nextFrameMatching((m) => m.type === "settled")) as SettledMessage;

    const expected = expectedDeltasFromReplay([0, 1], STAKE, shoe, [[1, { type: "stand" }]]);
    expect(expected).toEqual({ 0: 15, 1: STAKE }); // floor(1.5 x 10) and a plain win
    expect(settled.deltas).toEqual(expected);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(25); // the house pays the difference

    for (let i = 0; i < users.length; i++) {
      expect(await creditsOf(users[i].id)).toBe(before[i] + expected[i]);
    }

    for (const s of sockets) s.ws.close();
  });
});

describe("BlackjackTableDO — dealer natural ends the round with no player action", () => {
  it("settles straight from the deal, then auto-deals the next round when the alarm fires", async () => {
    const tableId = `bj-dealernat-${crypto.randomUUID().slice(0, 8)}`;
    const host = await registerUser("bjdnhost");
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.BLACKJACK_TABLE_DO.getByName(tableId);
    const shoe = buildShoe([[0, "Th", "9h"]], ["Ad", "Kd"]);
    await stub.setTestFixedDeal({ shuffledShoe: shoe });

    const before = await creditsOf(host.id);
    const socket = await openTableSocket(tableId, host.cookie);
    send(socket, { type: "ready" });

    // No action was ever possible — 'settled' arrives off the ready itself.
    const settled = (await socket.nextFrameMatching((m) => m.type === "settled")) as SettledMessage;
    expect(settled.deltas).toEqual({ 0: -STAKE });
    expect(await creditsOf(host.id)).toBe(before - STAKE);

    // Broadcast order after settlement is settled -> nextHand -> state, so
    // consume the countdown frame before the finished view.
    const nextHand = asNextHandMessage(await socket.nextFrameMatching((m) => asNextHandMessage(m) !== null))!;
    expect(nextHand.at).toBeGreaterThanOrEqual(Date.now());

    const fv = finishedView(await socket.nextFrameMatching((m) => finishedView(m) !== null))!;
    expect(fv.dealerCards).toHaveLength(2);
    expect(fv.outcomes[0]).toBe("lose");

    // The auto-deal alarm keeps a solo connected player going: round 2 deals
    // (or, with a random shoe, may even settle instantly again) — either way
    // handNo advances.
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    await socket.nextFrameMatching((m) => asStateMessage(m)?.handNo === 2);

    socket.ws.close();
  });
});

describe("BlackjackTableDO — mid-round leave auto-stands, bet stays live", () => {
  it("stands the leaver when the turn reaches them, still pays their winning hand, frees the seat after settlement", async () => {
    const tableId = `bj-leave-${crypto.randomUUID().slice(0, 8)}`;
    const [host, p2] = await Promise.all([registerUser("bjlhost"), registerUser("bjlp2")]);
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.BLACKJACK_TABLE_DO.getByName(tableId);
    // Seat0 stands on 19; seat1 (the leaver) holds 20; dealer stands on 17.
    const shoe = buildShoe(
      [
        [0, "Tc", "9c"],
        [1, "Th", "Jh"],
      ],
      ["Td", "7d"],
    );
    await stub.setTestFixedDeal({ shuffledShoe: shoe });

    const before = await creditsOf(p2.id);
    const sockets = [await openTableSocket(tableId, host.cookie), await openTableSocket(tableId, p2.cookie)];
    await readyAllButLast(sockets);
    send(sockets[1], { type: "ready" });
    await sockets[0].nextFrameMatching((m) => actingView(m)?.currentTurn === 0);

    // Seat1 leaves while it's still seat0's turn: marked pending, not stood yet.
    send(sockets[1], { type: "leave" });
    const pendingFrame = await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.leavePending === true);
    expect(actingView(pendingFrame)?.currentTurn).toBe(0);
    expect(actingView(pendingFrame)?.players[1].done).toBe(false);

    // Seat0 stands; the cascade auto-stands seat1 and the dealer resolves.
    send(sockets[0], { type: "stand" });
    const settled = (await sockets[0].nextFrameMatching((m) => m.type === "settled")) as SettledMessage;

    const expected = expectedDeltasFromReplay([0, 1], STAKE, shoe, [
      [0, { type: "stand" }],
      [1, { type: "stand" }],
    ]);
    expect(expected).toEqual({ 0: STAKE, 1: STAKE }); // 19 and 20 both beat 17
    expect(settled.deltas).toEqual(expected);
    // The departed seat's win is still paid to their balance.
    expect(await creditsOf(p2.id)).toBe(before + STAKE);

    const afterSettle = await sockets[0].nextFrameMatching((m) => asStateMessage(m)?.seats[1]?.userId === null);
    expect(asStateMessage(afterSettle)!.seats[1]).toMatchObject({ userId: null, leavePending: false });

    sockets[0].ws.close();
  });
});

describe("BlackjackTableDO — exactly-once settlement", () => {
  it("does not double-pay when settlement is forced again after a simulated crash", async () => {
    const tableId = `bj-once-${crypto.randomUUID().slice(0, 8)}`;
    const host = await registerUser("bj1host");
    await initTable(tableId, host.cookie, STAKE);

    const stub = env.BLACKJACK_TABLE_DO.getByName(tableId);
    const shoe = buildShoe([[0, "Tc", "9c"]], ["Td", "7d"]);
    await stub.setTestFixedDeal({ shuffledShoe: shoe });

    const socket = await openTableSocket(tableId, host.cookie);
    send(socket, { type: "ready" });
    await socket.nextFrameMatching((m) => actingView(m)?.currentTurn === 0);
    send(socket, { type: "stand" }); // 19 beats 17
    await socket.nextFrameMatching((m) => m.type === "settled");
    socket.ws.close();

    const afterFirst = await creditsOf(host.id);
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(1);

    // Simulate a crash between the D1 batch and the local settled flag — the
    // forced retry must be saved by the ledger's UNIQUE idempotency_key.
    await runInDurableObject(stub, async (_instance, doState) => {
      doState.storage.sql.exec("UPDATE game_state SET settled = 0 WHERE id = 1");
    });
    await expect(stub.forceSettle()).resolves.toBeUndefined();

    expect(await creditsOf(host.id)).toBe(afterFirst);
    expect((await ledgerRowsForRound(tableId, 1)).results).toHaveLength(1);
  });
});
