import { DurableObject } from "cloudflare:workers";
import { getGameDefinition } from "../registry";
import { getTableStub } from "./table-binding";

// Singleton per game_id (env.LOBBY_DO.getByName(lobbyDoName(gameId))). Owns:
// the quick-play queue, the public-table directory, the invite-code ->
// table-id map, and a user -> active-table membership map (consumed by
// isUserInLiveGame). Never imports game rules — only the registry's seat
// counts and, via table-binding.ts's getTableStub(), the per-game table DO
// binding needed to init tables / read live seat occupancy.

export function lobbyDoName(gameId: string): string {
  return `lobby:${gameId}`;
}

const QUICK_PLAY_STAKE = 100;
// Backstop sweep for a dead table that nobody ever lists (e.g. private/
// invite-only, or a public one that dodges every listOpenParties call in
// between). listOpenParties is the primary cleanup path now and catches an
// abandoned public table within its own 2-minute grace (see
// INACTIVE_LISTING_GRACE_MS), so this threshold only needs to be short
// enough to bound the backstop's own worst case, not carry the main load.
const DEAD_TABLE_MS = 10 * 60 * 1000;
const CLEANUP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// Grace for a just-created table whose host's WebSocket hasn't attached yet
// — a lobby -> table-page navigation takes seconds, but this stays generous
// for a slow device/connection.
const INACTIVE_LISTING_GRACE_MS = 2 * 60 * 1000;
const INVITE_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INVITE_CODE_LENGTH = 6;
const MAX_INVITE_CODE_ATTEMPTS = 20;
const MAX_LISTING = 50;

export interface QuickPlayResult {
  readonly status: "queued" | "matched";
  readonly tableId?: string;
}

export interface CreateGameParams {
  readonly hostUserId: string;
  readonly hostUsername: string;
  readonly stake: number;
  readonly inviteOnly: boolean;
}

export interface CreateGameResult {
  readonly tableId: string;
  readonly inviteCode?: string;
}

export interface OpenPartyRow {
  readonly tableId: string;
  readonly hostUsername: string;
  readonly stake: number;
  readonly seatsFilled: number;
  readonly seatsTotal: number;
  readonly createdAt: string;
}

export type JoinResult =
  | { readonly ok: true; readonly tableId: string }
  | { readonly ok: false; readonly reason: "not-found" | "full" };

interface QueueRow {
  [key: string]: SqlStorageValue;
  userId: string;
  username: string;
  joinedAt: number;
  matchedTableId: string | null;
}

interface TableRow {
  [key: string]: SqlStorageValue;
  tableId: string;
  visibility: "public" | "private";
  hostUserId: string;
  hostUsername: string;
  stake: number;
  seatsReserved: number;
  seatsTotal: number;
  createdAt: number;
}

function generateTableId(): string {
  return `tbl-${crypto.randomUUID().replace(/-/g, "")}`;
}

function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  return Array.from(bytes, (b) => INVITE_CODE_CHARS[b % INVITE_CODE_CHARS.length]).join("");
}

