import { DurableObject } from "cloudflare:workers";
import {
  SEATS,
  applyAction,
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
} from "doudizhu";
import { parseClientMessage, type ErrorCode, type ErrorMessage, type SeatStatus, type SettledMessage, type StateMessage } from "./protocol";
import { lobbyDoName } from "./lobby";

// One DO per table (named by table id via env.GAME_TABLE_DO.getByName(tableId)).
// Owns: seating, ready-up, driving the doudizhu engine, redacted broadcasts,
// and exactly-once settlement to D1's credit ledger. No per-turn countdown —
// removed; a turn simply waits for the acting seat's input indefinitely.

export interface TableInitParams {
  readonly tableId: string;
  readonly gameId: string;
  readonly stake: number;
  readonly visibility: "public" | "private";
  readonly inviteCode?: string;
  readonly hostUserId: string;
}

export type InitResult = { ok: true } | { ok: false; reason: string };

/**
 * TEST-ONLY fixed deal, consumed by drawDeckAndFirstBidder() in place of a
 * crypto-random shuffle/first-bidder. Set via setTestFixedDeal(), which is an
 * RPC method only reachable by a caller already holding an env.GAME_TABLE_DO
 * binding (i.e. server-side code in this Worker or a test) — no HTTP route in
 * this repo ever forwards client-supplied input into it, so no request from a
 * real browser client can reach it. Persists across redeals/rematches on the
 * same table until this method is called again.
 */
export interface TestFixedDeal {
  readonly shuffledDeck: readonly Card[];
  readonly firstBidder: Seat;
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
}

interface TestOverrideRow {
  [key: string]: SqlStorageValue;
  shuffledDeckJson: string;
  firstBidder: number;
}

