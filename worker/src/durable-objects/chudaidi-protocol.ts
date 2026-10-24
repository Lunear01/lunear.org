// Wire protocol between a browser client and its table's ChuDaiDTableDO, over
// a single WebSocket. Imported by the client (web/) for typed messages and by
// the DO itself so both sides share one definition. Same shape as
// protocol.ts (doudizhu); the action set is play or pass.
import type { RedactedView, RejectionReason, Seat } from "chudaidi";
import type { SkinId } from "../shop/catalog";

export type { Seat };

// --- Client -> server --------------------------------------------------------

export type ClientMessage =
  | { readonly type: "ready" }
  | { readonly type: "play"; readonly cardIds: readonly string[] }
  | { readonly type: "pass" }
  | { readonly type: "leave" };

/** Validates decoded JSON into a ClientMessage; null for anything malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case "ready":
      return { type: "ready" };
    case "pass":
      return { type: "pass" };
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
  /** Cached D1 balance, refreshed on connect and after settlement only. 0 for an empty seat. */
  readonly credits: number;
  /** Occupant's equipped card-back skin, cached and refreshed alongside `credits`. "classic" for an empty seat. */
  readonly cardSkin: SkinId;
}

export interface StateMessage {
  readonly type: "state";
  /** Increments each time a fresh hand (ready-up -> deal) starts on this table. */
  readonly round: number;
  readonly seats: readonly SeatStatus[];
  /** The recipient's own redacted view; null while waiting for ready-up. */
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

/** Sent once when a hand is voided by a leave or an expired disconnect grace. No settlement follows. */
export interface AbortedMessage {
  readonly type: "aborted";
  readonly leaver: { readonly seat: Seat; readonly username: string };
}

export type ServerMessage = StateMessage | ErrorMessage | SettledMessage | AbortedMessage;
