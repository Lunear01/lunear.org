// Wire protocol between a browser client and its table's UnoTableDO, over a
// single WebSocket. Imported by the client (web/) for typed messages, and by
// the DO itself so both sides share one definition. Mirrors
// liarsbar-protocol.ts's shape and conventions, adapted to UNO's action set:
// play one card (with a colour for a wild, optionally calling UNO), draw
// one, pass after a draw, call UNO, or catch a seat that forgot to.
import type { Color, RedactedView, RejectionReason, Seat } from "uno";
import type { SkinId } from "../shop/catalog";
import type { EmoteClientMessage, EmoteErrorCode, EmoteMessage } from "./emote-protocol";

export type { Seat };

// --- Client -> server --------------------------------------------------------

export type ClientMessage =
  | { readonly type: "ready" }
  | { readonly type: "play"; readonly cardId: string; readonly color?: Color; readonly uno?: boolean }
  | { readonly type: "draw" }
  | { readonly type: "pass" }
  | { readonly type: "callUno" }
  | { readonly type: "catchUno"; readonly target: Seat }
  | { readonly type: "leave" }
  | EmoteClientMessage;

const COLORS: readonly string[] = ["red", "yellow", "green", "blue"];

/**
 * Runtime-validates an arbitrary decoded JSON payload into a ClientMessage.
 * Returns null for anything malformed, so a hostile/buggy client can never
 * reach `applyAction` with a shape it doesn't expect.
 */
export function parseClientMessage(raw: unknown): Exclude<ClientMessage, EmoteClientMessage> | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case "ready":
      return { type: "ready" };
    case "draw":
      return { type: "draw" };
    case "pass":
      return { type: "pass" };
    case "leave":
      return { type: "leave" };
    case "callUno":
      return { type: "callUno" };
    case "catchUno": {
      const target = obj.target;
      if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target > 5) return null;
      return { type: "catchUno", target: target as Seat };
    }
    case "play": {
      if (typeof obj.cardId !== "string") return null;
      if (obj.uno !== undefined && typeof obj.uno !== "boolean") return null;
      const uno = obj.uno === true ? { uno: true as const } : {};
      if (obj.color === undefined) return { type: "play", cardId: obj.cardId, ...uno };
      if (typeof obj.color !== "string" || !COLORS.includes(obj.color)) return null;
      return { type: "play", cardId: obj.cardId, color: obj.color as Color, ...uno };
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
   * after settlement (see UnoTableDO's refreshSeatCredits). 0 for an empty seat.
   */
  readonly credits: number;
  /** Occupant's equipped card-back skin, cached and refreshed alongside `credits`. "classic" for an empty seat. */
  readonly cardSkin: SkinId;
}

export interface StateMessage {
  readonly type: "state";
  /** Increments each time a fresh hand (ready-up -> deal) starts on this table. */
  readonly round: number;
  readonly seats: readonly SeatStatus[];
  /**
   * The recipient's own redacted view (viewFor(state, mySeat)) — null while
   * waiting for players to ready up. Never contains another seat's cards or
   * the draw pile's order mid-hand; every hand is public once finished.
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
  | RejectionReason
  | EmoteErrorCode;

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
 * disconnect that outlasts the 30s reconnect grace (see UnoTableDO). No
 * settlement follows — the DO's own final `state` broadcast (view: null)
 * arrives right after this and the table accepts no further game actions.
 */
export interface AbortedMessage {
  readonly type: "aborted";
  readonly leaver: { readonly seat: Seat; readonly username: string };
}

export type ServerMessage = StateMessage | ErrorMessage | SettledMessage | AbortedMessage | EmoteMessage;
