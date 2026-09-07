// Wire protocol between a browser client and its table's LiarsBarTableDO, over
// a single WebSocket. Imported by the client (web/) for typed messages, and
// by the DO itself so both sides share one definition. Mirrors
// worker/src/durable-objects/protocol.ts's (doudizhu's) shape and
// conventions exactly, adapted to Liar's Bar's much smaller action set: there
// is no bidding/passing here, only "play some cards" or "call the last play a
// lie" (challenge).
import type { RedactedView, RejectionReason, Seat } from "liarsbar";

export type { Seat };

// --- Client -> server --------------------------------------------------------

export type ClientMessage =
  | { readonly type: "ready" }
  | { readonly type: "play"; readonly cardIds: readonly string[] }
  | { readonly type: "challenge" }
  | { readonly type: "leave" };

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
    case "challenge":
      return { type: "challenge" };
    case "leave":
      return { type: "leave" };
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
  /**
   * This seat's occupant's current D1 `users.credits` balance, cached in the
   * DO's seat row and refreshed only on connect/reconnect and immediately
   * after settlement (see LiarsBarTableDO's refreshSeatCredits) — NOT re-read
   * on every ordinary broadcast, so an admin credit adjustment mid-hand won't
   * show up here until the next reconnect or settlement. 0 for an empty seat.
   */
  readonly credits: number;
}

export interface StateMessage {
  readonly type: "state";
  /** Increments each time a fresh match (ready-up -> deal) starts on this table. */
  readonly round: number;
  readonly seats: readonly SeatStatus[];
  /**
   * The recipient's own redacted view (viewFor(state, mySeat)) — null while
   * waiting for all 4 seats to be filled and ready. Never contains another
   * seat's hand card ids or ANY seat's bulletChamber value, in any phase —
   * see the engine's viewFor contract in games/liarsbar/src/game.ts. During
   * the brief "roundEnd" phase this carries the just-resolved challenge's
   * reveal (cards, whether the claim was truthful, who spun and how many
   * times, whether they died) — everything a client needs to animate the
   * reveal/spin — before the DO immediately deals the next round.
   */
  readonly view: RedactedView | null;
}

export type ErrorCode =
  | "bad-message"
  | "table-full"
  | "not-initialized"
  | "game-in-progress"
  | "no-active-hand"
  | "table-aborted"
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

/**
 * Sent once, the instant a hand is voided by a deliberate leave or a
 * disconnect that outlasts the 30s reconnect grace (see LiarsBarTableDO). No
 * settlement follows — the DO's own final `state` broadcast (view: null)
 * arrives right after this and the table accepts no further game actions.
 */
export interface AbortedMessage {
  readonly type: "aborted";
  readonly leaver: { readonly seat: Seat; readonly username: string };
}

export type ServerMessage = StateMessage | ErrorMessage | SettledMessage | AbortedMessage;
