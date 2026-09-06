// Real implementation of the lobby/matchmaking API (plan step S7's HTTP
// surface: worker/src/routes/lobby.ts). Response bodies are the exact shapes
// documented there — this module is a thin typed wrapper, same convention as
// api/auth.ts and api/admin.ts.
import { apiDelete, apiGet, apiPost } from "./client";

export interface OpenParty {
  tableId: string;
  hostUsername: string;
  stake: number;
  seatsFilled: number;
  seatsTotal: number;
  createdAt: string;
}

export interface QuickPlayResult {
  status: "queued" | "matched";
  tableId?: string;
}

export interface CreateGameOptions {
  stake: number;
  inviteOnly: boolean;
}

export interface CreateGameResult {
  tableId: string;
  inviteCode?: string;
}

export interface JoinResult {
  tableId: string;
}

export interface LobbyApi {
  /** Join (or poll) the quick-play queue for a game id. Safe to call repeatedly — see pollQuickPlay. */
  quickPlay(gameId: string): Promise<QuickPlayResult>;
  /** Leave the quick-play queue. No-op if not queued or already matched. */
  cancelQuickPlay(gameId: string): Promise<void>;
  /** Create a custom table with a stake and optional invite-only gating. */
  createGame(gameId: string, options: CreateGameOptions): Promise<CreateGameResult>;
  /** List public tables with open seats for a game id. */
  listOpenParties(gameId: string): Promise<OpenParty[]>;
  /** Join a specific open party by table id. Rejects (ApiError) with 409 if full, 404 if gone. */
  joinParty(gameId: string, tableId: string): Promise<JoinResult>;
  /** Join a private table by its invite code. Rejects (ApiError) with 409 if full, 404 if invalid. */
  joinByCode(gameId: string, code: string): Promise<JoinResult>;
}

export const lobbyApi: LobbyApi = {
  quickPlay(gameId) {
    return apiPost<QuickPlayResult>(`/api/lobby/${gameId}/quickplay`);
  },
  async cancelQuickPlay(gameId) {
    await apiDelete<{ ok: boolean }>(`/api/lobby/${gameId}/quickplay`);
  },
  createGame(gameId, options) {
    return apiPost<CreateGameResult>(`/api/lobby/${gameId}/games`, options);
  },
  listOpenParties(gameId) {
    return apiGet<OpenParty[]>(`/api/lobby/${gameId}/parties`);
  },
  joinParty(gameId, tableId) {
    return apiPost<JoinResult>(`/api/lobby/${gameId}/parties/${tableId}/join`);
  },
  joinByCode(gameId, code) {
    return apiPost<JoinResult>(`/api/lobby/${gameId}/join-by-code`, { code });
  },
};

/**
 * Drives worker/src/routes/lobby.ts's documented quickplay polling contract:
 * the first call enqueues and returns "queued" (or "matched" immediately);
 * re-calling on an interval keeps returning "queued" until some caller's
 * join fills the game's seat count, at which point every member of that
 * group starts getting "matched" back. Stops polling once matched or on
 * error; returns a cancel function the caller must invoke on unmount/cancel.
 */
export function pollQuickPlay(
  gameId: string,
  onUpdate: (result: QuickPlayResult) => void,
  onError: (err: unknown) => void,
  intervalMs = 2000,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    try {
      const result = await lobbyApi.quickPlay(gameId);
      if (cancelled) return;
      onUpdate(result);
      if (result.status === "queued") {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    } catch (err) {
      if (!cancelled) onError(err);
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