export class LobbyDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quick_queue (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        matched_table_id TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        table_id TEXT PRIMARY KEY,
        visibility TEXT NOT NULL,
        host_user_id TEXT NOT NULL,
        host_username TEXT NOT NULL,
        stake INTEGER NOT NULL,
        seats_reserved INTEGER NOT NULL,
        seats_total INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        table_id TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS membership (
        user_id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_membership_table ON membership(table_id)",
    );
  }

  /**
   * A LobbyDO instance is always created via getByName(lobbyDoName(gameId))
   * (see the file-header comment), so its own DO name reliably encodes
   * which game it partitions. Methods that don't already take a gameId
   * parameter (listOpenParties, claimSeat, isLiveMember) use this instead
   * of adding one, so their public RPC signatures — and every call site —
   * stay unchanged as more games are added.
   */
  private currentGameId(): string {
    const name = this.ctx.id.name;
    const gameId = name?.startsWith("lobby:") ? name.slice("lobby:".length) : undefined;
    if (!gameId) throw new Error("LobbyDO: durable object name is not in 'lobby:<gameId>' form");
    return gameId;
  }

  private async seatSummaryFor(tableId: string) {
    const stub = getTableStub(this.env, this.currentGameId(), tableId);
    return stub ? stub.getSeatSummary() : null;
  }

  private async livenessFor(tableId: string) {
    const stub = getTableStub(this.env, this.currentGameId(), tableId);
    return stub ? stub.getLiveness() : { finished: true, settled: false, anyConnected: false };
  }

  // --- Quick play -------------------------------------------------------------

  /**
   * Idempotent per user: a duplicate call never enqueues twice. Once a call
   * from any queued member fills the registry's seat count, that call
   * synchronously (no intervening await) marks every member of the matched
   * group before ever awaiting the GameTableDO.init() RPC — so a concurrent
   * quickPlay from a different user can't ever observe (and re-match) the
   * same waiting group twice. Earlier joiners discover their tableId by
   * polling quickPlay again (documented for S8b in routes/lobby.ts).
   *
   * A game whose minSeats !== maxSeats (e.g. poker, 2-8) has no single fixed
   * group size to wait for, so it never uses this fixed-N queue at all —
   * see quickPlayVariableSeat() for that game family's join-or-create path,
   * which this delegates to up front.
   */
  async quickPlay(gameId: string, userId: string, username: string): Promise<QuickPlayResult> {
    const definition = getGameDefinition(gameId);
    if (definition && definition.minSeats !== definition.maxSeats) {
      return this.quickPlayVariableSeat(gameId, userId, username);
    }
    const seatsTotal = definition?.maxSeats ?? 3;

    const existing = this.getQueueRow(userId);
    if (existing?.matchedTableId) {
      return { status: "matched", tableId: existing.matchedTableId };
    }
    if (!existing) {
      this.ctx.storage.sql.exec(
        "INSERT INTO quick_queue (user_id, username, joined_at, matched_table_id) VALUES (?, ?, ?, NULL)",
        userId,
        username,
        Date.now(),
      );
    } else if (existing.username !== username) {
      this.ctx.storage.sql.exec("UPDATE quick_queue SET username = ? WHERE user_id = ?", username, userId);
    }

    const waiting = this.ctx.storage.sql
      .exec<QueueRow>(
        `SELECT user_id as userId, username, joined_at as joinedAt, matched_table_id as matchedTableId
         FROM quick_queue WHERE matched_table_id IS NULL ORDER BY joined_at ASC`,
      )
      .toArray();

    if (waiting.length < seatsTotal) {
      return { status: "queued" };
    }

    const group = waiting.slice(0, seatsTotal);
    const tableId = generateTableId();
    for (const member of group) {
      this.ctx.storage.sql.exec(
        "UPDATE quick_queue SET matched_table_id = ? WHERE user_id = ?",
        tableId,
        member.userId,
      );
      this.setMembership(member.userId, tableId);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO tables (table_id, visibility, host_user_id, host_username, stake, seats_reserved, seats_total, created_at)
       VALUES (?, 'public', ?, ?, ?, ?, ?, ?)`,
      tableId,
      group[0].userId,
      group[0].username,
      QUICK_PLAY_STAKE,
      seatsTotal,
      seatsTotal,
      Date.now(),
    );
    await this.ensureCleanupAlarmScheduled();

    const stub = getTableStub(this.env, gameId, tableId);
    const initResult = stub
      ? await stub.init({
          tableId,
          gameId,
          stake: QUICK_PLAY_STAKE,
          visibility: "public",
          hostUserId: group[0].userId,
        })
      : { ok: false as const, reason: "no-table-do-binding" };
    if (!initResult.ok) {
      console.error(`LobbyDO: quick-play table init failed (${tableId}): ${initResult.reason}`);
    }

    const mine = group.some((m) => m.userId === userId);
    return mine ? { status: "matched", tableId } : { status: "queued" };
  }

  /**
   * Join-or-create quick play for a game with a variable seat count
   * (minSeats !== maxSeats — e.g. poker, 2-8). There is no fixed group size
   * to wait for here, so this never queues and always resolves synchronously
   * to {status:'matched'}:
   *
   *  1. A user already seated at one of this game's tables (a `membership`
   *     row survives until the table is cleared — see clearTable /
   *     notifySettled) is matched straight back into it, without touching
   *     seat counts again. This keeps repeated polling idempotent the same
   *     way the fixed-seat path's `existing.matchedTableId` check does.
   *  2. Otherwise, scan this game's public tables newest-first for one with
   *     an open seat, using the exact same not-full / not-inactive test
   *     listOpenParties() applies (seatSummaryFor + isInactive), and claim a
   *     seat in the first match via claimSeat() — reusing its race-free
   *     reservation logic instead of duplicating it. An inactive table found
   *     along the way is cleared here too, same as listOpenParties() does.
   *  3. If no public table has room (including the case where every
   *     candidate loses its seat in a race against claimSeat's own
   *     recheck), a fresh public table is created — default stake,
   *     hostUserId the caller, membership recorded — by delegating to
   *     createGame(), which is exactly "create a public custom game" already.
   */
  private async quickPlayVariableSeat(
    gameId: string,
    userId: string,
    username: string,
  ): Promise<QuickPlayResult> {
    const existingTableId = this.getMembershipTableId(userId);
    if (existingTableId && this.getTableRow(existingTableId)) {
      return { status: "matched", tableId: existingTableId };
    }

    const candidates = this.ctx.storage.sql
      .exec<TableRow>(
        `SELECT table_id as tableId, visibility, host_user_id as hostUserId, host_username as hostUsername,
                stake, seats_reserved as seatsReserved, seats_total as seatsTotal, created_at as createdAt
         FROM tables WHERE visibility = 'public' ORDER BY created_at DESC LIMIT ?`,
        MAX_LISTING,
      )
      .toArray();

    for (const row of candidates) {
      const summary = await this.seatSummaryFor(row.tableId);
      if (this.isInactive(row, summary)) {
        this.clearTable(row.tableId);
        continue;
      }
      const seatsFilled = Math.max(row.seatsReserved, summary?.seatsFilled ?? 0);
      if (seatsFilled >= row.seatsTotal) continue;

      const claimed = await this.claimSeat(row.tableId, userId);
      if (claimed.ok) return { status: "matched", tableId: claimed.tableId };
      // Lost a race for the last seat (or the table vanished) — keep scanning.
    }

    const created = await this.createGame(gameId, {
      hostUserId: userId,
      hostUsername: username,
      stake: QUICK_PLAY_STAKE,
      inviteOnly: false,
    });
    return { status: "matched", tableId: created.tableId };
  }

  /**
   * DELETE .../quickplay for a variable-seat game: nothing was ever queued
   * for this game family (see quickPlayVariableSeat's doc comment), so
   * this is always a harmless no-op success — there's no quick_queue row to
   * remove. Kept as an explicit early return (rather than relying on the
   * DELETE below matching zero rows) so the "no-op for variable-seat games"
   * contract is visible here, not just an emergent property of an empty table.
   */
  async leaveQuickPlay(userId: string): Promise<void> {
    const definition = getGameDefinition(this.currentGameId());
    if (definition && definition.minSeats !== definition.maxSeats) return;
    this.ctx.storage.sql.exec("DELETE FROM quick_queue WHERE user_id = ?", userId);
  }

  // --- Custom games -------------------------------------------------------------

  async createGame(gameId: string, params: CreateGameParams): Promise<CreateGameResult> {
    const definition = getGameDefinition(gameId);
    const seatsTotal = definition?.maxSeats ?? 3;

    const tableId = generateTableId();
    const visibility = params.inviteOnly ? "private" : "public";
    const inviteCode = params.inviteOnly ? this.reserveInviteCode(tableId) : undefined;

    this.ctx.storage.sql.exec(
      `INSERT INTO tables (table_id, visibility, host_user_id, host_username, stake, seats_reserved, seats_total, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      tableId,
      visibility,
      params.hostUserId,
      params.hostUsername,
      params.stake,
      seatsTotal,
      Date.now(),
    );
    this.setMembership(params.hostUserId, tableId);
    await this.ensureCleanupAlarmScheduled();

    const stub = getTableStub(this.env, gameId, tableId);
    const initResult = stub
      ? await stub.init({
          tableId,
          gameId,
          stake: params.stake,
          visibility,
          inviteCode,
          hostUserId: params.hostUserId,
        })
      : { ok: false as const, reason: "no-table-do-binding" };
    if (!initResult.ok) {
      console.error(`LobbyDO: createGame table init failed (${tableId}): ${initResult.reason}`);
    }

    return { tableId, inviteCode };
  }

  // --- Directory / joining -------------------------------------------------------

  async listOpenParties(): Promise<OpenPartyRow[]> {
    const rows = this.ctx.storage.sql
      .exec<TableRow>(
        `SELECT table_id as tableId, visibility, host_user_id as hostUserId, host_username as hostUsername,
                stake, seats_reserved as seatsReserved, seats_total as seatsTotal, created_at as createdAt
         FROM tables WHERE visibility = 'public' ORDER BY created_at DESC LIMIT ?`,
        MAX_LISTING,
      )
      .toArray();

    const parties: OpenPartyRow[] = [];
    for (const row of rows) {
      // One RPC per listed table: getSeatSummary() now carries both the
      // seat-reconciliation data and the liveness fields needed to classify
      // the table below, so no second call is needed here.
      const summary = await this.seatSummaryFor(row.tableId);
      if (this.isInactive(row, summary)) {
        this.clearTable(row.tableId);
        continue;
      }
      const seatsFilled = Math.max(row.seatsReserved, summary?.seatsFilled ?? 0);
      if (seatsFilled >= row.seatsTotal) continue;
      parties.push({
        tableId: row.tableId,
        hostUsername: row.hostUsername,
        stake: row.stake,
        seatsFilled,
        seatsTotal: row.seatsTotal,
        createdAt: new Date(row.createdAt).toISOString(),
      });
    }
    return parties;
  }

  /**
   * A table is inactive — dropped from the listing and its lobby rows
   * cleared in the same pass — once either:
   *  - its hand has actually concluded (summary.finished: settled, aborted,
   *    or reached the engine's finished phase). Dropped immediately,
   *    regardless of age or connection: this is the backstop for a
   *    settle/abort -> notifyLobbyTableCleared call that raced or failed to
   *    reach this LobbyDO (see GameTableDO's notifyLobbyTableCleared).
   *  - nobody is currently connected AND the table has outlived
   *    INACTIVE_LISTING_GRACE_MS. This is what actually catches the
   *    production symptom: a host who created a table and vanished before
   *    ever opening its socket. A table with any socket attached always
   *    survives this branch regardless of age.
   * A missing summary (GameTableDO was never actually initialized) counts
   * as inactive too — there's nothing real behind that table row.
   */
  private isInactive(
    row: TableRow,
    summary: { finished: boolean; anyConnected: boolean } | null,
  ): boolean {
    if (!summary) return true;
    if (summary.finished) return true;
    if (summary.anyConnected) return false;
    return Date.now() - row.createdAt > INACTIVE_LISTING_GRACE_MS;
  }

  async joinParty(tableId: string, userId: string): Promise<JoinResult> {
    const table = this.getTableRow(tableId);
    if (!table || table.visibility !== "public") return { ok: false, reason: "not-found" };
    return this.claimSeat(tableId, userId);
  }

  async joinByCode(code: string, userId: string): Promise<JoinResult> {
    const codeRow = this.ctx.storage.sql
      .exec<{ tableId: string }>("SELECT table_id as tableId FROM invite_codes WHERE code = ?", code)
      .toArray()[0];
    if (!codeRow) return { ok: false, reason: "not-found" };
    return this.claimSeat(codeRow.tableId, userId);
  }

  /**
   * Race-free seat reservation: the getSeatSummary() RPC below is the only
   * await in this method, so it's the only point where a concurrent claim
   * for the same table can interleave. Everything after it — re-reading the
   * row and comparing-then-incrementing seats_reserved — is synchronous SQL,
   * and LobbyDO processes one RPC invocation to completion at a time, so two
   * overlapping claims for the last seat can never both win: whichever
   * synchronous section runs second sees the first one's already-incremented
   * count. (The actual seat is still independently guaranteed unique by
   * GameTableDO.fetch()'s own atomic seat assignment — this just keeps the
   * lobby's bookkeeping race-free too.)
   *
   * Idempotent per user: a member re-joining a table they're already on
   * doesn't consume a second reservation slot.
   */
  private async claimSeat(tableId: string, userId: string): Promise<JoinResult> {
    const alreadyMember = this.ctx.storage.sql
      .exec("SELECT 1 FROM membership WHERE user_id = ? AND table_id = ?", userId, tableId)
      .toArray().length > 0;
    if (alreadyMember) return { ok: true, tableId };

    const summary = await this.seatSummaryFor(tableId);
    const liveFilled = summary?.seatsFilled ?? 0;

    const current = this.getTableRow(tableId);
    if (!current) return { ok: false, reason: "not-found" };
    const effectiveFilled = Math.max(current.seatsReserved, liveFilled);
    if (effectiveFilled >= current.seatsTotal) return { ok: false, reason: "full" };

    this.ctx.storage.sql.exec(
      "UPDATE tables SET seats_reserved = ? WHERE table_id = ?",
      effectiveFilled + 1,
      tableId,
    );
    this.setMembership(userId, tableId);
    return { ok: true, tableId };
  }

  // --- Membership / live-check ---------------------------------------------------

  /** Raw membership record check — true whenever a row exists, regardless of table liveness. */
  async isMember(userId: string): Promise<boolean> {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM membership WHERE user_id = ?", userId).toArray().length > 0
    );
  }

  /**
   * Used by isUserInLiveGame (the admin delete-user guard). A membership row
   * alone is not enough: a game abandoned mid-play (every tab closed, hand
   * never settled) leaves that row forever, since it's normally only cleared
   * by notifySettled or the dead-table sweep — neither of which fires for an
   * abandoned-but-never-finished table. So this asks the table itself:
   * "live" requires BOTH an unfinished hand AND at least one attached socket
   * right now. A user who is merely matched/seated but has no hand in
   * progress and nobody connected is not live either (deleting them is safe
   * — admin intent wins over a reconnect that may never come). A user who's
   * actively connected mid-hand still reports live and blocks deletion.
   *
   * Whenever the table turns out not-live, this self-heals: the table's
   * membership/tables/invite_codes rows are cleared here so the next check
   * for anyone else on that table is a plain membership miss, not another
   * cross-DO RPC.
   */
  async isLiveMember(userId: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ tableId: string }>("SELECT table_id as tableId FROM membership WHERE user_id = ?", userId)
      .toArray()[0];
    if (!row) return false;

    const liveness = await this.livenessFor(row.tableId);
    const live = !liveness.finished && liveness.anyConnected;
    if (!live) this.clearTable(row.tableId);
    return live;
  }

  /** Called by GameTableDO once a hand settles — clears this table out of the lobby entirely. */
  async notifySettled(tableId: string): Promise<void> {
    this.clearTable(tableId);
  }

  private clearTable(tableId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM membership WHERE table_id = ?", tableId);
    this.ctx.storage.sql.exec("DELETE FROM tables WHERE table_id = ?", tableId);
    this.ctx.storage.sql.exec("DELETE FROM invite_codes WHERE table_id = ?", tableId);
  }

  // --- Dead-table cleanup ---------------------------------------------------------

  async alarm(): Promise<void> {
    const cutoff = Date.now() - DEAD_TABLE_MS;
    const dead = this.ctx.storage.sql
      .exec<{ tableId: string }>(
        "SELECT table_id as tableId FROM tables WHERE seats_reserved <= 1 AND created_at < ?",
        cutoff,
      )
      .toArray();
    for (const row of dead) {
      this.ctx.storage.sql.exec("DELETE FROM tables WHERE table_id = ?", row.tableId);
      this.ctx.storage.sql.exec("DELETE FROM invite_codes WHERE table_id = ?", row.tableId);
      this.ctx.storage.sql.exec("DELETE FROM membership WHERE table_id = ?", row.tableId);
    }

    const remaining = this.ctx.storage.sql.exec("SELECT 1 FROM tables LIMIT 1").toArray();
    if (remaining.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_SWEEP_INTERVAL_MS);
    }
  }

  private async ensureCleanupAlarmScheduled(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_SWEEP_INTERVAL_MS);
    }
  }

  // --- Storage helpers --------------------------------------------------------------

  private getQueueRow(userId: string): QueueRow | undefined {
    return this.ctx.storage.sql
      .exec<QueueRow>(
        `SELECT user_id as userId, username, joined_at as joinedAt, matched_table_id as matchedTableId
         FROM quick_queue WHERE user_id = ?`,
        userId,
      )
      .toArray()[0];
  }

  /** Used by quickPlayVariableSeat's idempotency check — mirrors isLiveMember's membership lookup. */
  private getMembershipTableId(userId: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ tableId: string }>("SELECT table_id as tableId FROM membership WHERE user_id = ?", userId)
      .toArray()[0]?.tableId;
  }

  private getTableRow(tableId: string): TableRow | undefined {
    return this.ctx.storage.sql
      .exec<TableRow>(
        `SELECT table_id as tableId, visibility, host_user_id as hostUserId, host_username as hostUsername,
                stake, seats_reserved as seatsReserved, seats_total as seatsTotal, created_at as createdAt
         FROM tables WHERE table_id = ?`,
        tableId,
      )
      .toArray()[0];
  }

  private setMembership(userId: string, tableId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO membership (user_id, table_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET table_id = excluded.table_id`,
      userId,
      tableId,
    );
  }

  private reserveInviteCode(tableId: string): string {
    for (let attempt = 0; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt++) {
      const code = randomInviteCode();
      const taken = this.ctx.storage.sql
        .exec("SELECT 1 FROM invite_codes WHERE code = ?", code)
        .toArray().length > 0;
      if (taken) continue;
      this.ctx.storage.sql.exec("INSERT INTO invite_codes (code, table_id) VALUES (?, ?)", code, tableId);
      return code;
    }
    throw new Error("LobbyDO: exhausted invite code attempts");
  }
}
