import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  createGame,
  createShoe,
  settle,
  shuffleCards,
  viewFor,
  type Action,
  type Card,
  type FinishedState,
  type GameState,
  type RedactedView,
  type Seat,
} from "blackjack";
import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ErrorMessage,
  type NextHandMessage,
  type SeatStatus,
  type SettledMessage,
  type StateMessage,
} from "./blackjack-protocol";
import { lobbyDoName } from "./lobby";
import type { InitResult, TableInitParams } from "./game-table";

export type { InitResult, TableInitParams };

// One DO per table (named by table id via env.BLACKJACK_TABLE_DO.getByName(tableId)).
// A near-copy of PokerTableDO's drop-in room model — SQLite schema-in-DO,
// WebSocket Hibernation API, per-seat broadcasts, exactly-once D1 settlement
// via ledger idempotency keys, one shared alarm slot for disconnect grace /
// auto-deal — with blackjack's own differences:
//
//  - Seats 0-4 (capacity 5, minimum 1 to start — solo vs. the dealer is a
//    real game). Taken/freed BETWEEN ROUNDS only; a new connection mid-round
//    is refused (409), same as poker.
//  - No dealer seat and no rotation: the house deals every round. table_meta
//    therefore carries no dealer_seat column, and the test override fixes
//    only the shoe.
//  - A leave (or expired disconnect grace) mid-round auto-STANDS that seat
//    instead of folding it — blackjack has no fold; the bet stays live and
//    the hand can still win. The seat is freed once the round settles.
//  - createGame can return an already-finished round (dealer natural, or
//    every seat dealt one) — startNewHand settles it immediately instead of
//    waiting for actions that will never come.
//  - `handNo` counts dealt rounds (blackjack's per-seat cards are "hands",
//    but the wire field keeps poker's name so the client hooks stay parallel).
//  - Settlement deltas are against the house, not zero-sum — the ledger
//    records per-user deltas only, so nothing needs a counterparty row.

const MIN_SEATS_TO_START = 1;
const MAX_SEATS = 5;
const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3, 4];

// How long after a settled round's broadcast the table waits before either
// auto-dealing the next round or falling back to manual ready-up.
const NEXT_HAND_DELAY_MS = 6_000;

/**
 * TEST-ONLY fixed shoe, consumed once by drawRoundShoe() in place of a
 * crypto-random shuffle, then deleted (one-shot, like poker's) — an RPC
 * method only reachable by a caller already holding an env.BLACKJACK_TABLE_DO
 * binding; no HTTP route forwards client input into it.
 */
export interface TestFixedDeal {
  readonly shuffledShoe: readonly Card[];
}

interface SocketAttachment {
  readonly seat: Seat;
  readonly userId: string;
  readonly username: string;
}

interface TableMetaRow {
  [key: string]: SqlStorageValue;
  tableId: string;
  gameId: string;
  stake: number;
  visibility: "public" | "private";
  inviteCode: string | null;
  hostUserId: string;
  handNo: number;
  everSeated: 0 | 1;
  /** Epoch ms the between-rounds auto-deal alarm is armed for, or null — see PokerTableDO's identically named column. */
  nextHandAt: number | null;
}

interface SeatRow {
  [key: string]: SqlStorageValue;
  seat: Seat;
  userId: string;
  username: string;
  ready: 0 | 1;
  leavePending: 0 | 1;
  /** Cached D1 users.credits — see refreshSeatCredits() for when this is refreshed. */
  credits: number;
}

interface GameStateRow {
  [key: string]: SqlStorageValue;
  stateJson: string | null;
  settled: 0 | 1;
}

interface PendingDisconnectRow {
  [key: string]: SqlStorageValue;
  seat: Seat;
  username: string;
  deadline: number;
}

// Same reconnect grace as the other table DOs — survives a page refresh.
const DISCONNECT_GRACE_MS = 30_000;

interface TestOverrideRow {
  [key: string]: SqlStorageValue;
  shuffledShoeJson: string;
}

