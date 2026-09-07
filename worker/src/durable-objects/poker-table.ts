import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  createDeck,
  createGame,
  nextDealerSeat,
  settle,
  shuffleDeck,
  viewFor,
  type Action,
  type Card,
  type GameState,
  type HandOverState,
  type Seat,
} from "poker";
import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ErrorMessage,
  type SeatStatus,
  type SettledMessage,
  type StateMessage,
} from "./poker-protocol";
import { lobbyDoName } from "./lobby";
import type { InitResult, TableInitParams } from "./game-table";

export type { InitResult, TableInitParams };

// One DO per table (named by table id via env.POKER_TABLE_DO.getByName(tableId)).
// Structurally mirrors GameTableDO (doudizhu) / LiarsBarTableDO (liarsbar) —
// SQLite schema-in-DO with migrate(), WebSocket Hibernation API, per-seat
// redacted broadcasts, exactly-once D1 settlement via ledger idempotency
// keys, a single alarm for disconnect grace — but poker's own room semantics
// are deliberately different in every way that follows from being a
// persistent, variable-capacity "drop-in" table rather than a single
// fixed-size match:
//
//  - Seats 0-7 (capacity 8, minimum 2 to start), taken/freed BETWEEN HANDS
//    ONLY. A new (never-seated) connection takes the lowest free seat; if a
//    hand is currently active, or the table is full, the WebSocket upgrade
//    itself is refused (409) rather than accepted as a spectator — there is
//    no "spectate and get seated once the hand ends" path in this build.
//  - No "aborted" concept at all: leaving does NOT end the table for anyone
//    else. A deliberate {type:'leave'} message, or a disconnect whose 30s
//    reconnect grace expires, auto-folds that ONE seat (immediately if it's
//    already their turn, or the instant action reaches them otherwise — see
//    resolveLeavers()) and frees their seat once the hand settles. Every
//    other seat's hand plays on unaffected.
//  - Hands repeat indefinitely on the same table: ready-up requires EVERY
//    currently seated player ready AND at least 2 seated, dealer rotates via
//    the engine's nextDealerSeat() from the previous hand's dealer (or the
//    lowest seat, for the table's first-ever hand), and after settlement the
//    table returns to a ready/waiting phase — seats persist (leavers freed),
//    exactly as before a hand ever started.
//  - The lobby-facing RPCs (getSeatSummary/getLiveness) intentionally do NOT
//    report `finished` just because a hand isn't currently running, or even
//    because nobody has connected YET — see maybeNotifyTableEmptied() and
//    the `everSeated` flag below for why: a fresh, not-yet-connected table
//    needs the same "give the host a moment to connect" grace the other two
//    DOs get from LobbyDO's own age-based fallback, and — unlike a one-shot
//    match — a poker table with people seated between hands is not "finished"
//    just because no hand is active. `finished` only ever becomes true once
//    the table has held at least one seat and now holds none: a genuinely,
//    verifiably empty table, safe to sweep immediately regardless of age.

