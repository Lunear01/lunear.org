import { motion } from "motion/react";
import type { SkinId } from "worker/src/shop/catalog";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { isAnimatedSkin } from "../renderer";
import "./effects.css";

/**
 * Rotating skin-coloured border for a seat panel (parent must be positioned
 * and rounded). Faster and thicker while `active`. Animated skins only.
 */
export function SeatAura({ skin, active = false }: { skin: SkinId; active?: boolean }) {
  const reduced = usePrefersReducedMotion();
  if (!isAnimatedSkin(skin)) return null;
  return (
    <span className={`seat-aura seat-aura--${skin} ${active ? "seat-aura--active" : ""}`} aria-hidden="true">
      <motion.span
        key={active ? "active" : "idle"}
        className="seat-aura__spin"
        animate={reduced ? undefined : { rotate: 360 }}
        transition={{ duration: active ? 2 : 6, ease: "linear", repeat: Infinity }}
      />
    </span>
  );
}
