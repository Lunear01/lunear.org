import { DurableObject } from "cloudflare:workers";
import {
  SEATS,
  applyAction,
  gameDefinition,
  createDeck,
  createGame,
  settle,
  shuffleDeck,
  viewFor,
  type Action,
  type Card,
  type FinishedState,
  type GameState,
  type Seat,
} from "chudaidi";
import {
  parseClientMessage,
  type AbortedMessage,
  type ErrorCode,
  type ErrorMessage,
  type SeatStatus,
  type SettledMessage,
  type StateMessage,
} from "./chudaidi-protocol";
import { lobbyDoName } from "./lobby";
import { toSkinId } from "../shop/catalog";
import type { InitResult, TableInitParams } from "./game-table";

export type { InitResult, TableInitParams };

// One DO per table (env.CHUDAIDI_TABLE_DO.getByName(tableId)). Same room
// model as LiarsBarTableDO: 2-4 seats, a hand starts once every seated player
// (at least minSeats) is ready, whoever sits mid-hand waits for the next one,
// abort-on-leave with a 30s disconnect grace driven by one alarm, exactly-once
// D1 settlement keyed by `settle:<tableId>:<round>:<userId>`, rematch by round
// counter. A hand is one deal: it finishes when a seat goes out and settles
// at once, like GameTableDO (doudizhu).

/**
 * TEST-ONLY fixed deal, used by drawDeck() instead of a crypto-random
 * shuffle. Set via setTestFixedDeal(), an RPC reachable only by code holding
 * the CHUDAIDI_TABLE_DO binding; no HTTP route forwards client input into it.
 * Persists for every later hand on the table until set again.
 */
export interface TestFixedDeal {
  readonly shuffledDeck: readonly Card[];
}

interface SocketAttachment {
  readonly seat: Seat;
  readonly userId: string;
  readonly username: string;
}

// Row interfaces carry a string index signature to satisfy SqlStorageCursor's bound.
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
  credits: number;
  /** Cached D1 users.card_skin; NULL = classic. */
  cardSkin: string | null;
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

interface TestOverrideRow {
  [key: string]: SqlStorageValue;
  shuffledDeckJson: string;
}

const DISCONNECT_GRACE_MS = 30_000;

