// Wire/view types shared with the backend for Liar's Bar, imported type-only
// so nothing here reaches into worker/ or games/liarsbar/ at runtime (erased
// by `import type` before Vite ever bundles) — mirrors types.ts's convention
// for doudizhu exactly. See
// worker/src/durable-objects/liarsbar-protocol.ts (wire messages) and
// games/liarsbar/src (the redacted view shape) for the source of truth.
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
} from "worker/src/durable-objects/liarsbar-protocol";

export type {
  Card,
  PlayRecord,
  PublicPlayerStatus,
  RedactedFinishedView,
  RedactedPlayingView,
  RedactedRoundEndView,
  RedactedView,
  RevealRecord,
  Rank,
  TableRank,
} from "liarsbar";
