// Emote wire types shared by every table protocol and the web client.
// Server-only relay logic lives in emote-relay.ts.
import { type EmoteId, getEmote } from "../shop/emotes";

export interface EmoteClientMessage {
  readonly type: "emote";
  readonly emoteId: EmoteId;
  readonly target: number;
}

/** Broadcast to every socket once the sender's stock was decremented. */
export interface EmoteMessage {
  readonly type: "emote";
  readonly from: number;
  readonly to: number;
  readonly emoteId: EmoteId;
}

export type EmoteErrorCode = "emote-empty" | "emote-cooldown" | "emote-target";

export const EMOTE_COOLDOWN_MS = 3000;

export function parseEmoteMessage(raw: unknown): EmoteClientMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "emote") return null;
  const emote = getEmote(obj.emoteId);
  if (!emote || typeof obj.target !== "number" || !Number.isInteger(obj.target)) return null;
  return { type: "emote", emoteId: emote.id, target: obj.target };
}