function cryptoRandomSource(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function buildResultSummary(state: FinishedState, deltas: Readonly<Record<Seat, number>>, seats: readonly SeatRow[]) {
  return {
    winner: state.winner,
    baseStake: state.baseStake,
    activeSeats: state.activeSeats,
    cardsLeft: Object.fromEntries(state.activeSeats.map((s) => [s, state.hands[s].length])),
    deltas,
    seats: Object.fromEntries(
      seats
        .filter((s) => state.activeSeats.includes(s.seat))
        .map((s) => [s.seat, { userId: s.userId, username: s.username }]),
    ),
  };
}

export class ChuDaiDTableDO extends DurableObject<Env> {
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
        ready INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0,
        card_skin TEXT
      )
    `);
    // Seat tables created before skins lack the column; CREATE IF NOT EXISTS won't add it.
    const seatCols = new Set(
      this.ctx.storage.sql
        .exec(`SELECT name FROM pragma_table_info('seats')`)
        .toArray()
        .map((r) => r.name as string),
    );
    if (!seatCols.has("card_skin")) {
      this.ctx.storage.sql.exec(`ALTER TABLE seats ADD COLUMN card_skin TEXT`);
    }
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
        shuffled_deck_json TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_disconnects (
        seat INTEGER PRIMARY KEY CHECK (seat IN (0, 1, 2, 3)),
        username TEXT NOT NULL,
        deadline INTEGER NOT NULL
      )
    `);
  }

  // --- Lifecycle / lobby-facing RPC -----------------------------------------

  /** Idempotent: a second call after initialization is a no-op {ok:true}. */
  async init(params: TableInitParams): Promise<InitResult> {
    if (this.loadMetaRow()) return { ok: true };

    if (params.gameId !== "chudaidi") return { ok: false, reason: "unsupported-game" };
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
    this.ctx.storage.sql.exec("INSERT INTO game_state (id, state_json, settled) VALUES (1, NULL, 0)");

    return { ok: true };
  }

  /** See TestFixedDeal. */
  async setTestFixedDeal(deal: TestFixedDeal): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO test_override (id, shuffled_deck_json) VALUES (1, ?)",
      JSON.stringify(deal.shuffledDeck),
    );
  }

  /** Re-runs settlement for a finished, unsettled hand. Idempotent via the ledger's UNIQUE key. */
  async forceSettle(): Promise<void> {
    await this.trySettle();
  }

  /** Occupancy + status for the lobby directory. Null if uninitialized. */
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

  /** Used by LobbyDO's isUserInLiveGame and dead-table sweep. */
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

    await this.refreshSeatCredits([userId]);

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
      const action: Action = parsed.type === "pass" ? { type: "pass" } : { type: "play", cardIds: parsed.cardIds };

      const result = applyAction(state, seat, action);
      if (!result.ok) {
        this.sendErrorToWs(ws, result.reason, result.reason);
        return;
      }
      await this.applyNewState(result.state);
    } catch (err) {
      console.error("ChuDaiDTableDO webSocketMessage failed", err);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleSocketClosed(ws);
  }

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
    if (seats.length >= gameDefinition.minSeats && seats.every((s) => s.ready === 1)) {
      await this.startNewHand();
    } else {
      this.broadcastState();
    }
  }

  /** Mid-hand leave aborts for everyone at once; outside a hand it is a no-op. */
  private async handleLeave(seat: Seat, username: string): Promise<void> {
    if (this.isAborted() || !this.hasActiveHand()) return;
    await this.abortHand(seat, username);
  }

  private async applyNewState(state: GameState): Promise<void> {
    this.persistGameState(state);
    if (state.phase === "finished") {
      await this.trySettle();
    }
    this.broadcastState();
  }

  private async startNewHand(): Promise<void> {
    const meta = this.loadMetaRow();
    if (!meta) return;

    const activeSeats = this.loadSeats().map((s) => s.seat);
    const state = createGame({ shuffledDeck: this.drawDeck(), activeSeats, baseStake: meta.stake });

    this.ctx.storage.sql.exec("UPDATE table_meta SET round = round + 1 WHERE id = 1");
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 0");
    this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
    await this.ctx.storage.deleteAlarm();

    this.persistGameState(state);
    this.broadcastState();
  }

  // --- Abort (deliberate leave, or disconnect grace expiry) --------------------

  /** Voids the hand: no settlement. An aborted table never resumes. Idempotent. */
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

  /** One alarm per DO: always armed for the earliest outstanding deadline. */
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

  async alarm(): Promise<void> {
    if (this.isAborted() || !this.hasActiveHand()) {
      this.ctx.storage.sql.exec("DELETE FROM pending_disconnects");
      return;
    }

    const earliest = this.ctx.storage.sql
      .exec<PendingDisconnectRow>(
        "SELECT seat, username, deadline FROM pending_disconnects ORDER BY deadline ASC LIMIT 1",
      )
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

    // Zero deltas belong to seats outside the hand; no ledger row for them.
    const stmts = [];
    for (const seat of SEATS) {
      const delta = deltas[seat];
      if (delta === 0) continue;
      const seatRow = seats.find((s) => s.seat === seat);
      if (!seatRow) {
        console.error(`ChuDaiDTableDO: cannot settle — seat ${seat} owes ${delta} but has no seat row`);
        return;
      }
      const idempotencyKey = `settle:${meta.tableId}:${meta.round}:${seatRow.userId}`;
      stmts.push(
        this.env.DB.prepare(
          `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
           VALUES (?, ?, 'chudaidi', 'game_settlement', ?)`,
        ).bind(seatRow.userId, delta, idempotencyKey),
      );
      stmts.push(
        this.env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(delta, seatRow.userId),
      );
    }
    const gameRowId = `${meta.tableId}:${meta.round}`;
    stmts.push(
      this.env.DB.prepare(
        `INSERT INTO games (id, game_id, stake, result_json, table_id, round)
         VALUES (?, 'chudaidi', ?, ?, ?, ?)`,
      ).bind(gameRowId, meta.stake, JSON.stringify(buildResultSummary(state, deltas, seats)), meta.tableId, meta.round),
    );

    try {
      await this.env.DB.batch(stmts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("UNIQUE")) {
        console.error("ChuDaiDTableDO settlement batch failed", err);
        throw err;
      }
      // This round's ledger rows already landed (crash/retry race).
    }

    this.ctx.storage.sql.exec("UPDATE game_state SET settled = 1 WHERE id = 1");
    await this.broadcastSettled(meta.round, seats, deltas);
    await this.notifyLobbyTableCleared(meta.gameId, meta.tableId);
  }

  private async notifyLobbyTableCleared(gameId: string, tableId: string): Promise<void> {
    try {
      await this.env.LOBBY_DO.getByName(lobbyDoName(gameId)).notifySettled(tableId);
    } catch (err) {
      console.error("ChuDaiDTableDO: failed to notify LobbyDO of table clearing", err);
    }
  }

  private async broadcastSettled(
    round: number,
    seats: readonly SeatRow[],
    deltas: Readonly<Record<Seat, number>>,
  ): Promise<void> {
    await this.refreshSeatCredits(seats.map((s) => s.userId));
    const freshSeats = this.loadSeats();

    for (const seatRow of seats) {
      const sockets = this.ctx.getWebSockets(`seat:${seatRow.seat}`);
      if (sockets.length === 0) continue;
      const newBalance = freshSeats.find((s) => s.seat === seatRow.seat)?.credits;
      const msg: SettledMessage = { type: "settled", round, deltas, newBalance };
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

  /** One D1 query refreshing the cached credits of every given user's seat row. */
  private async refreshSeatCredits(userIds: readonly string[]): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.env.DB.prepare(
      `SELECT id, credits, card_skin as cardSkin FROM users WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ id: string; credits: number; cardSkin: string | null }>();
    for (const row of results) {
      this.ctx.storage.sql.exec(
        "UPDATE seats SET credits = ?, card_skin = ? WHERE user_id = ?",
        row.credits,
        row.cardSkin,
        row.id,
      );
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
        credits: row?.credits ?? 0,
        cardSkin: toSkinId(row?.cardSkin),
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

  private hasActiveHand(): boolean {
    if (this.isAborted()) return false;
    const state = this.loadGameState();
    return state !== null && state.phase === "playing";
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
      .exec<SeatRow>(
        "SELECT seat, user_id as userId, username, ready, credits, card_skin as cardSkin FROM seats ORDER BY seat",
      )
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

  private drawDeck(): Card[] {
    const row = this.ctx.storage.sql
      .exec<TestOverrideRow>("SELECT shuffled_deck_json as shuffledDeckJson FROM test_override WHERE id = 1")
      .toArray()[0];
    if (row) return JSON.parse(row.shuffledDeckJson) as Card[];
    return shuffleDeck(createDeck(), cryptoRandomSource);
  }
}