function cryptoRandomSource(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function buildResultSummary(
  state: FinishedState,
  deltas: Readonly<Record<Seat, number>>,
  seats: readonly SeatRow[],
) {
  return {
    winner: state.winner,
    landlord: state.landlord,
    bombCount: state.bombCount,
    isSpring: state.isSpring,
    isAntiSpring: state.isAntiSpring,
    bidMultiplierBase: state.bidMultiplierBase,
    baseStake: state.baseStake,
    deltas,
    seats: Object.fromEntries(
      seats.map((s) => [s.seat, { userId: s.userId, username: s.username }]),
    ),
  };
}

export class GameTableDO extends DurableObject<Env> {
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
        seat INTEGER PRIMARY KEY CHECK (seat IN (0, 1, 2)),
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT,
        settled INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_override (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shuffled_deck_json TEXT NOT NULL,
        first_bidder INTEGER NOT NULL
      )
    `);
  }

  // --- Lifecycle / lobby-facing RPC -----------------------------------------

  /**
   * Idempotent: a second call after the table is already initialized is a
   * harmless no-op ({ok:true}). Callable directly by a future lobby DO (S7)
   * or the /api/tables/:tableId/init HTTP route (worker/src/routes/tables.ts).
   */
  async init(params: TableInitParams): Promise<InitResult> {
    if (this.loadMetaRow()) return { ok: true };

    if (params.gameId !== "doudizhu") return { ok: false, reason: "unsupported-game" };
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
      "INSERT OR REPLACE INTO test_override (id, shuffled_deck_json, first_bidder) VALUES (1, ?, ?)",
      JSON.stringify(deal.shuffledDeck),
      deal.firstBidder,
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

  /** Live occupancy snapshot for the lobby directory (S7). Null if uninitialized. */
  async getSeatSummary(): Promise<{ seatsFilled: number; seatsTotal: number; settled: boolean } | null> {
    const meta = this.loadMetaRow();
    if (!meta) return null;
    return {
      seatsFilled: this.loadSeats().length,
      seatsTotal: SEATS.length,
      settled: this.loadGameStateRow().settled === 1,
    };
  }

  /**
   * Used by LobbyDO to tell an abandoned table (everyone closed their tab
   * before the hand finished) apart from one that's genuinely still being
   * played, so the admin delete-user guard (isUserInLiveGame) doesn't block
   * on stale membership forever. `finished` covers a hand that reached the
   * engine's 'finished' phase, one already marked settled, or a table that
   * never had a hand start at all (state_json still NULL) — none of those
   * should count as "in progress". `anyConnected` reflects currently-attached
   * hibernation WebSockets across every seat, independent of game phase.
   * A table that's uninitialized reports both as false/true-safe defaults
   * (finished, not connected) so a caller never treats it as live.
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
        parsed.type === "bid"
          ? { type: "bid", amount: parsed.amount }
          : parsed.type === "pass"
            ? { type: "pass" }
            : { type: "play", cardIds: parsed.cardIds };

      const result = applyAction(state, seat, action);
      if (!result.ok) {
        this.sendErrorToWs(ws, result.reason, result.reason);
        return;
      }
      await this.applyNewState(result.state);
    } catch (err) {
      console.error("GameTableDO webSocketMessage failed", err);
    }
  }

  async webSocketClose(): Promise<void> {
    this.broadcastState();
  }

  async webSocketError(): Promise<void> {
    this.broadcastState();
  }

  // --- Game flow --------------------------------------------------------------

  private async handleReady(seat: Seat): Promise<void> {
    if (!this.isWaitingForReady()) {
      this.sendErrorToSeat(seat, "game-in-progress", "cannot ready up while a hand is active");
      return;
    }
    this.ctx.storage.sql.exec("UPDATE seats SET ready = 1 WHERE seat = ?", seat);
    const seats = this.loadSeats();
    if (seats.length === 3 && seats.every((s) => s.ready === 1)) {
      await this.startNewRound({ sameRound: false });
    } else {
      this.broadcastState();
    }
  }

  private async applyNewState(state: GameState): Promise<void> {
    if (state.phase === "redeal") {
      await this.startNewRound({ sameRound: true });
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

  private async startNewRound(opts: { sameRound: boolean }): Promise<void> {
    const meta = this.loadMetaRow();
    if (!meta) return;

    const { deck, firstBidder } = this.drawDeckAndFirstBidder();
    const state = createGame({ shuffledDeck: deck, firstBidder, baseStake: meta.stake });

    if (!opts.sameRound) {
      this.ctx.storage.sql.exec("UPDATE table_meta SET round = round + 1 WHERE id = 1");
      this.ctx.storage.sql.exec("UPDATE seats SET ready = 0");
    }

    this.persistGameState(state);
    this.broadcastState();
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
      await this.notifyLobbySettled(meta.gameId, meta.tableId);
      return;
    }

    if (seats.length !== 3) {
      console.error("GameTableDO: cannot settle without 3 seated players");
      return;
    }

    const stmts = [];
    for (const seat of SEATS) {
      const seatRow = seats.find((s) => s.seat === seat)!;
      const delta = deltas[seat];
      const idempotencyKey = `settle:${meta.tableId}:${meta.round}:${seatRow.userId}`;
      stmts.push(
        this.env.DB.prepare(
          `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
           VALUES (?, ?, 'doudizhu', 'game_settlement', ?)`,
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
         VALUES (?, 'doudizhu', ?, ?, ?, ?)`,
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
        console.error("GameTableDO settlement batch failed", err);
        throw err;
      }
      // Another attempt already landed this exact round's ledger rows
      // (crash/retry race) — treat as already-settled, don't rethrow.
    }

    this.ctx.storage.sql.exec("UPDATE game_state SET settled = 1 WHERE id = 1");
    await this.broadcastSettled(meta.round, seats, deltas);
    await this.notifyLobbySettled(meta.gameId, meta.tableId);
  }

  // Best-effort, run only after the settlement broadcast so a slow/unhealthy
  // LobbyDO never delays a player from seeing their own settlement message.
  // Clears this table's lobby membership (admin delete-user guard,
  // isUserInLiveGame) — never lets a lobby hiccup break settlement itself.
  private async notifyLobbySettled(gameId: string, tableId: string): Promise<void> {
    try {
      await this.env.LOBBY_DO.getByName(lobbyDoName(gameId)).notifySettled(tableId);
    } catch (err) {
      console.error("GameTableDO: failed to notify LobbyDO of settlement", err);
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

  private isWaitingForReady(): boolean {
    const row = this.loadGameStateRow();
    if (!row.stateJson) return true;
    const state = JSON.parse(row.stateJson) as GameState;
    return state.phase === "finished" && row.settled === 1;
  }

  private hasActiveHand(): boolean {
    const state = this.loadGameState();
    return state !== null && (state.phase === "bidding" || state.phase === "playing");
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
      .exec<GameStateRow>("SELECT state_json as stateJson, settled FROM game_state WHERE id = 1")
      .toArray()[0];
    return row ?? { stateJson: null, settled: 0 };
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

  private drawDeckAndFirstBidder(): { deck: Card[]; firstBidder: Seat } {
    const override = this.ctx.storage.sql
      .exec<TestOverrideRow>(
        "SELECT shuffled_deck_json as shuffledDeckJson, first_bidder as firstBidder FROM test_override WHERE id = 1",
      )
      .toArray()[0];
    if (override) {
      return {
        deck: JSON.parse(override.shuffledDeckJson) as Card[],
        firstBidder: override.firstBidder as Seat,
      };
    }
    const deck = shuffleDeck(createDeck(), cryptoRandomSource);
    const firstBidder = (crypto.getRandomValues(new Uint32Array(1))[0] % 3) as Seat;
    return { deck, firstBidder };
  }
}