const MIN_SEATS_TO_START = 2;
const MAX_SEATS = 8;
const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * TEST-ONLY fixed setup, consumed once by drawHandSetup() in place of a
 * crypto-random shuffle and the normal dealer-rotation computation, then
 * immediately deleted (one-shot) — see setTestFixedDeal(), an RPC method
 * only reachable by a caller already holding an env.POKER_TABLE_DO binding
 * (i.e. server-side code in this Worker or a test); no HTTP route in this
 * repo ever forwards client-supplied input into it, so no request from a
 * real browser client can reach it.
 *
 * Unlike GameTableDO's/LiarsBarTableDO's own TestFixedDeal (which persists
 * across every subsequent hand until overwritten), this one is consumed
 * exactly once and then cleared automatically. That's a deliberate
 * difference, not an oversight: poker's dealer seat is DO-level rotation
 * logic (nextDealerSeat from the previous hand's stored dealer), not
 * something the engine tracks on its own — a "persists forever" override
 * would silently freeze that rotation across every subsequent hand a test
 * plays, defeating any test that needs to observe rotation across 2+ hands.
 * A test that wants a second hand's deck/dealer controlled too just calls
 * setTestFixedDeal() again before that hand starts.
 */
export interface TestFixedDeal {
  readonly shuffledDeck: readonly Card[];
  readonly dealerSeat: Seat;
}

interface SocketAttachment {
  readonly seat: Seat;
  readonly userId: string;
  readonly username: string;
}

// Each row interface carries a string index signature so it satisfies
// SqlStorageCursor<T>'s `T extends Record<string, SqlStorageValue>` bound.
interface TableMetaRow {
  [key: string]: SqlStorageValue;
  tableId: string;
  gameId: string;
  stake: number;
  visibility: "public" | "private";
  inviteCode: string | null;
  hostUserId: string;
  handNo: number;
  dealerSeat: number | null;
  everSeated: 0 | 1;
}

interface SeatRow {
  [key: string]: SqlStorageValue;
  seat: Seat;
  userId: string;
  username: string;
  ready: 0 | 1;
  leavePending: 0 | 1;
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

// A disconnect during an active hand gets this long to reconnect before it's
// treated as a departure (auto-fold + eventual seat-free). Same value as
// GameTableDO/LiarsBarTableDO — generous enough to survive a page refresh.
const DISCONNECT_GRACE_MS = 30_000;

interface TestOverrideRow {
  [key: string]: SqlStorageValue;
  shuffledDeckJson: string;
  dealerSeat: number;
}

function cryptoRandomSource(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function buildResultSummary(
  state: HandOverState,
  deltas: Readonly<Record<Seat, number>>,
  seatRows: readonly SeatRow[],
) {
  const seats = Object.fromEntries(seatRows.map((s) => [s.seat, { userId: s.userId, username: s.username }]));
  if (state.phase === "finished") {
    return {
      dealerSeat: state.dealerSeat,
      board: state.community,
      pot: state.pot,
      winner: state.winner,
      deltas,
      seats,
    };
  }
  return {
    dealerSeat: state.dealerSeat,
    board: state.community,
    pot: state.pot,
    winners: state.winners,
    reveals: state.results.map((r) => ({
      seat: r.seat,
      holeCards: state.players[r.seat].holeCards,
      category: r.hand.category,
      ranks: r.hand.ranks,
    })),
    deltas,
    seats,
  };
}

export class PokerTableDO extends DurableObject<Env> {
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
        dealer_seat INTEGER,
        ever_seated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    // Unlike GameTableDO/LiarsBarTableDO, seat rows here are transient — a
    // seat is deleted (not merely marked disconnected) once its occupant
    // leaves for good, so a freed seat number can be reused by a new
    // connectee. leave_pending marks a seat that's committed to leaving but
    // is still part of the hand in progress (see the file header).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS seats (
        seat INTEGER PRIMARY KEY CHECK (seat BETWEEN 0 AND 7),
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0,
        leave_pending INTEGER NOT NULL DEFAULT 0
      )
    `);
    // No `aborted` column here — poker has no abort concept at all (see the
    // file header) — and the terminal (showdown/finished) state is kept
    // around after settlement (not nulled out) so forceSettle() can still
    // re-examine it, and so a between-hands broadcast keeps showing the last
    // hand's redacted outcome, exactly like GameTableDO/LiarsBarTableDO do.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT,
        settled INTEGER NOT NULL DEFAULT 0
      )
    `);
    // One row per seat currently mid-disconnect-grace during an active hand.
    // Cleared on reconnect, on settlement, and at the start of every fresh hand.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_disconnects (
        seat INTEGER PRIMARY KEY CHECK (seat BETWEEN 0 AND 7),
        username TEXT NOT NULL,
        deadline INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_override (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shuffled_deck_json TEXT NOT NULL,
        dealer_seat INTEGER NOT NULL
      )
    `);
  }

  // --- Lifecycle / lobby-facing RPC -----------------------------------------

  /**
   * Idempotent: a second call after the table is already initialized is a
   * harmless no-op ({ok:true}). Callable directly by LobbyDO or the
   * /api/tables/:tableId/init HTTP route (worker/src/routes/tables.ts).
   */
  async init(params: TableInitParams): Promise<InitResult> {
    if (this.loadMetaRow()) return { ok: true };

    if (params.gameId !== "poker") return { ok: false, reason: "unsupported-game" };
    if (!Number.isInteger(params.stake) || params.stake <= 0) {
      return { ok: false, reason: "invalid-stake" };
    }
    if (params.visibility !== "public" && params.visibility !== "private") {
      return { ok: false, reason: "invalid-visibility" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO table_meta (id, table_id, game_id, stake, visibility, invite_code, host_user_id, hand_no, dealer_seat, ever_seated, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)`,
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
      "INSERT OR REPLACE INTO test_override (id, shuffled_deck_json, dealer_seat) VALUES (1, ?, ?)",
      JSON.stringify(deal.shuffledDeck),
      deal.dealerSeat,
    );
  }

  /**
   * Re-runs settlement if the current hand is finished but not yet marked
   * settled locally. Idempotent (safe to call repeatedly): the credit_ledger
   * UNIQUE idempotency_key is the ultimate guard against double-pay if this
   * races a settlement that already landed. Exposed for ops/testing; no HTTP
   * route calls this from client input.
   */
  async forceSettle(): Promise<void> {
    await this.trySettle();
  }

  /**
   * Live occupancy + status snapshot for the lobby directory and
   * seat-reservation reconciliation. Null if uninitialized. See the file
   * header for why `finished` only ever fires once the table has held a
   * seat and now holds none — never merely "no hand is active right now",
   * and never merely "nobody has connected yet".
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

  /**
   * Used by LobbyDO's isUserInLiveGame / dead-table sweep. See
   * getSeatSummary()'s doc comment — unlike GameTableDO/LiarsBarTableDO,
   * this DO reports the exact same `finished` definition from both RPCs:
   * poker has no "matched but the hand never actually started" pre-game
   * phase worth distinguishing (being seated at all, even between hands, is
   * already a meaningful "part of this game" signal worth protecting from
   * the admin delete-user guard).
   */
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
      // A reconnect (including a plain page refresh) always cancels this
      // seat's pending disconnect-driven departure, regardless of hand phase.
      await this.cancelDisconnectGrace(seat);
    } else {
      // Seats are taken between hands only (see the file header) — a
      // brand-new connectee is refused outright while a hand is active,
      // exactly like a full table, rather than accepted as a spectator.
      if (this.isHandActive()) {
        return new Response("a hand is in progress — seats open again once it ends", { status: 409 });
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
        this.sendErrorToWs(ws, "no-active-hand", "no hand is currently in progress");
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
      console.error("PokerTableDO webSocketMessage failed", err);
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
   * reassigned (e.g. this very socket was force-closed by freeSeat() as part
   * of someone else's departure processing) — without this check, a new
   * occupant of the same seat number could otherwise be affected by a
   * disconnect event belonging to the seat's PREVIOUS occupant.
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
        // Between hands, a disconnect frees the seat immediately — no grace
        // period, since there's no in-flight pot at risk (see file header).
        await this.processLeavingSeat(attachment.seat);
      }
    }
  }

  // --- Game flow --------------------------------------------------------------

  private async handleReady(seat: Seat): Promise<void> {
    if (this.isHandActive()) {
      this.sendErrorToSeat(seat, "game-in-progress", "cannot ready up while a hand is active");
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
   * Client-driven leave (see ClientMessage's 'leave'), sent right before the
   * browser navigates away, OR a disconnect whose grace expired (see
   * forceFoldAndMarkLeaving). Unlike GameTableDO/LiarsBarTableDO, this never
   * ends the table for anyone else — see the file header's fold/leave state
   * machine summary.
   */
  private async processLeavingSeat(seat: Seat): Promise<void> {
    if (!this.isHandActive()) {
      this.freeSeat(seat);
      this.broadcastState();
      await this.maybeNotifyTableEmptied();
      return;
    }
    await this.forceFoldAndMarkLeaving(seat);
  }

  /**
   * Marks `seat` as leaving (freed once the current hand settles) and, if
   * it's already their turn in a live betting street, folds them right now.
   * Otherwise the fold happens automatically the instant action reaches them
   * — see resolveLeavers(), which every subsequent applyNewState() call
   * checks against. Shared by a deliberate leave and a disconnect-grace
   * expiry (see alarm()) — both are, from the hand's point of view, the
   * exact same event: this seat is not coming back for the rest of this hand.
   * Unlike GameTableDO/LiarsBarTableDO's abortHand, no username is needed
   * here — poker never broadcasts a leave/abort notice to the table (see the
   * file header: leaving is invisible to everyone else except through the
   * ordinary seat/fold state they'd see anyway).
   */
  private async forceFoldAndMarkLeaving(seat: Seat): Promise<void> {
    this.setLeavePending(seat, true);
    const state = this.loadGameState();
    if (!state) {
      this.broadcastState();
      return;
    }
    if (state.phase !== "showdown" && state.phase !== "finished" && state.currentTurn === seat) {
      await this.applyNewState(state);
    } else {
      // Not their turn (or the hand already reached a terminal phase) — the
      // leave_pending flag alone is enough for now; resolveLeavers() will
      // fold them the moment turn order actually reaches them, or the
      // post-settlement purge will simply free their already-decided seat.
      this.broadcastState();
    }
  }

  /**
   * Applies the engine's result of one action, after resolving any
   * leave-pending seat whose turn has now arrived (see resolveLeavers).
   */
  private async applyNewState(rawState: GameState): Promise<void> {
    const state = this.resolveLeavers(rawState);
    this.persistGameState(state);
    if (state.phase === "showdown" || state.phase === "finished") {
      // trySettle() broadcasts both the 'settled' message and the follow-up
      // 'state' frame itself (it also frees any leave-pending seats, which
      // the broadcast must reflect) — no separate broadcastState() here.
      await this.trySettle();
      return;
    }
    this.broadcastState();
  }

  /**
   * Starting from `state`, auto-folds the current turn holder for as long as
   * they're marked leave_pending, cascading if that fold itself hands the
   * turn to ANOTHER leave-pending seat (e.g. two players left mid-hand back
   * to back). A client is therefore never shown a turn belonging to a seat
   * that has already committed to leaving — the fold always happens before
   * the next broadcast, whether it was triggered by this seat's own leave
   * message or by an unrelated action from someone else that advanced the
   * turn onto them.
   */
  private resolveLeavers(state: GameState): GameState {
    let current = state;
    while (current.phase !== "showdown" && current.phase !== "finished" && this.isLeavePending(current.currentTurn)) {
      const result = applyAction(current, current.currentTurn, { type: "fold" });
      if (!result.ok) break; // defensive; a leave-pending seat's own turn can always legally fold
      current = result.state;
    }
    return current;
  }

  private async startNewHand(): Promise<void> {
    const meta = this.loadMetaRow();
    if (!meta) return;

    const seatRows = this.loadSeats();
    const seats = seatRows.map((s) => s.seat);
    const { deck, dealerSeat } = this.drawHandSetup(seats, meta.dealerSeat);
    const state = createGame({ seats, dealerSeat, stake: meta.stake, shuffledDeck: deck });

    const handNo = meta.handNo + 1;
    this.ctx.storage.sql.exec("UPDATE table_meta SET hand_no = ?, dealer_seat = ? WHERE id = 1", handNo, dealerSeat);
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 0");

    // Defensive: a fresh hand never starts holding a leftover grace timer
    // from a prior one (normally already empty by this point either way).
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.ctx.storage.deleteAlarm();

    this.persistGameState(state);
    this.broadcastState();
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
    await this.rearmDisconnectAlarm();
  }

  private async cancelDisconnectGrace(seat: Seat): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects WHERE seat = ?", seat);
    await this.rearmDisconnectAlarm();
  }

  /**
   * Multiple seats can be mid-grace at once; a DO has only one alarm, so
   * it's always armed for the earliest outstanding deadline. See
   * GameTableDO's identically-named method for the full rationale.
   */
  private async rearmDisconnectAlarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ deadline: number }>("SELECT MIN(deadline) as deadline FROM pending_disconnects")
      .toArray()[0];
    if (row?.deadline == null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(row.deadline);
    }
  }

  /**
   * In production this only ever runs once the platform's clock reaches the
   * armed deadline. Tests force it early via runDurableObjectAlarm — the
   * `stillConnected` check below is what makes that safe, exactly as in
   * GameTableDO/LiarsBarTableDO.
   */
  async alarm(): Promise<void> {
    if (!this.isHandActive()) {
      this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
      return;
    }

    const earliest = this.ctx.storage.sql
      .exec<PendingDisconnectRow>("SELECT seat, username, deadline FROM pending_disconnects ORDER BY deadline ASC LIMIT 1")
      .toArray()[0];
    if (!earliest) return;

    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects WHERE seat = ?", earliest.seat);
    const stillConnected = this.ctx.getWebSockets(`seat:${earliest.seat}`).length > 0;
    if (stillConnected) {
      await this.rearmDisconnectAlarm();
      return;
    }
    await this.forceFoldAndMarkLeaving(earliest.seat);
  }

  // --- Settlement ---------------------------------------------------------------

  private async ensureSettledIfNeeded(): Promise<void> {
    const row = this.loadGameStateRow();
    if (!row.stateJson || row.settled === 1) return;
    const state = JSON.parse(row.stateJson) as GameState;
    if (state.phase === "showdown" || state.phase === "finished") await this.trySettle();
  }

  private async trySettle(): Promise<void> {
    const row = this.loadGameStateRow();
    if (!row.stateJson) return;
    const state = JSON.parse(row.stateJson) as GameState;
    if (state.phase !== "showdown" && state.phase !== "finished") return;

    const meta = this.loadMetaRow();
    if (!meta) return;

    const seatRows = this.loadSeats();
    const deltas = settle(state);

    if (row.settled !== 1) {
      if (!state.seats.every((s) => seatRows.some((r) => r.seat === s))) {
        console.error("PokerTableDO: cannot settle — a seat row is missing for this hand's seats");
        return;
      }

      const stmts = [];
      for (const seat of state.seats) {
        const seatRow = seatRows.find((r) => r.seat === seat)!;
        const delta = deltas[seat];
        // A zero-delta seat (won exactly what they committed — only possible
        // for a synthetic/edge-case hand, not a real fold-out or showdown
        // pot) never gets a ledger row, matching GameTableDO/LiarsBarTableDO's
        // own skip.
        if (delta === 0) continue;
        const idempotencyKey = `settle:${meta.tableId}:${meta.handNo}:${seatRow.userId}`;
        stmts.push(
          this.env.DB.prepare(
            `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
             VALUES (?, ?, 'poker', 'game_settlement', ?)`,
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
           VALUES (?, 'poker', ?, ?, ?, ?)`,
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
          console.error("PokerTableDO settlement batch failed", err);
          throw err;
        }
        // Another attempt already landed this exact hand's ledger rows
        // (crash/retry race) — treat as already-settled, don't rethrow.
      }

      this.ctx.storage.sql.exec("UPDATE game_state SET settled = 1 WHERE id = 1");
    }

    await this.broadcastSettled(meta.handNo, seatRows, deltas);

    // Return to the ready phase: free any seat that left mid-hand (closing
    // their socket too, so a future occupant of the same seat number never
    // shares a hibernation tag with this stale connection — see freeSeat()),
    // and clear the disconnect-grace bookkeeping. The just-finished hand's
    // state_json is deliberately left in place (not nulled) so a client's
    // next 'state' frame still shows this hand's redacted outcome, and so a
    // repeated forceSettle() call can still find it.
    const leavers = seatRows.filter((s) => s.leavePending === 1).map((s) => s.seat);
    for (const seat of leavers) this.freeSeat(seat);
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.ctx.storage.deleteAlarm();

    this.broadcastState();
    await this.maybeNotifyTableEmptied();
  }

  /**
   * Best-effort notification to the lobby that this table is now genuinely,
   * verifiably empty (see getSeatSummary()'s doc comment on `finished`) —
   * NOT called after every settlement the way GameTableDO/LiarsBarTableDO's
   * notifyLobbyTableCleared runs unconditionally, since doing so here would
   * delete the LobbyDO row a still-occupied table needs to remain
   * discoverable by quickPlayVariableSeat's join-or-create scan (poker's
   * drop-in support depends on that row surviving between hands).
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
      console.error("PokerTableDO: failed to notify LobbyDO of table clearing", err);
    }
  }

  private async broadcastSettled(
    handNo: number,
    seatRows: readonly SeatRow[],
    deltas: Readonly<Record<Seat, number>>,
  ): Promise<void> {
    for (const seatRow of seatRows) {
      const sockets = this.ctx.getWebSockets(`seat:${seatRow.seat}`);
      if (sockets.length === 0) continue;
      const balanceRow = await this.env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(seatRow.userId)
        .first<{ credits: number }>();
      const msg: SettledMessage = { type: "settled", handNo, deltas, newBalance: balanceRow?.credits };
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
      };
    });

    for (const seat of ALL_SEATS) {
      const sockets = this.ctx.getWebSockets(`seat:${seat}`);
      if (sockets.length === 0) continue;
      const msg: StateMessage = {
        type: "state",
        handNo: meta.handNo,
        seats: seatStatuses,
        view: gameState ? viewFor(gameState, seat) : null,
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
   * Permanently removes a seat: deletes its row, AND closes any socket still
   * tagged to that seat number. The socket-close half is load-bearing, not
   * cosmetic — without it, a still-open (merely abandoned) connection from
   * the PREVIOUS occupant would keep sharing this seat's hibernation tag
   * (`seat:${seat}`), and a brand-new occupant later assigned the same freed
   * seat number would have their private state (hole cards) broadcast to
   * that stale socket too. handleSocketClosed()'s own stale-attachment guard
   * prevents the resulting close event from re-triggering leave processing.
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
   * True whenever a hand exists and hasn't finished being settled yet —
   * spans both a live betting street (preflop/flop/turn/river) AND the brief
   * showdown/finished-but-not-yet-settled window, so that a leave/disconnect
   * arriving during that window is still treated as "mid-hand" (leave_pending
   * + fold-if-your-turn) rather than "between hands" (free immediately).
   * Freeing a seat immediately is only safe once settlement has actually
   * completed — see trySettle(), which is the only place `settled` flips to
   * 1 — so gating on `settled` here (not just the engine's own phase) is
   * what keeps a in-flight settlement's own seat/userId reads safe from a
   * concurrent leave on a DIFFERENT seat.
   */
  private isHandActive(): boolean {
    const row = this.loadGameStateRow();
    if (!row.stateJson) return false;
    const state = JSON.parse(row.stateJson) as GameState;
    return !((state.phase === "showdown" || state.phase === "finished") && row.settled === 1);
  }

  // --- Storage helpers --------------------------------------------------------

  private loadMetaRow(): TableMetaRow | undefined {
    return this.ctx.storage.sql
      .exec<TableMetaRow>(
        `SELECT table_id as tableId, game_id as gameId, stake, visibility, invite_code as inviteCode,
                host_user_id as hostUserId, hand_no as handNo, dealer_seat as dealerSeat, ever_seated as everSeated
         FROM table_meta WHERE id = 1`,
      )
      .toArray()[0];
  }

  private loadSeats(): SeatRow[] {
    return this.ctx.storage.sql
      .exec<SeatRow>(
        "SELECT seat, user_id as userId, username, ready, leave_pending as leavePending FROM seats ORDER BY seat",
      )
      .toArray();
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
      .exec<TestOverrideRow>(
        "SELECT shuffled_deck_json as shuffledDeckJson, dealer_seat as dealerSeat FROM test_override WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return undefined;
    return { shuffledDeck: JSON.parse(row.shuffledDeckJson) as Card[], dealerSeat: row.dealerSeat as Seat };
  }

  private drawHandSetup(seats: readonly Seat[], previousDealer: number | null): { deck: Card[]; dealerSeat: Seat } {
    const override = this.loadTestOverride();
    if (override) {
      this.ctx.storage.sql.exec("DELETE FROM test_override WHERE id = 1");
      return { deck: (override.shuffledDeck as Card[]).slice(), dealerSeat: override.dealerSeat };
    }
    const deck = shuffleDeck(createDeck(), cryptoRandomSource);
    // previousDealer null means no hand has ever been played on this table;
    // nextDealerSeat(seats, -1) finds the first occupied seat greater than
    // -1, i.e. the lowest occupied seat — exactly "first hand: lowest seat".
    const dealerSeat = nextDealerSeat(seats, previousDealer ?? -1);
    return { deck, dealerSeat };
  }
}

function toEngineAction(msg: Exclude<ClientMessage, { type: "ready" } | { type: "leave" }>): Action {
  switch (msg.type) {
    case "fold":
      return { type: "fold" };
    case "check":
      return { type: "check" };
    case "call":
      return { type: "call" };
    case "bet":
      return { type: "bet", amount: msg.amount };
    case "raise":
      return { type: "raise", toAmount: msg.toAmount };
  }
}
