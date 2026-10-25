import type { EmoteId } from "worker/src/shop/emotes";

/** How the glyph travels from sender to target. */
export type Path = "arc" | "lob" | "glide" | "straight" | "toss" | "drop" | "pop";
/** What plays at the target on arrival. */
export type Impact = "splat" | "splash" | "petals" | "clap" | "steam" | "confetti" | "sparkle";

export interface EmoteAction {
  path: Path;
  /** Flight seconds. */
  duration: number;
  impact: Impact;
  /** Splat/splash colour. */
  color: string;
}

export const ACTIONS: Record<EmoteId, EmoteAction> = {
  tomato: { path: "arc", duration: 0.7, impact: "splat", color: "#e0362c" },
  "paper-plane": { path: "glide", duration: 1.3, impact: "sparkle", color: "#f4f1ea" },
  coffee: { path: "drop", duration: 0.8, impact: "steam", color: "#f4f1ea" },
  "high-five": { path: "straight", duration: 0.35, impact: "clap", color: "#f0c66e" },
  rose: { path: "toss", duration: 1.0, impact: "petals", color: "#e2475d" },
  "water-balloon": { path: "lob", duration: 1.1, impact: "splash", color: "#4fb3ff" },
  cake: { path: "arc", duration: 0.8, impact: "splat", color: "#fff4e0" },
  champagne: { path: "pop", duration: 0.7, impact: "confetti", color: "#f0c66e" },
};
