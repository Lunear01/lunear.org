import { DurableObject } from "cloudflare:workers";
import {
  SEATS,
  applyAction,
  createDeck,
  createGame,
  pickTableRank,
  rollBulletChamber,
  settle,
  shuffleDeck,
  startNextRound,
  viewFor,
  type Action,
  type Card,
  type FinishedState,
  type GameState,
  type PlayerStatus,
  type Seat,
  type TableRank,
} from "liarsbar";
import {
  parseClientMessage,
  type AbortedMessage,
  type ErrorCode,
  type ErrorMessage,
  type SeatStatus,
  type SettledMessage,
  type StateMessage,
} from "./liarsbar-protocol";
import { lobbyDoName } from "./lobby";
import type { InitResult, TableInitParams } from "./game-table";

export type { InitResult, TableInitParams };

// One DO per table (named by table id via env.LIARSBAR_TABLE_DO.getByName(tableId)).
// Mirrors GameTableDO (doudizhu's room DO) architecturally in every way that
// isn't specific to the rules difference: SQLite schema-in-DO with migrate(),
// WebSocket Hibernation API, per-seat redacted broadcasts, exactly-once D1
// settlement via ledger idempotency keys in one batch, abort-on-leave /
// 30s-disconnect-grace via a single alarm, notifyLobbyTableCleared, and
// rematch by round counter. Differences follow from the engine's own shape
// (games/liarsbar/src/game.ts): 4 seats instead of 3, no bidding phase (every
// hand is "play or challenge" from the first card dealt), and a mid-hand
// "roundEnd" signal state — a challenge just resolved and >1 seat is still
// alive — that this DO auto-advances past in the very same tick it's
// produced (see applyNewState): no timer/alarm infrastructure is needed for
// that "short server-side beat", since roundEnd is broadcast once (so clients
// can animate the reveal/spin) and then immediately superseded by the next
// dealt round's state.
//
// A hand mid-play (playing or the transient roundEnd) is VOID — aborted, no
// settlement — the instant a seat leaves for good: either a deliberate
// {type:'leave'} message, or a socket close that isn't followed by a
// reconnect within a 30s grace window, exactly as in GameTableDO.

/**
 * TEST-ONLY fixed setup, consumed by drawInitialSetup()/drawRoundSetup() in
 * place of a crypto-random shuffle/table-rank/bullet-roll/first-seat pick.
 * Set via setTestFixedDeal(), which is an RPC method only reachable by a
 * caller already holding an env.LIARSBAR_TABLE_DO binding (i.e. server-side
 * code in this Worker or a test) — no HTTP route in this repo ever forwards
 * client-supplied input into it, so no request from a real browser client can
 * reach it. Persists across every subsequent hand (round-end -> next-round
 * deals, and rematches) on the same table until this method is called again
 * — a test that wants a single deterministic script for an entire multi-hand
 * game (see test/liarsbar-table.test.ts) sets this once, up front; each
 * dealHands() call re-slices fresh 5-card hands out of the *same* fixed deck
 * for whichever seats are still alive, so the script stays fully predictable
 * hand after hand without the test needing to re-arm anything between them.
 */
export interface TestFixedDeal {
  readonly shuffledDeck: readonly Card[];
  readonly tableRank: TableRank;
  readonly bulletPositions: Readonly<Record<Seat, number>>;
  readonly firstSeat: Seat;
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
  round: number;
}

interface SeatRow {
  [key: string]: SqlStorageValue;
  seat: Seat;
  userId: string;
  username: string;
  ready: 0 | 1;
}

interface GameStateRow {
  [key: string]: SqlStorageValue;
  stateJson: string | null;
  settled: 0 | 1;
  aborted: 0 | 1;
  abortedSeat: number | null;
  abortedUsername: string | null;
}

interface PendingDisconnectRow {
  [key: string]: SqlStorageValue;
  seat: Seat;
  username: string;
  deadline: number;
}

// A disconnect during an active hand gets this long to reconnect before the
// hand is voided. Same value as GameTableDO — generous enough to survive a
// page refresh comfortably.
const DISCONNECT_GRACE_MS = 30_000;

interface TestOverrideRow {
  [key: string]: SqlStorageValue;
  shuffledDeckJson: string;
  tableRank: TableRank;
  bulletPositionsJson: string;
  firstSeat: number;
}

