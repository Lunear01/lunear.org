// Wire/view types shared with the backend for UNO, imported type-only so
// nothing here reaches into worker/ or games/uno/ at runtime (erased by
// `import type` before Vite ever bundles) — mirrors liarsbar-types.ts. See
// worker/src/durable-objects/uno-protocol.ts (wire messages) and
// games/uno/src (the redacted view shape) for the source of truth.
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
} from "worker/src/durable-objects/uno-protocol";
export type { EmoteMessage } from "worker/src/durable-objects/emote-protocol";

export type {
  Card,
  Color,
  Direction,
  GameEvent,
  Kind,
  RedactedFinishedView,
  RedactedPlayingView,
  RedactedView,
} from "uno";
