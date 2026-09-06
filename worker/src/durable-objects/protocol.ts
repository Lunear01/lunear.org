// Wire protocol between a browser client and its table's GameTableDO, over a
// single WebSocket. Imported by the client (S8b) for typed messages, and by
// the DO itself so both sides share one definition.
import type { RedactedView, RejectionReason, Seat } from "doudizhu";

export type { Seat };

// --- Client -> server --------------------------------------------------------

export type ClientMessage =
  | { readonly type: "ready" }
  | { readonly type: "bid"; readonly amount: 1 | 2 | 3 }
  | { readonly type: "pass" }
  | { readonly type: "play"; readonly cardIds: readonly string[] };

/**
 * Runtime-validates an arbitrary decoded JSON payload into a ClientMessage.
 * Returns null for anything malformed, so a hostile/buggy client can never
 * reach `applyAction` with a shape it doesn't expect (e.g. missing/wrong-typed
 * `cardIds`, which would otherwise throw inside the engine).
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case "ready":
      return { type: "ready" };
    case "pass":
      return { type: "pass" };
    case "bid": {
      const amount = obj.amount;
      if (amount !== 1 && amount !== 2 && amount !== 3) return null;
      return { type: "bid", amount };
    }
    case "play": {
      const cardIds = obj.cardIds;
      if (!Array.isArray(cardIds) || !cardIds.every((id) => typeof id === "string")) {
        return null;
      }
      return { type: "play", cardIds };
    }
    default:
      return null;
  }
}

// --- Server -> client --------------------------------------------------------

export interface SeatStatus {
  readonly seat: Seat;
  readonly userId: string | null;
  readonly username: string | null;
  readonly connected: boolean;
  readonly ready: boolean;
}

export interface StateMessage {
  readonly type: "state";
  /** Increments each time a fresh match (ready-up -> deal) starts on this table. */
  readonly round: number;
  readonly seats: readonly SeatStatus[];
  /**
   * The recipient's own redacted view (viewFor(state, mySeat)) — null while
   * waiting for all 3 seats to be filled and ready. Only ever contains this
   * seat's own hand; opponents' hands are counts only (landlordCards are an
   * exception — they're public to all seats once bidding ends, per the
   * engine's viewFor contract).
   */
  readonly view: RedactedView | null;
  /** Epoch ms deadline for the current bidder/turn; null when no timer is active. */
  readonly turnDeadline: number | null;
}

export type ErrorCode =
  | "bad-message"
  | "table-full"
  | "not-initialized"
  | "game-in-progress"
  | "no-active-hand"
  | RejectionReason;

export interface ErrorMessage {
  readonly type: "error";
  readonly code: ErrorCode;
  readonly message: string;
}

export interface SettledMessage {
  readonly type: "settled";
  readonly round: number;
  readonly deltas: Readonly<Record<Seat, number>>;
  /** The recipient's own post-settlement balance. */
  readonly newBalance?: number;
}

export type ServerMessage = StateMessage | ErrorMessage | SettledMessage;
