// Wire protocol between a browser client and its table's PokerTableDO, over a
// single WebSocket. Imported by the client (web/) for typed messages, and by
// the DO itself so both sides share one definition. Mirrors
// worker/src/durable-objects/protocol.ts's (doudizhu's) and liarsbar-protocol.ts's
// shape and conventions, adapted to no-limit hold'em's action set (fold/check/
// call/bet/raise instead of bid/pass/play, or play/challenge) and to poker's
// drop-in room model: there is no 'aborted' message at all — a leave or a
// disconnect that outlasts its grace period never voids the table, it only
// auto-folds that one seat (see PokerTableDO's file header) — so a client only
// ever needs to render 'state' and 'settled' (plus 'error').
import type { RedactedView, RejectionReason, Seat } from "poker";

export type { Seat };

// --- Client -> server --------------------------------------------------------

export type ClientMessage =
  | { readonly type: "ready" }
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  | { readonly type: "bet"; readonly amount: number }
  | { readonly type: "raise"; readonly toAmount: number }
  | { readonly type: "leave" };

/**
 * Runtime-validates an arbitrary decoded JSON payload into a ClientMessage.
 * Returns null for anything malformed, so a hostile/buggy client can never
 * reach `applyAction` with a shape it doesn't expect (e.g. a non-integer
 * `amount`, which would otherwise be rejected deep inside the engine with a
 * less specific error, or worse, coerced unexpectedly).
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case "ready":
      return { type: "ready" };
    case "fold":
      return { type: "fold" };
    case "check":
      return { type: "check" };
    case "call":
      return { type: "call" };
    case "leave":
      return { type: "leave" };
    case "bet": {
      const amount = obj.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return null;
      return { type: "bet", amount };
    }
    case "raise": {
      const toAmount = obj.toAmount;
      if (typeof toAmount !== "number" || !Number.isInteger(toAmount) || toAmount <= 0) return null;
      return { type: "raise", toAmount };
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
   * True once this seat is committed to leaving (a deliberate {type:'leave'}
   * message, or a disconnect whose 30s reconnect grace has expired) but is
   * still part of the CURRENT hand (folded, possibly all-in, or simply not
   * yet reached in turn order) — see PokerTableDO's file header for the full
   * fold/leave state machine. The seat is removed entirely (this field
   * disappears along with the rest of the row) the moment the hand settles.
   * Always false for an empty seat and for any seat between hands (a
   * between-hands leave/disconnect frees the seat immediately instead of
   * ever setting this).
   */
  readonly leavePending: boolean;
}

export interface StateMessage {
  readonly type: "state";
  /** Increments each time a fresh hand (ready-up -> deal) starts on this table. */
  readonly handNo: number;
  /** Always exactly 8 entries (seats 0-7), occupied or not — poker's seating
   * is a drop-in 2-8 capacity table, unlike doudizhu/liarsbar's fixed-size
   * rooms, so the client needs the full layout to render open seats. */
  readonly seats: readonly SeatStatus[];
  /**
   * The recipient's own redacted view (viewFor(state, mySeat)) — null only
   * before this table has ever dealt its first hand. Once a hand has been
   * played, `view` keeps showing that hand's (redacted) outcome even after
   * settlement, right up until the next hand is dealt — exactly like
   * doudizhu/liarsbar, whose finished/settled state is likewise left in
   * place until the next round overwrites it. Never contains another seat's
   * hole cards pre-showdown, nor a folded seat's hole cards ever (see the
   * engine's viewFor contract in games/poker/src/game.ts).
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

// No 'aborted' message — poker never voids a hand for anyone; see the file
// header above and PokerTableDO's own doc comment for the full rationale.
export type ServerMessage = StateMessage | ErrorMessage | SettledMessage;
