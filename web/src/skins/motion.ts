import { animate } from "motion";
import type { AnimatedSkinId } from "./renderer";

interface Entrance {
  /** Same transform function list in every keyframe; "none" interpolates to scale(0). */
  transform: string[];
  filter: string[];
  opacity: number[];
  duration: number;
  ease: "easeOut" | [number, number, number, number];
  times?: number[];
}

const ENTRANCES: Record<AnimatedSkinId, Entrance> = {
  // Warps in from a starburst.
  nebula: {
    opacity: [0, 1, 1],
    transform: ["scale(0.15) rotate(-28deg)", "scale(1.08) rotate(3deg)", "scale(1) rotate(0deg)"],
    filter: ["brightness(2.2)", "brightness(1.3)", "brightness(1)"],
    duration: 0.75,
    ease: [0.2, 0.8, 0.2, 1],
  },
  // Lands white-hot, cools, small shake.
  "molten-core": {
    opacity: [0, 1, 1, 1, 1],
    transform: [
      "translate(0px, -34px) scale(1.06)",
      "translate(0px, 0px) scale(1)",
      "translate(-2px, 0px) scale(1)",
      "translate(2px, 0px) scale(1)",
      "translate(0px, 0px) scale(1)",
    ],
    filter: ["brightness(2.6)", "brightness(1.8)", "brightness(1.35)", "brightness(1.1)", "brightness(1)"],
    duration: 1.05,
    ease: "easeOut",
    times: [0, 0.28, 0.42, 0.56, 1],
  },
  // Drifts down like a curtain fold settling.
  aurora: {
    opacity: [0, 1, 1],
    transform: ["translate(0px, -22px) skewX(10deg)", "translate(0px, 2px) skewX(-3deg)", "translate(0px, 0px) skewX(0deg)"],
    filter: ["brightness(1.7)", "brightness(1.15)", "brightness(1)"],
    duration: 0.9,
    ease: "easeOut",
  },
  // Strikes in with a double flash and jolt.
  thunderstrike: {
    opacity: [0, 1, 0.5, 1, 1],
    transform: [
      "translate(0px, -40px) scale(1.05)",
      "translate(0px, 0px) scale(1)",
      "translate(-3px, 0px) scale(1)",
      "translate(3px, 0px) scale(1)",
      "translate(0px, 0px) scale(1)",
    ],
    filter: ["brightness(3)", "brightness(1)", "brightness(2.2)", "brightness(1.1)", "brightness(1)"],
    duration: 0.55,
    ease: "easeOut",
    times: [0, 0.22, 0.38, 0.6, 1],
  },
};

/**
 * Skin-themed entrance on `el`; inline styles are cleared afterwards so CSS
 * transforms (selection lift, fan rotation) apply again. Returns cleanup.
 */
export function playEntrance(el: HTMLElement, skin: AnimatedSkinId, index: number): () => void {
  const { transform, filter, opacity, ...timing } = ENTRANCES[skin];
  const clear = () => {
    el.style.removeProperty("opacity");
    el.style.removeProperty("transform");
    el.style.removeProperty("filter");
  };
  el.style.opacity = "0";
  const controls = animate(el, { opacity, transform, filter }, { ...timing, delay: Math.min(index, 20) * 0.045 });
  // Next frame: Motion commits final values inline as it resolves.
  let cancelled = false;
  const settle = () => requestAnimationFrame(() => !cancelled && clear());
  void controls.then(settle, settle);
  return () => {
    cancelled = true;
    controls.stop();
    clear();
  };
}
