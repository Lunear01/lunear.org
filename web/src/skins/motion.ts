import { animate } from "motion";
import type { AnimatedSkinId } from "./renderer";

/**
 * Skin-themed entrance on `el`; inline styles are cleared afterwards so CSS
 * transforms (selection lift, fan rotation) apply again. Returns cleanup.
 */
export function playEntrance(el: HTMLElement, skin: AnimatedSkinId, index: number): () => void {
  const delay = Math.min(index, 20) * 0.045;
  const clear = () => {
    el.style.removeProperty("opacity");
    el.style.removeProperty("transform");
    el.style.removeProperty("filter");
  };
  el.style.opacity = "0";
  const controls =
    skin === "nebula"
      ? animate(
          el,
          {
            opacity: [0, 1, 1],
            // Same function list in every keyframe; "none" interpolates to scale(0).
            transform: ["scale(0.15) rotate(-28deg)", "scale(1.08) rotate(3deg)", "scale(1) rotate(0deg)"],
            filter: ["brightness(2.2)", "brightness(1.3)", "brightness(1)"],
          },
          { duration: 0.75, delay, ease: [0.2, 0.8, 0.2, 1] },
        )
      : animate(
          el,
          {
            opacity: [0, 1, 1, 1, 1],
            transform: [
              "translate(0px, -34px) scale(1.06)",
              "translate(0px, 0px) scale(1)",
              "translate(-2px, 0px) scale(1)",
              "translate(2px, 0px) scale(1)",
              "translate(0px, 0px) scale(1)",
            ],
            filter: ["brightness(2.6)", "brightness(1.8)", "brightness(1.35)", "brightness(1.1)", "brightness(1)"],
          },
          { duration: 1.05, delay, ease: "easeOut", times: [0, 0.28, 0.42, 0.56, 1] },
        );
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
