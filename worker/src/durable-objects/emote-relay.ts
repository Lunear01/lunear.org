// Emote relay shared by every table DO. Runs before the game's own message
// parsing, so game protocols only add the emote types to their unions.
import {
  EMOTE_COOLDOWN_MS,
  type EmoteClientMessage,
  type EmoteErrorCode,
  type EmoteMessage,
} from "./emote-protocol";

export {
  EMOTE_COOLDOWN_MS,
  parseEmoteMessage,
  type EmoteClientMessage,
  type EmoteErrorCode,
  type EmoteMessage,
} from "./emote-protocol";

interface RelayInput {
  db: D1Database;
  sockets: readonly WebSocket[];
  from: { seat: number; userId: string };
  /** Seats with a player in them. */
  occupied: readonly number[];
  message: EmoteClientMessage;
}

type RelayResult = { ok: true } | { ok: false; code: EmoteErrorCode; message: string };

/** One per DO instance; cooldowns reset if the DO is evicted, which is harmless. */
export class EmoteRelay {
  private readonly lastSent = new Map<string, number>();

  async relay({ db, sockets, from, occupied, message }: RelayInput, now = Date.now()): Promise<RelayResult> {
    if (message.target === from.seat || !occupied.includes(message.target)) {
      return { ok: false, code: "emote-target", message: "pick another player at this table" };
    }
    const last = this.lastSent.get(from.userId);
    if (last !== undefined && now - last < EMOTE_COOLDOWN_MS) {
      return { ok: false, code: "emote-cooldown", message: "wait a moment before the next emote" };
    }
    const result = await db
      .prepare("UPDATE user_emotes SET qty = qty - 1 WHERE user_id = ? AND emote_id = ? AND qty > 0")
      .bind(from.userId, message.emoteId)
      .run();
    if (result.meta.changes === 0) {
      return { ok: false, code: "emote-empty", message: "none left; buy more in the shop" };
    }
    this.lastSent.set(from.userId, now);

    const json = JSON.stringify({ type: "emote", from: from.seat, to: message.target, emoteId: message.emoteId } satisfies EmoteMessage);
    for (const ws of sockets) {
      try {
        ws.send(json);
      } catch {
        /* socket may have just closed */
      }
    }
    return { ok: true };
  }
}
