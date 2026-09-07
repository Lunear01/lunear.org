// Wire protocol between a browser client and its table's BlackjackTableDO,
// over a single WebSocket. Imported by the client (web/) for typed messages,
// and by the DO itself so both sides share one definition. Mirrors
// poker-protocol.ts's shape and conventions, adapted to blackjack's action
// set (hit/stand/double instead of fold/check/call/bet/raise) and the same
// drop-in room model: no 'aborted' message — a leave or an expired disconnect
// only ever auto-STANDS that one seat (their bet still plays out — see
// BlackjackTableDO's file header), so a client only ever renders 'state' and
// 'settled' (plus 'error').
import type { RedactedView, RejectionReason, Seat } from "blackjack";

export type { Seat };

// --- Client -> server --------------------------------------------------------

export type ClientMessage =
  | { readonly type: "ready" }
  | { readonly type: "hit" }
  | { readonly type: "stand" }
  | { readonly type: "double" }
  | { readonly type: "leave" };

/**
 * Runtime-validates an arbitrary decoded JSON payload into a ClientMessage.
 * Returns null for anything malformed, so a hostile/buggy client can never
 * reach `applyAction` with a shape it doesn't expect.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case "ready":
      return { type: "ready" };
    case "hit":
      return { type: "hit" };
    case "stand":
      return { type: "stand" };
    case "double":
      return { type: "double" };
    case "leave":
      return { type: "leave" };
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
   * True once this seat is committed to leaving (a deliberate {type:'leave'}
   * message, or a disconnect whose 30s reconnect grace has expired) but is
   * still part of the CURRENT round — auto-stood, with their bet still live.
   * The seat is removed entirely the moment the round settles. Always false
   * for an empty seat and for any seat between rounds.
   */
  readonly leavePending: boolean;
  /**
   * This seat's occupant's current D1 `users.credits` balance, cached in the
   * DO's seat row and refreshed only on connect/reconnect and immediately
   * after settlement — see PokerTableDO's identically named field for the
   * staleness caveat. 0 for an empty seat.
   */
  readonly credits: number;
}

export interface StateMessage {
  readonly type: "state";
  /** Increments each time a fresh round (ready-up -> deal) starts on this table. */
  readonly handNo: number;
  /** Always exactly 5 entries (seats 0-4), occupied or not — blackjack's
   * seating is a drop-in 1-5 capacity table, so the client needs the full
   * layout to render open seats. */
  readonly seats: readonly SeatStatus[];
  /**
   * The recipient's redacted view (viewFor(state, mySeat)) — null only before
   * this table has ever dealt its first round; afterward it keeps showing the
   * last round's outcome until the next deal, like the other games. Blackjack
   * hands are public, so unlike poker a seated-but-skipped occupant still
   * receives the live view mid-round (their own seat just isn't in
   * view.players) — the only redacted fact is the dealer's hole card.
   */
  readonly view: RedactedView | null;
}

export type ErrorCode = "bad-message" | "game-in-progress" | "no-active-hand" | RejectionReason;

export interface ErrorMessage {
  readonly type: "error";
  readonly code: ErrorCode;
  readonly message: string;
}

export interface SettledMessage {
  readonly type: "settled";
  readonly handNo: number;
  readonly deltas: Readonly<Record<Seat, number>>;
  /** The recipient's own post-settlement balance. */
  readonly newBalance?: number;
}

/**
 * Broadcast once, immediately after 'settled' — `at` is the epoch-ms moment
 * the DO's alarm will fire and decide whether to deal the next round (>=1
 * connected occupant) or fall back to manual ready-up. Countdown rendering
 * only; no guarantee a round starts at `at`.
 */
export interface NextHandMessage {
  readonly type: "nextHand";
  readonly at: number;
}

export type ServerMessage = StateMessage | ErrorMessage | SettledMessage | NextHandMessage;