function cryptoRandomSource(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

/** Rebuilt field-by-field (never spread) so a secret bulletChamber can never
 * leak into the D1 result archive, matching the engine's own viewFor
 * discipline (see game.ts's publicPlayers, which this mirrors — that helper
 * isn't part of the package's public API, so it's re-derived here). */
function publicPlayersSummary(
  players: Readonly<Record<Seat, PlayerStatus>>,
): Record<Seat, { alive: boolean; pulls: number }> {
  return {
    0: { alive: players[0].alive, pulls: players[0].pulls },
    1: { alive: players[1].alive, pulls: players[1].pulls },
    2: { alive: players[2].alive, pulls: players[2].pulls },
    3: { alive: players[3].alive, pulls: players[3].pulls },
  };
}

function buildResultSummary(
  state: FinishedState,
  deltas: Readonly<Record<Seat, number>>,
  seats: readonly SeatRow[],
) {
  return {
    winner: state.winner,
    baseStake: state.baseStake,
    players: publicPlayersSummary(state.players),
    lastReveal: state.lastReveal,
    deltas,
    seats: Object.fromEntries(
      seats.map((s) => [s.seat, { userId: s.userId, username: s.username }]),
    ),
  };
}

export class LiarsBarTableDO extends DurableObject<Env> {
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
        round INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS seats (
        seat INTEGER PRIMARY KEY CHECK (seat IN (0, 1, 2, 3)),
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Unlike GameTableDO, this DO has no pre-existing instances that predate
    // the abort columns, so they're just part of the initial schema here —
    // no ALTER-TABLE backfill dance is needed.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT,
        settled INTEGER NOT NULL DEFAULT 0,
        aborted INTEGER NOT NULL DEFAULT 0,
        aborted_seat INTEGER,
        aborted_username TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_override (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shuffled_deck_json TEXT NOT NULL,
        table_rank TEXT NOT NULL,
        bullet_positions_json TEXT NOT NULL,
        first_seat INTEGER NOT NULL
      )
    `);
    // One row per seat currently mid-disconnect-grace during an active hand
    // (see the file-header comment). Cleared on reconnect, on abort, and at
    // the start of every fresh hand.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_disconnects (
        seat INTEGER PRIMARY KEY CHECK (seat IN (0, 1, 2, 3)),
        username TEXT NOT NULL,
        deadline INTEGER NOT NULL
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

    if (params.gameId !== "liarsbar") return { ok: false, reason: "unsupported-game" };
    if (!Number.isInteger(params.stake) || params.stake <= 0) {
      return { ok: false, reason: "invalid-stake" };
    }
    if (params.visibility !== "public" && params.visibility !== "private") {
      return { ok: false, reason: "invalid-visibility" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO table_meta (id, table_id, game_id, stake, visibility, invite_code, host_user_id, round, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)`,
      params.tableId,
      params.gameId,
      params.stake,
      params.visibility,
      params.inviteCode ?? null,
      params.hostUserId,
      new Date().toISOString(),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO game_state (id, state_json, settled) VALUES (1, NULL, 0)",
    );

    return { ok: true };
  }

  /** See TestFixedDeal's doc comment for why this is safe to expose as RPC. */
  async setTestFixedDeal(deal: TestFixedDeal): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO test_override (id, shuffled_deck_json, table_rank, bullet_positions_json, first_seat)
       VALUES (1, ?, ?, ?, ?)`,
      JSON.stringify(deal.shuffledDeck),
      deal.tableRank,
      JSON.stringify(deal.bulletPositions),
      deal.firstSeat,
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
   * seat-reservation reconciliation. Null if uninitialized. See GameTableDO's
   * identically-named method for the full doc on why `finished` here is
   * deliberately narrower than getLiveness()'s same-named field.
   */
  async getSeatSummary(): Promise<
    | { seatsFilled: number; seatsTotal: number; settled: boolean; finished: boolean; anyConnected: boolean }
    | null
  > {
    const meta = this.loadMetaRow();
    if (!meta) return null;
    const row = this.loadGameStateRow();
    const state = row.stateJson ? (JSON.parse(row.stateJson) as GameState) : null;
    return {
      seatsFilled: this.loadSeats().length,
      seatsTotal: SEATS.length,
      settled: row.settled === 1,
      finished: row.settled === 1 || row.aborted === 1 || state?.phase === "finished",
      anyConnected: this.ctx.getWebSockets().length > 0,
    };
  }

  /**
   * Used by LobbyDO's isUserInLiveGame / dead-table sweep. See GameTableDO's
   * identically-named method for the full doc on the finished/settled/
   * anyConnected semantics this mirrors exactly.
   */
  async getLiveness(): Promise<{ finished: boolean; settled: boolean; anyConnected: boolean }> {
    if (!this.loadMetaRow()) return { finished: true, settled: false, anyConnected: false };
    const row = this.loadGameStateRow();
    const state = row.stateJson ? (JSON.parse(row.stateJson) as GameState) : null;
    const finished = row.settled === 1 || state === null || state.phase === "finished";
    return {
      finished,
      settled: row.settled === 1,
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

    const seats = this.loadSeats();
    const existing = seats.find((s) => s.userId === userId);
    let seat: Seat;
    if (existing) {
      seat = existing.seat;
      if (existing.username !== username) {
        this.ctx.storage.sql.exec("UPDATE seats SET username = ? WHERE seat = ?", username, seat);
      }
      // A reconnect (including a plain page refresh) always cancels this
      // seat's pending disconnect-abort, regardless of hand phase.
      await this.cancelDisconnectGrace(seat);
    } else {
      const taken = new Set(seats.map((s) => s.seat));
      const free = SEATS.find((s) => !taken.has(s));
      if (free === undefined) return new Response("table is full", { status: 409 });
      seat = free;
      this.ctx.storage.sql.exec(
        "INSERT INTO seats (seat, user_id, username, ready) VALUES (?, ?, ?, 0)",
        seat,
        userId,
        username,
      );
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
        await this.handleLeave(seat, attachment.username);
        return;
      }

      if (this.isAborted()) {
        this.sendErrorToWs(ws, "table-aborted", "This game has ended — start a new table.");
        return;
      }

      await this.ensureSettledIfNeeded();

      if (parsed.type === "ready") {
        await this.handleReady(seat);
        return;
      }

      if (!this.hasActiveHand()) {
        this.sendErrorToWs(ws, "no-active-hand", "no hand is currently in progress");
        return;
      }
      const state = this.loadGameState()!;
      const action: Action =
        parsed.type === "challenge" ? { type: "challenge" } : { type: "play", cardIds: parsed.cardIds };

      const result = applyAction(state, seat, action);
      if (!result.ok) {
        this.sendErrorToWs(ws, result.reason, result.reason);
        return;
      }
      await this.applyNewState(result.state);
    } catch (err) {
      console.error("LiarsBarTableDO webSocketMessage failed", err);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  /**
   * Shared by both terminal hibernation events. See GameTableDO's
   * identically-named method for why "no socket left for this seat" is a
   * reliable disconnect signal by the time either event fires.
   */
  private async handleSocketClosed(ws: WebSocket): Promise<void> {
    this.broadcastState();
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || this.isAborted() || !this.hasActiveHand()) return;
    const stillConnected = this.ctx.getWebSockets(`seat:${attachment.seat}`).length > 0;
    if (!stillConnected) {
      await this.scheduleDisconnectGrace(attachment.seat, attachment.username);
    }
  }

  // --- Game flow --------------------------------------------------------------

  private async handleReady(seat: Seat): Promise<void> {
    if (this.isAborted()) {
      this.sendErrorToSeat(seat, "table-aborted", "This game has ended — start a new table.");
      return;
    }
    if (!this.isWaitingForReady()) {
      this.sendErrorToSeat(seat, "game-in-progress", "cannot ready up while a hand is active");
      return;
    }
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 1 WHERE seat = ?", seat);
    const seats = this.loadSeats();
    if (seats.length === SEATS.length && seats.every((s) => s.ready === 1)) {
      await this.startNewMatch();
    } else {
      this.broadcastState();
    }
  }

  /**
   * Client-driven leave (see ClientMessage's 'leave'), sent right before the
   * browser navigates away. During an active hand this ends the game for
   * everyone immediately — no grace period, unlike a bare disconnect. Outside
   * an active hand (waiting/ready, or a finished-but-not-yet-readied hand)
   * this is a no-op: the seat just shows disconnected once the socket
   * actually closes, same as it always has.
   */
  private async handleLeave(seat: Seat, username: string): Promise<void> {
    if (this.isAborted() || !this.hasActiveHand()) return;
    await this.abortHand(seat, username);
  }

  /**
   * Applies the engine's result of one action. Unlike doudizhu (whose only
   * mid-hand signal state is "redeal", handled by starting an entirely new
   * hand), Liar's Bar's "roundEnd" is a *mid-hand* checkpoint: a challenge
   * just resolved, someone spun, and — by the engine's own invariant
   * (resolveChallenge only ever returns roundEnd when >1 seat is still
   * alive; a lone survivor goes straight to "finished") — there's always a
   * next round to deal. So roundEnd is broadcast once, so every client can
   * show the reveal/spin drama, and then immediately (same tick, no
   * timer/alarm) superseded by the freshly-dealt next round — this is the
   * "short server-side beat" the client is expected to animate through on
   * its own, not something this DO waits on.
   */
  private async applyNewState(state: GameState): Promise<void> {
    if (state.phase === "roundEnd") {
      this.persistGameState(state);
      this.broadcastState();

      const { deck, tableRank } = this.drawRoundSetup();
      const next = startNextRound(state, { shuffledDeck: deck, tableRank });
      this.persistGameState(next);
      this.broadcastState();
      return;
    }

    this.persistGameState(state);

    if (state.phase === "finished") {
      await this.trySettle();
      this.broadcastState();
      return;
    }

    this.broadcastState();
  }

  private async startNewMatch(): Promise<void> {
    const meta = this.loadMetaRow();
    if (!meta) return;

    const { deck, tableRank, bulletPositions, firstSeat } = this.drawInitialSetup();
    const state = createGame({
      shuffledDeck: deck,
      tableRank,
      bulletPositions,
      firstSeat,
      baseStake: meta.stake,
    });

    this.ctx.storage.sql.exec("UPDATE table_meta SET round = round + 1 WHERE id = 1");
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 0");

    // Defensive: a fresh hand never starts holding a leftover grace timer
    // from a prior one (normally already empty by this point either way).
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.ctx.storage.deleteAlarm();

    this.persistGameState(state);
    this.broadcastState();
  }

  // --- Abort (deliberate leave, or disconnect grace expiry) --------------------

  /**
   * Voids the current hand: no settlement, no ledger writes, no credit
   * changes — the table's game_state row is marked `aborted` and its
   * state_json cleared so every seat's next `state` broadcast carries
   * `view: null`. Idempotent. See GameTableDO's abortHand for the full
   * rationale on why an aborted table never resumes (ready-up is refused
   * forever; players must start a new table) — identical policy here.
   */
  private async abortHand(seat: Seat, username: string): Promise<void> {
    if (this.isAborted()) return;
    const meta = this.loadMetaRow();
    if (!meta) return;

    this.ctx.storage.sql.exec(
      "UPDATE game_state SET state_json = NULL, settled = 0, aborted = 1, aborted_seat = ?, aborted_username = ? WHERE id = 1",
      seat,
      username,
    );
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.ctx.storage.deleteAlarm();

    this.broadcastAborted(seat, username);
    this.broadcastState();
    await this.notifyLobbyTableCleared(meta.gameId, meta.tableId);
  }

  private broadcastAborted(seat: Seat, username: string): void {
    const msg: AbortedMessage = { type: "aborted", leaver: { seat, username } };
    const json = JSON.stringify(msg);
    for (const s of SEATS) {
      for (const ws of this.ctx.getWebSockets(`seat:${s}`)) {
        try {
          ws.send(json);
        } catch {
          /* socket may have just closed */
        }
      }
    }
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
   * GameTableDO.
   */
  async alarm(): Promise<void> {
    if (this.isAborted() || !this.hasActiveHand()) {
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
    await this.abortHand(earliest.seat, earliest.username);
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

    const seats = this.loadSeats();
    const deltas = settle(state);

    if (row.settled === 1) {
      await this.broadcastSettled(meta.round, seats, deltas);
      await this.notifyLobbyTableCleared(meta.gameId, meta.tableId);
      return;
    }

    if (seats.length !== SEATS.length) {
      console.error("LiarsBarTableDO: cannot settle without all seats filled");
      return;
    }

    // Zero-amount deltas never occur for a real, engine-produced FinishedState
    // (a 4-seat game always finishes with exactly 3 eliminations, so every
    // seat is either the winner or -baseStake — see settle()'s own doc
    // comment on why 0 is theoretically possible only for a synthetic
    // FinishedState no real game reaches) — but a ledger row's amount is
    // meant to record a meaningful balance change, so a would-be 0 row (and
    // its matching credits no-op update) is skipped rather than written.
    const stmts = [];
    for (const seat of SEATS) {
      const seatRow = seats.find((s) => s.seat === seat)!;
      const delta = deltas[seat];
      if (delta === 0) continue;
      const idempotencyKey = `settle:${meta.tableId}:${meta.round}:${seatRow.userId}`;
      stmts.push(
        this.env.DB.prepare(
          `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
           VALUES (?, ?, 'liarsbar', 'game_settlement', ?)`,
        ).bind(seatRow.userId, delta, idempotencyKey),
      );
      stmts.push(
        this.env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(
          delta,
          seatRow.userId,
        ),
      );
    }
    const gameRowId = `${meta.tableId}:${meta.round}`;
    stmts.push(
      this.env.DB.prepare(
        `INSERT INTO games (id, game_id, stake, result_json, table_id, round)
         VALUES (?, 'liarsbar', ?, ?, ?, ?)`,
      ).bind(
        gameRowId,
        meta.stake,
        JSON.stringify(buildResultSummary(state, deltas, seats)),
        meta.tableId,
        meta.round,
      ),
    );

    try {
      await this.env.DB.batch(stmts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("UNIQUE")) {
        console.error("LiarsBarTableDO settlement batch failed", err);
        throw err;
      }
      // Another attempt already landed this exact round's ledger rows
      // (crash/retry race) — treat as already-settled, don't rethrow.
    }

    this.ctx.storage.sql.exec("UPDATE game_state SET settled = 1 WHERE id = 1");
    await this.broadcastSettled(meta.round, seats, deltas);
    await this.notifyLobbyTableCleared(meta.gameId, meta.tableId);
  }

  // Best-effort, run only after the settlement/abort broadcast — see
  // GameTableDO's identically-named method for the full rationale. Reuses
  // LobbyDO's existing notifySettled RPC, agnostic to *why* the table ended.
  private async notifyLobbyTableCleared(gameId: string, tableId: string): Promise<void> {
    try {
      await this.env.LOBBY_DO.getByName(lobbyDoName(gameId)).notifySettled(tableId);
    } catch (err) {
      console.error("LiarsBarTableDO: failed to notify LobbyDO of table clearing", err);
    }
  }

  private async broadcastSettled(
    round: number,
    seats: readonly SeatRow[],
    deltas: Readonly<Record<Seat, number>>,
  ): Promise<void> {
    for (const seatRow of seats) {
      const sockets = this.ctx.getWebSockets(`seat:${seatRow.seat}`);
      if (sockets.length === 0) continue;
      const balanceRow = await this.env.DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(seatRow.userId)
        .first<{ credits: number }>();
      const msg: SettledMessage = { type: "settled", round, deltas, newBalance: balanceRow?.credits };
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
    const seats = this.loadSeats();
    const gameState = this.loadGameState();

    const seatStatuses: SeatStatus[] = SEATS.map((seat) => {
      const row = seats.find((s) => s.seat === seat);
      return {
        seat,
        userId: row?.userId ?? null,
        username: row?.username ?? null,
        connected: this.ctx.getWebSockets(`seat:${seat}`).length > 0,
        ready: row?.ready === 1,
      };
    });

    for (const seat of SEATS) {
      const sockets = this.ctx.getWebSockets(`seat:${seat}`);
      if (sockets.length === 0) continue;
      const msg: StateMessage = {
        type: "state",
        round: meta.round,
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

  // --- State predicates -----------------------------------------------------

  private isAborted(): boolean {
    return this.loadGameStateRow().aborted === 1;
  }

  private isWaitingForReady(): boolean {
    if (this.isAborted()) return false;
    const row = this.loadGameStateRow();
    if (!row.stateJson) return true;
    const state = JSON.parse(row.stateJson) as GameState;
    return state.phase === "finished" && row.settled === 1;
  }

  /**
   * "roundEnd" is included defensively alongside "playing": by construction
   * (see applyNewState's doc comment) it's never actually the resting state
   * between messages — a roundEnd is always synchronously superseded by the
   * next dealt round or a settlement in the same DO invocation that produced
   * it — but treating it as active here costs nothing and keeps abort/leave
   * semantics correct even if that invariant ever changes.
   */
  private hasActiveHand(): boolean {
    if (this.isAborted()) return false;
    const state = this.loadGameState();
    return state !== null && (state.phase === "playing" || state.phase === "roundEnd");
  }

  // --- Storage helpers --------------------------------------------------------

  private loadMetaRow(): TableMetaRow | undefined {
    return this.ctx.storage.sql
      .exec<TableMetaRow>(
        `SELECT table_id as tableId, game_id as gameId, stake, visibility,
                invite_code as inviteCode, host_user_id as hostUserId, round
         FROM table_meta WHERE id = 1`,
      )
      .toArray()[0];
  }

  private loadSeats(): SeatRow[] {
    return this.ctx.storage.sql
      .exec<SeatRow>("SELECT seat, user_id as userId, username, ready FROM seats ORDER BY seat")
      .toArray();
  }

  private loadGameStateRow(): GameStateRow {
    const row = this.ctx.storage.sql
      .exec<GameStateRow>(
        `SELECT state_json as stateJson, settled, aborted,
                aborted_seat as abortedSeat, aborted_username as abortedUsername
         FROM game_state WHERE id = 1`,
      )
      .toArray()[0];
    return row ?? { stateJson: null, settled: 0, aborted: 0, abortedSeat: null, abortedUsername: null };
  }

  private loadGameState(): GameState | null {
    const row = this.loadGameStateRow();
    return row.stateJson ? (JSON.parse(row.stateJson) as GameState) : null;
  }

  private persistGameState(state: GameState | null): void {
    this.ctx.storage.sql.exec(
      "UPDATE game_state SET state_json = ?, settled = 0 WHERE id = 1",
      state ? JSON.stringify(state) : null,
    );
  }

  private loadTestOverride(): TestFixedDeal | undefined {
    const row = this.ctx.storage.sql
      .exec<TestOverrideRow>(
        `SELECT shuffled_deck_json as shuffledDeckJson, table_rank as tableRank,
                bullet_positions_json as bulletPositionsJson, first_seat as firstSeat
         FROM test_override WHERE id = 1`,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      shuffledDeck: JSON.parse(row.shuffledDeckJson) as Card[],
      tableRank: row.tableRank,
      bulletPositions: JSON.parse(row.bulletPositionsJson) as Record<Seat, number>,
      firstSeat: row.firstSeat as Seat,
    };
  }

  /** Used only when starting a brand-new match (fresh createGame call): needs
   * every input the engine's CreateGameOptions takes, including the
   * once-per-match bullet chamber positions and first seat. */
  private drawInitialSetup(): {
    deck: Card[];
    tableRank: TableRank;
    bulletPositions: Record<Seat, number>;
    firstSeat: Seat;
  } {
    const override = this.loadTestOverride();
    if (override) {
      return {
        deck: (override.shuffledDeck as Card[]).slice(),
        tableRank: override.tableRank,
        bulletPositions: { ...override.bulletPositions },
        firstSeat: override.firstSeat,
      };
    }
    const deck = shuffleDeck(createDeck(), cryptoRandomSource);
    const tableRank = pickTableRank(cryptoRandomSource);
    const bulletPositions: Record<Seat, number> = {
      0: rollBulletChamber(cryptoRandomSource),
      1: rollBulletChamber(cryptoRandomSource),
      2: rollBulletChamber(cryptoRandomSource),
      3: rollBulletChamber(cryptoRandomSource),
    };
    const firstSeat = (crypto.getRandomValues(new Uint32Array(1))[0] % SEATS.length) as Seat;
    return { deck, tableRank, bulletPositions, firstSeat };
  }

  /** Used for every mid-match round transition (roundEnd -> startNextRound):
   * only a fresh deck + table rank are needed, since bulletChamber positions
   * and alive/pulls status carry over on `state.players` untouched. */
  private drawRoundSetup(): { deck: Card[]; tableRank: TableRank } {
    const override = this.loadTestOverride();
    if (override) {
      return { deck: (override.shuffledDeck as Card[]).slice(), tableRank: override.tableRank };
    }
    return { deck: shuffleDeck(createDeck(), cryptoRandomSource), tableRank: pickTableRank(cryptoRandomSource) };
  }
}