function cryptoRandomSource(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function buildResultSummary(
  state: FinishedState,
  deltas: Readonly<Record<Seat, number>>,
  seatRows: readonly SeatRow[],
) {
  const seats = Object.fromEntries(seatRows.map((s) => [s.seat, { userId: s.userId, username: s.username }]));
  return {
    dealerCards: state.dealerCards,
    outcomes: state.outcomes,
    hands: Object.fromEntries(state.seats.map((s) => [s, { cards: state.players[s].cards, bet: state.players[s].bet }])),
    deltas,
    seats,
  };
}

export class BlackjackTableDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS table_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        table_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        stake INTEGER NOT NULL,
        visibility TEXT NOT NULL,
        invite_code TEXT,
        host_user_id TEXT NOT NULL,
        hand_no INTEGER NOT NULL DEFAULT 0,
        ever_seated INTEGER NOT NULL DEFAULT 0,
        next_hand_at INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    // Seat rows are transient, exactly like poker's: deleted once the
    // occupant leaves for good, so a freed seat number can be reused.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS seats (
        seat INTEGER PRIMARY KEY CHECK (seat BETWEEN 0 AND 4),
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0,
        leave_pending INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0
      )
    `);
    // The terminal (finished) state stays in place after settlement so a
    // between-rounds broadcast keeps showing the last round's outcome and
    // forceSettle() can re-examine it — same as the other table DOs.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT,
        settled INTEGER NOT NULL DEFAULT 0
      )
    `);
    // One row per seat currently mid-disconnect-grace during an active round.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_disconnects (
        seat INTEGER PRIMARY KEY CHECK (seat BETWEEN 0 AND 4),
        username TEXT NOT NULL,
        deadline INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_override (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shuffled_shoe_json TEXT NOT NULL
      )
    `);
  }

  // --- Lifecycle / lobby-facing RPC -----------------------------------------

  /** Idempotent: a second call after the table is already initialized is a harmless no-op. */
  async init(params: TableInitParams): Promise<InitResult> {
    if (this.loadMetaRow()) return { ok: true };

    if (params.gameId !== "blackjack") return { ok: false, reason: "unsupported-game" };
    if (!Number.isInteger(params.stake) || params.stake <= 0) {
      return { ok: false, reason: "invalid-stake" };
    }
    if (params.visibility !== "public" && params.visibility !== "private") {
      return { ok: false, reason: "invalid-visibility" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO table_meta (id, table_id, game_id, stake, visibility, invite_code, host_user_id, hand_no, ever_seated, next_hand_at, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?)`,
      params.tableId,
      params.gameId,
      params.stake,
      params.visibility,
      params.inviteCode ?? null,
      params.hostUserId,
      new Date().toISOString(),
    );
    this.ctx.storage.sql.exec("INSERT INTO game_state (id, state_json, settled) VALUES (1, NULL, 0)");

    return { ok: true };
  }

  /** See TestFixedDeal's doc comment for why this is safe to expose as RPC, and why it's one-shot. */
  async setTestFixedDeal(deal: TestFixedDeal): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO test_override (id, shuffled_shoe_json) VALUES (1, ?)",
      JSON.stringify(deal.shuffledShoe),
    );
  }

  /**
   * Re-runs settlement if the current round is finished but not yet marked
   * settled locally. Idempotent — the credit_ledger UNIQUE idempotency key is
   * the ultimate double-pay guard. Exposed for ops/testing only.
   */
  async forceSettle(): Promise<void> {
    await this.trySettle();
  }

  /**
   * Live occupancy + status snapshot for the lobby directory. Null if
   * uninitialized. `finished` only ever fires once the table has held a seat
   * and now holds none — see PokerTableDO's getSeatSummary for the rationale
   * this copies.
   */
  async getSeatSummary(): Promise<
    | { seatsFilled: number; seatsTotal: number; settled: boolean; finished: boolean; anyConnected: boolean }
    | null
  > {
    const meta = this.loadMetaRow();
    if (!meta) return null;
    const seatRows = this.loadSeats();
    return {
      seatsFilled: seatRows.length,
      seatsTotal: MAX_SEATS,
      settled: this.loadGameStateRow().settled === 1,
      finished: meta.everSeated === 1 && seatRows.length === 0,
      anyConnected: this.ctx.getWebSockets().length > 0,
    };
  }

  /** Used by LobbyDO's isUserInLiveGame / dead-table sweep — same `finished` definition as getSeatSummary. */
  async getLiveness(): Promise<{ finished: boolean; settled: boolean; anyConnected: boolean }> {
    const meta = this.loadMetaRow();
    if (!meta) return { finished: true, settled: false, anyConnected: false };
    const seatRows = this.loadSeats();
    return {
      finished: meta.everSeated === 1 && seatRows.length === 0,
      settled: this.loadGameStateRow().settled === 1,
      anyConnected: this.ctx.getWebSockets().length > 0,
    };
  }

  // --- WebSocket upgrade / seating -------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const userId = request.headers.get("X-User-Id");
    const username = request.headers.get("X-Username");
    if (!userId || !username) {
      return new Response("missing user identity", { status: 400 });
    }

    const meta = this.loadMetaRow();
    if (!meta) return new Response("table not initialized", { status: 404 });

    const seatRows = this.loadSeats();
    const existing = seatRows.find((s) => s.userId === userId);
    let seat: Seat;
    if (existing) {
      seat = existing.seat;
      if (existing.username !== username) {
        this.ctx.storage.sql.exec("UPDATE seats SET username = ? WHERE seat = ?", username, seat);
      }
      // A reconnect always cancels this seat's pending disconnect-driven departure.
      await this.cancelDisconnectGrace(seat);
    } else {
      // Seats are taken between rounds only — a brand-new connectee is
      // refused outright while a round is active, same as a full table.
      if (this.isHandActive()) {
        return new Response("a round is in progress — seats open again once it ends", { status: 409 });
      }
      const taken = new Set(seatRows.map((s) => s.seat));
      const free = ALL_SEATS.find((s) => !taken.has(s));
      if (free === undefined) return new Response("table is full", { status: 409 });
      seat = free;
      this.ctx.storage.sql.exec(
        "INSERT INTO seats (seat, user_id, username, ready, leave_pending) VALUES (?, ?, ?, 0, 0)",
        seat,
        userId,
        username,
      );
      this.ctx.storage.sql.exec("UPDATE table_meta SET ever_seated = 1 WHERE id = 1");
    }

    // Refresh this seat's cached credits on every connect/reconnect — the
    // other refresh point is right after settlement (see broadcastSettled).
    await this.refreshSeatCredits([userId]);

    // Reconnect: any prior socket for this seat gets replaced by this one.
    const priorSockets = this.ctx.getWebSockets(`seat:${seat}`);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`seat:${seat}`]);
    const attachment: SocketAttachment = { seat, userId, username };
    server.serializeAttachment(attachment);

    for (const old of priorSockets) {
      try {
        old.close(4000, "replaced by reconnect");
      } catch {
        /* already closing */
      }
    }

    this.broadcastState();

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernatable WebSocket event handlers ---------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || typeof attachment.seat !== "number") {
        ws.close(1011, "missing socket identity");
        return;
      }
      const { seat } = attachment;

      let raw: unknown;
      try {
        raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      } catch {
        this.sendErrorToWs(ws, "bad-message", "invalid JSON");
        return;
      }
      const parsed = parseClientMessage(raw);
      if (!parsed) {
        this.sendErrorToWs(ws, "bad-message", "malformed message");
        return;
      }

      if (parsed.type === "leave") {
        await this.processLeavingSeat(seat);
        return;
      }

      await this.ensureSettledIfNeeded();

      if (parsed.type === "ready") {
        await this.handleReady(seat);
        return;
      }

      if (!this.isHandActive()) {
        this.sendErrorToWs(ws, "no-active-hand", "no round is currently in progress");
        return;
      }
      const state = this.loadGameState()!;
      const action = toEngineAction(parsed);
      const result = applyAction(state, seat, action);
      if (!result.ok) {
        this.sendErrorToWs(ws, result.reason, result.reason);
        return;
      }
      await this.applyNewState(result.state);
    } catch (err) {
      console.error("BlackjackTableDO webSocketMessage failed", err);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  /**
   * Shared by both terminal hibernation events. Guards against acting on a
   * stale attachment whose seat has already been freed and possibly
   * reassigned — see PokerTableDO's identically named method.
   */
  private async handleSocketClosed(ws: WebSocket): Promise<void> {
    this.broadcastState();
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    const current = this.loadSeats().find((s) => s.seat === attachment.seat);
    if (!current || current.userId !== attachment.userId) return;
    const stillConnected = this.ctx.getWebSockets(`seat:${attachment.seat}`).length > 0;
    if (!stillConnected) {
      if (this.isHandActive()) {
        await this.scheduleDisconnectGrace(attachment.seat, attachment.username);
      } else {
        // Between rounds, a disconnect frees the seat immediately — no bet at risk.
        await this.processLeavingSeat(attachment.seat);
      }
    }
  }

  // --- Game flow --------------------------------------------------------------

  private async handleReady(seat: Seat): Promise<void> {
    if (this.isHandActive()) {
      this.sendErrorToSeat(seat, "game-in-progress", "cannot ready up while a round is active");
      return;
    }
    const meta = this.loadMetaRow();
    if (meta?.nextHandAt != null) {
      // The auto-deal countdown is running — a manual ready click is accepted
      // but ignored so it can never race the alarm into dealing twice.
      return;
    }
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 1 WHERE seat = ?", seat);
    const seatRows = this.loadSeats();
    if (seatRows.length >= MIN_SEATS_TO_START && seatRows.every((s) => s.ready === 1)) {
      await this.startNewHand();
    } else {
      this.broadcastState();
    }
  }

  /**
   * Client-driven leave, or a disconnect whose grace expired. Never ends the
   * table for anyone else — mid-round it auto-stands this one seat (see
   * forceStandAndMarkLeaving), between rounds it frees the seat immediately.
   */
  private async processLeavingSeat(seat: Seat): Promise<void> {
    if (!this.isHandActive()) {
      this.freeSeat(seat);
      this.broadcastState();
      await this.maybeNotifyTableEmptied();
      return;
    }
    await this.forceStandAndMarkLeaving(seat);
  }

  /**
   * Marks `seat` as leaving (freed once the current round settles) and, if
   * it's their turn, stands them right now; otherwise resolveLeavers() stands
   * them the instant the turn reaches them. Their bet stays live — a departed
   * seat's stood hand can still beat the dealer and be paid on settlement.
   */
  private async forceStandAndMarkLeaving(seat: Seat): Promise<void> {
    this.setLeavePending(seat, true);
    const state = this.loadGameState();
    if (!state) {
      this.broadcastState();
      return;
    }
    if (state.phase === "acting" && state.currentTurn === seat) {
      await this.applyNewState(state);
    } else {
      this.broadcastState();
    }
  }

  /** Applies the engine's result of one action, after resolving any leave-pending seat whose turn arrived. */
  private async applyNewState(rawState: GameState): Promise<void> {
    const state = this.resolveLeavers(rawState);
    this.persistGameState(state);
    if (state.phase === "finished") {
      // trySettle() broadcasts 'settled' and the follow-up 'state' frame itself.
      await this.trySettle();
      return;
    }
    this.broadcastState();
  }

  /**
   * Starting from `state`, auto-stands the current turn holder for as long as
   * they're marked leave_pending, cascading — a client is never shown a turn
   * belonging to a seat that already committed to leaving. Blackjack's analog
   * of PokerTableDO's auto-fold cascade.
   */
  private resolveLeavers(state: GameState): GameState {
    let current = state;
    while (current.phase === "acting" && this.isLeavePending(current.currentTurn)) {
      const result = applyAction(current, current.currentTurn, { type: "stand" });
      if (!result.ok) break; // defensive; a leave-pending seat's own turn can always legally stand
      current = result.state;
    }
    return current;
  }

  /**
   * `dealtInSeats`, when given, restricts the new round to exactly those
   * seats — used by the auto-deal alarm to skip a seated-but-disconnected
   * occupant for that one round while keeping their seat. The engine can
   * return an already-finished round (dealer natural / all naturals), which
   * settles immediately via applyNewState.
   */
  private async startNewHand(dealtInSeats?: readonly Seat[]): Promise<void> {
    const meta = this.loadMetaRow();
    if (!meta) return;

    const seatRows = this.loadSeats();
    const seats = dealtInSeats ?? seatRows.map((s) => s.seat);
    const shoe = this.drawRoundShoe();
    const state = createGame({ seats, stake: meta.stake, shuffledShoe: shoe });

    const handNo = meta.handNo + 1;
    this.ctx.storage.sql.exec("UPDATE table_meta SET hand_no = ?, next_hand_at = NULL WHERE id = 1", handNo);
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 0");

    // Defensive: a fresh round never starts holding a leftover grace timer.
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.ctx.storage.deleteAlarm();

    await this.applyNewState(state);
  }

  // --- Disconnect grace ----------------------------------------------------------

  private async scheduleDisconnectGrace(seat: Seat, username: string): Promise<void> {
    const deadline = Date.now() + DISCONNECT_GRACE_MS;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO pending_disconnects (seat, username, deadline) VALUES (?, ?, ?)",
      seat,
      username,
      deadline,
    );
    await this.rearmAlarm();
  }

  private async cancelDisconnectGrace(seat: Seat): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects WHERE seat = ?", seat);
    await this.rearmAlarm();
  }

  /**
   * One alarm slot shared by two concerns that never overlap in practice:
   * disconnect-grace deadlines (mid-round only) and the between-rounds
   * auto-deal countdown — disconnect deadlines win, then next_hand_at, then
   * no alarm. Same scheme as PokerTableDO's rearmAlarm.
   */
  private async rearmAlarm(): Promise<void> {
    const disconnectRow = this.ctx.storage.sql
      .exec<{ deadline: number }>("SELECT MIN(deadline) as deadline FROM pending_disconnects")
      .toArray()[0];
    if (disconnectRow?.deadline != null) {
      await this.ctx.storage.setAlarm(disconnectRow.deadline);
      return;
    }
    const meta = this.loadMetaRow();
    if (meta?.nextHandAt != null) {
      await this.ctx.storage.setAlarm(meta.nextHandAt);
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }

  /** Branches on isHandActive() to decide which of the two alarm concerns is armed — see rearmAlarm(). */
  async alarm(): Promise<void> {
    if (this.isHandActive()) {
      const earliest = this.ctx.storage.sql
        .exec<PendingDisconnectRow>(
          "SELECT seat, username, deadline FROM pending_disconnects ORDER BY deadline ASC LIMIT 1",
        )
        .toArray()[0];
      if (!earliest) return;

      this.ctx.storage.sql.exec("DELETE FROM pending_disconnects WHERE seat = ?", earliest.seat);
      const stillConnected = this.ctx.getWebSockets(`seat:${earliest.seat}`).length > 0;
      if (!stillConnected) {
        await this.forceStandAndMarkLeaving(earliest.seat);
      }
      // Rearm regardless: the stand may itself settle the round (scheduling
      // the next-round timer), and another seat may still be queued.
      await this.rearmAlarm();
      return;
    }

    // Not mid-round: stale grace rows are defensive cleanup only; this firing
    // is the between-rounds auto-deal countdown.
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.fireNextHandAlarm();
  }

  /**
   * Deals a fresh round automatically if at least MIN_SEATS_TO_START occupied
   * seats are connected — skipping (not freeing) any disconnected occupant
   * for just this round — or falls back to manual ready-up.
   */
  private async fireNextHandAlarm(): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE table_meta SET next_hand_at = NULL WHERE id = 1");

    const seatRows = this.loadSeats();
    const connected = seatRows.filter((s) => this.ctx.getWebSockets(`seat:${s.seat}`).length > 0);
    if (connected.length >= MIN_SEATS_TO_START) {
      await this.startNewHand(connected.map((s) => s.seat));
    } else {
      this.broadcastState();
    }
  }

  private broadcastNextHand(at: number): void {
    const msg: NextHandMessage = { type: "nextHand", at };
    const json = JSON.stringify(msg);
    for (const seat of ALL_SEATS) {
      for (const ws of this.ctx.getWebSockets(`seat:${seat}`)) {
        try {
          ws.send(json);
        } catch {
          /* socket may have just closed */
        }
      }
    }
  }

  // --- Settlement ---------------------------------------------------------------

  private async ensureSettledIfNeeded(): Promise<void> {
    const row = this.loadGameStateRow();
    if (!row.stateJson || row.settled === 1) return;
    const state = JSON.parse(row.stateJson) as GameState;
    if (state.phase === "finished") await this.trySettle();
  }

  private async trySettle(): Promise<void> {
    const row = this.loadGameStateRow();
    if (!row.stateJson) return;
    const state = JSON.parse(row.stateJson) as GameState;
    if (state.phase !== "finished") return;

    const meta = this.loadMetaRow();
    if (!meta) return;

    const seatRows = this.loadSeats();
    const deltas = settle(state);

    if (row.settled !== 1) {
      if (!state.seats.every((s) => seatRows.some((r) => r.seat === s))) {
        console.error("BlackjackTableDO: cannot settle — a seat row is missing for this round's seats");
        return;
      }

      const stmts = [];
      for (const seat of state.seats) {
        const seatRow = seatRows.find((r) => r.seat === seat)!;
        const delta = deltas[seat];
        // A push (zero delta) gets no ledger row, matching the other DOs' skip.
        if (delta === 0) continue;
        const idempotencyKey = `settle:${meta.tableId}:${meta.handNo}:${seatRow.userId}`;
        stmts.push(
          this.env.DB.prepare(
            `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
             VALUES (?, ?, 'blackjack', 'game_settlement', ?)`,
          ).bind(seatRow.userId, delta, idempotencyKey),
        );
        stmts.push(
          this.env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(delta, seatRow.userId),
        );
      }
      const gameRowId = `${meta.tableId}:${meta.handNo}`;
      stmts.push(
        this.env.DB.prepare(
          `INSERT INTO games (id, game_id, stake, result_json, table_id, round)
           VALUES (?, 'blackjack', ?, ?, ?, ?)`,
        ).bind(
          gameRowId,
          meta.stake,
          JSON.stringify(buildResultSummary(state, deltas, seatRows)),
          meta.tableId,
          meta.handNo,
        ),
      );

      try {
        await this.env.DB.batch(stmts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("UNIQUE")) {
          console.error("BlackjackTableDO settlement batch failed", err);
          throw err;
        }
        // Another attempt already landed this round's ledger rows — treat as settled.
      }

      this.ctx.storage.sql.exec("UPDATE game_state SET settled = 1 WHERE id = 1");
    }

    await this.broadcastSettled(meta.handNo, seatRows, deltas);

    // Return to the ready phase: free any seat that left mid-round (closing
    // its sockets too — see freeSeat) and clear grace bookkeeping. The
    // finished state_json stays in place so the next 'state' frame still
    // shows this round's outcome.
    const leavers = seatRows.filter((s) => s.leavePending === 1).map((s) => s.seat);
    for (const seat of leavers) this.freeSeat(seat);
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");

    // Arm the between-rounds auto-deal countdown — unconditionally; whether
    // enough occupants are connected is decided at fire time.
    const nextHandAt = Date.now() + NEXT_HAND_DELAY_MS;
    this.ctx.storage.sql.exec("UPDATE table_meta SET next_hand_at = ? WHERE id = 1", nextHandAt);
    await this.rearmAlarm();
    this.broadcastNextHand(nextHandAt);

    this.broadcastState();
    await this.maybeNotifyTableEmptied();
  }

  /**
   * Best-effort notification to the lobby, only once the table is genuinely
   * empty — a still-occupied table's LobbyDO row must survive between rounds
   * for quick play's join-or-create scan, same as poker.
   */
  private async maybeNotifyTableEmptied(): Promise<void> {
    const meta = this.loadMetaRow();
    if (!meta) return;
    if (meta.everSeated === 1 && this.loadSeats().length === 0) {
      await this.notifyLobbyTableCleared(meta.gameId, meta.tableId);
    }
  }

  private async notifyLobbyTableCleared(gameId: string, tableId: string): Promise<void> {
    try {
      await this.env.LOBBY_DO.getByName(lobbyDoName(gameId)).notifySettled(tableId);
    } catch (err) {
      console.error("BlackjackTableDO: failed to notify LobbyDO of table clearing", err);
    }
  }

  private async broadcastSettled(
    handNo: number,
    seatRows: readonly SeatRow[],
    deltas: Readonly<Record<Seat, number>>,
  ): Promise<void> {
    // One batched D1 read refreshes every seat's cached credits; the next
    // broadcastState() reads the cache instead of hitting D1 again.
    await this.refreshSeatCredits(seatRows.map((s) => s.userId));
    const freshSeats = this.loadSeats();

    for (const seatRow of seatRows) {
      const sockets = this.ctx.getWebSockets(`seat:${seatRow.seat}`);
      if (sockets.length === 0) continue;
      const newBalance = freshSeats.find((s) => s.seat === seatRow.seat)?.credits;
      const msg: SettledMessage = { type: "settled", handNo, deltas, newBalance };
      const json = JSON.stringify(msg);
      for (const ws of sockets) {
        try {
          ws.send(json);
        } catch {
          /* socket may have just closed */
        }
      }
    }
  }

  // --- Broadcast ----------------------------------------------------------------

  private broadcastState(): void {
    const meta = this.loadMetaRow();
    if (!meta) return;
    const seatRows = this.loadSeats();
    const gameState = this.loadGameState();

    const seatStatuses: SeatStatus[] = ALL_SEATS.map((seat) => {
      const row = seatRows.find((s) => s.seat === seat);
      return {
        seat,
        userId: row?.userId ?? null,
        username: row?.username ?? null,
        connected: this.ctx.getWebSockets(`seat:${seat}`).length > 0,
        ready: row?.ready === 1,
        leavePending: row?.leavePending === 1,
        credits: row?.credits ?? 0,
      };
    });

    for (const seat of ALL_SEATS) {
      const sockets = this.ctx.getWebSockets(`seat:${seat}`);
      if (sockets.length === 0) continue;
      const msg: StateMessage = {
        type: "state",
        handNo: meta.handNo,
        seats: seatStatuses,
        // viewFor is safe for any seat, dealt in or not (all hands are
        // public), so a skipped occupant spectates the live round instead of
        // getting null — see blackjack-protocol.ts's StateMessage doc.
        view: gameState ? (viewFor(gameState, seat) as RedactedView) : null,
      };
      const json = JSON.stringify(msg);
      for (const ws of sockets) {
        try {
          ws.send(json);
        } catch {
          /* socket may have just closed */
        }
      }
    }
  }

  private sendErrorToWs(ws: WebSocket, code: ErrorCode, message: string): void {
    const msg: ErrorMessage = { type: "error", code, message };
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket may have just closed */
    }
  }

  private sendErrorToSeat(seat: Seat, code: ErrorCode, message: string): void {
    for (const ws of this.ctx.getWebSockets(`seat:${seat}`)) {
      this.sendErrorToWs(ws, code, message);
    }
  }

  // --- Seat lifecycle --------------------------------------------------------

  /**
   * Permanently removes a seat: deletes its row AND closes any socket still
   * tagged to that seat number — the close is load-bearing, see
   * PokerTableDO's freeSeat for the stale-hibernation-tag hazard it prevents.
   */
  private freeSeat(seat: Seat): void {
    this.ctx.storage.sql.exec("DELETE FROM seats WHERE seat = ?", seat);
    for (const ws of this.ctx.getWebSockets(`seat:${seat}`)) {
      try {
        ws.close(4001, "seat vacated");
      } catch {
        /* already closing */
      }
    }
  }

  private setLeavePending(seat: Seat, value: boolean): void {
    this.ctx.storage.sql.exec("UPDATE seats SET leave_pending = ? WHERE seat = ?", value ? 1 : 0, seat);
  }

  private isLeavePending(seat: Seat): boolean {
    return this.loadSeats().some((s) => s.seat === seat && s.leavePending === 1);
  }

  // --- State predicates -----------------------------------------------------

  /**
   * True whenever a round exists and hasn't finished being settled — spans
   * the brief finished-but-not-yet-settled window too, so a leave arriving
   * there is still "mid-round" (leave_pending) rather than "between rounds"
   * (free immediately). See PokerTableDO's isHandActive for why gating on
   * `settled` keeps an in-flight settlement's seat reads safe.
   */
  private isHandActive(): boolean {
    const row = this.loadGameStateRow();
    if (!row.stateJson) return false;
    const state = JSON.parse(row.stateJson) as GameState;
    return !(state.phase === "finished" && row.settled === 1);
  }

  // --- Storage helpers --------------------------------------------------------

  private loadMetaRow(): TableMetaRow | undefined {
    return this.ctx.storage.sql
      .exec<TableMetaRow>(
        `SELECT table_id as tableId, game_id as gameId, stake, visibility, invite_code as inviteCode,
                host_user_id as hostUserId, hand_no as handNo, ever_seated as everSeated,
                next_hand_at as nextHandAt
         FROM table_meta WHERE id = 1`,
      )
      .toArray()[0];
  }

  private loadSeats(): SeatRow[] {
    return this.ctx.storage.sql
      .exec<SeatRow>(
        "SELECT seat, user_id as userId, username, ready, leave_pending as leavePending, credits FROM seats ORDER BY seat",
      )
      .toArray();
  }

  /** See GameTableDO's identically named method — same call sites, same deleted-user policy. */
  private async refreshSeatCredits(userIds: readonly string[]): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.env.DB.prepare(
      `SELECT id, credits FROM users WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ id: string; credits: number }>();
    for (const row of results) {
      this.ctx.storage.sql.exec("UPDATE seats SET credits = ? WHERE user_id = ?", row.credits, row.id);
    }
  }

  private loadGameStateRow(): GameStateRow {
    const row = this.ctx.storage.sql
      .exec<GameStateRow>("SELECT state_json as stateJson, settled FROM game_state WHERE id = 1")
      .toArray()[0];
    return row ?? { stateJson: null, settled: 0 };
  }

  private loadGameState(): GameState | null {
    const row = this.loadGameStateRow();
    return row.stateJson ? (JSON.parse(row.stateJson) as GameState) : null;
  }

  private persistGameState(state: GameState): void {
    this.ctx.storage.sql.exec("UPDATE game_state SET state_json = ?, settled = 0 WHERE id = 1", JSON.stringify(state));
  }

  private loadTestOverride(): TestFixedDeal | undefined {
    const row = this.ctx.storage.sql
      .exec<TestOverrideRow>("SELECT shuffled_shoe_json as shuffledShoeJson FROM test_override WHERE id = 1")
      .toArray()[0];
    if (!row) return undefined;
    return { shuffledShoe: JSON.parse(row.shuffledShoeJson) as Card[] };
  }

  private drawRoundShoe(): Card[] {
    const override = this.loadTestOverride();
    if (override) {
      this.ctx.storage.sql.exec("DELETE FROM test_override WHERE id = 1");
      return (override.shuffledShoe as Card[]).slice();
    }
    return shuffleCards(createShoe(), cryptoRandomSource);
  }
}

function toEngineAction(msg: Exclude<ClientMessage, { type: "ready" } | { type: "leave" }>): Action {
  switch (msg.type) {
    case "hit":
      return { type: "hit" };
    case "stand":
      return { type: "stand" };
    case "double":
      return { type: "double" };
  }
}
