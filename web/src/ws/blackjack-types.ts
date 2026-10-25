// Wire/view types shared with the backend for blackjack, imported type-only
// so nothing here reaches into worker/ or games/blackjack/ at runtime (erased
// by `import type` before Vite ever bundles) — mirrors poker-types.ts's
// convention exactly. See worker/src/durable-objects/blackjack-protocol.ts
// (wire messages) and games/blackjack/src (the redacted view shape) for the
// source of truth.
export type {
  ClientMessage,
  ErrorCode,
  ErrorMessage,
  Seat,
  SeatStatus,
  ServerMessage,
  SettledMessage,
  StateMessage,
} from "worker/src/durable-objects/blackjack-protocol";
export type { EmoteMessage } from "worker/src/durable-objects/emote-protocol";

export type {
  Card,
  Outcome,
  PublicHandStatus,
  PublicPlayerStatus,
  RedactedActingView,
  RedactedFinishedView,
  RedactedInsuranceView,
  RedactedView,
  Suit,
} from "blackjack";
