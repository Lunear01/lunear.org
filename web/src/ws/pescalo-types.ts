// Wire/view types for Pescalo (Go Fish), imported type-only so nothing reaches
// into worker/ or games/pescalo/ at runtime. Source of truth:
// worker/src/durable-objects/pescalo-protocol.ts and games/pescalo/src.
export type {
  AbortedMessage,
  ClientMessage,
  ErrorCode,
  ErrorMessage,
  Seat,
  SeatStatus,
  ServerMessage,
  SettledMessage,
  StateMessage,
} from "worker/src/durable-objects/pescalo-protocol";
export type { EmoteMessage } from "worker/src/durable-objects/emote-protocol";

export type {
  Books,
  Card,
  GameEvent,
  RedactedFinishedView,
  RedactedPlayingView,
  RedactedView,
} from "pescalo";
