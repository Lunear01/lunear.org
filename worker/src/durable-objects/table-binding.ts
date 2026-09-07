import type { InitResult, TableInitParams } from "./game-table";

// The one place that knows which DO binding backs a given game's table
// room. v1 had exactly one game and hardcoded env.GAME_TABLE_DO everywhere
// (routes/tables.ts, LobbyDO); a third game extends the switch below
// instead of adding another hardcode. Every binding's DO must expose this
// exact RPC surface — GameTableDO, LiarsBarTableDO, and PokerTableDO are all
// real implementations (see poker-table.ts's own file header for how its
// room semantics deliberately differ from the other two: variable 2-8
// capacity, drop-in/drop-out between hands, no abort-on-leave).
export interface TableStub {
  fetch(request: Request): Promise<Response>;
  init(params: TableInitParams): Promise<InitResult>;
  getSeatSummary(): Promise<
    | { seatsFilled: number; seatsTotal: number; settled: boolean; finished: boolean; anyConnected: boolean }
    | null
  >;
  getLiveness(): Promise<{ finished: boolean; settled: boolean; anyConnected: boolean }>;
}

/** Returns undefined for a gameId with no known table DO binding (unregistered game). */
export function getTableStub(env: Env, gameId: string, tableId: string): TableStub | undefined {
  switch (gameId) {
    case "doudizhu":
      return env.GAME_TABLE_DO.getByName(tableId);
    case "liarsbar":
      return env.LIARSBAR_TABLE_DO.getByName(tableId);
    case "poker":
      return env.POKER_TABLE_DO.getByName(tableId);
    case "blackjack":
      return env.BLACKJACK_TABLE_DO.getByName(tableId);
    default:
      return undefined;
  }
}
