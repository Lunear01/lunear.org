// Wire/view types shared with the backend, imported type-only so nothing
// here reaches into worker/ or games/doudizhu/ at runtime (they're erased by
// `import type` before Vite ever bundles). This is the one seam S8b is
// allowed to cross into those workspaces for — see
// worker/src/durable-objects/protocol.ts (wire messages) and
// games/doudizhu/src (the redacted view shape) for the source of truth.
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
} from "worker/src/durable-objects/protocol";

export type {
  Card,
  Combo,
  FinishedState,
  PlayRecord,
  RedactedBiddingView,
  RedactedFinishedView,
  RedactedPlayingView,
  RedactedRedealView,
  RedactedView,
  Suit,
} from "doudizhu";
