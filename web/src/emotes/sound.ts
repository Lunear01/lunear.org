import type { EmoteId } from "worker/src/shop/emotes";

/** Emotes with a sound track; the throw repeats until the track ends. */
export const SOUNDS: Partial<Record<EmoteId, string>> = {
  tomato: "/sounds/tomato.mp3",
};

const MUTE_KEY = "lunear:emote-muted";

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts this page view only.
  }
  if (muted) playing.forEach((a) => a.pause());
}

const playing = new Set<HTMLAudioElement>();

/** Starts the emote's track. Resolves once playback starts; rejects if muted, missing or blocked by autoplay. */
export function playEmoteSound(id: EmoteId): Promise<HTMLAudioElement> {
  const src = SOUNDS[id];
  if (!src || isMuted()) return Promise.reject(new Error("no sound"));
  const audio = new Audio(src);
  audio.volume = 0.7;
  playing.add(audio);
  audio.addEventListener("ended", () => playing.delete(audio));
  audio.addEventListener("pause", () => playing.delete(audio));
  return audio.play().then(() => audio, (err) => {
    playing.delete(audio);
    throw err;
  });
}
