import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import type { SkinId } from "worker/src/shop/catalog";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { type AnimatedSkinId, isAnimatedSkin, subscribe } from "./renderer";
import "./skins.css";

interface SkinArtProps {
  skin: SkinId;
  /** Position in a hand fan: picks the shader variant and staggers Motion effects. */
  index?: number;
}

/** Fills a positioned card-back host with the skin. Classic renders nothing. */
export function SkinArt({ skin, index = 0 }: SkinArtProps) {
  if (skin === "classic") return null;
  if (isAnimatedSkin(skin)) return <AnimatedArt skin={skin} index={index} />;
  return <span className={`skin-art skin-art--${skin}`} aria-hidden="true" />;
}

/** Skin of the seat's occupant; classic when unknown. */
export function seatSkin(
  seats: readonly { seat: number; cardSkin: SkinId }[] | null | undefined,
  seat: number,
): SkinId {
  return seats?.find((s) => s.seat === seat)?.cardSkin ?? "classic";
}

/** Host class for an element that carries SkinArt. */
export function skinHostClass(skin: SkinId): string {
  return skin === "classic" ? "" : "skin-host";
}

function AnimatedArt({ skin, index }: { skin: AnimatedSkinId; index: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return subscribe(canvas, skin, index) || undefined;
  }, [skin, index]);

  const stagger = Math.min(index, 20);
  return (
    <motion.span
      className={`skin-art skin-art--${skin}`}
      aria-hidden="true"
      initial={reduced ? false : { scale: 0.4, opacity: 0, rotate: -14, y: -18 }}
      animate={{ scale: 1, opacity: 1, rotate: 0, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 20, delay: stagger * 0.035 }}
    >
      <canvas ref={canvasRef} className="skin-art__canvas" />
      {!reduced && (
        <>
          <motion.span
            className="skin-art__glow"
            animate={{ opacity: [0.25, 0.85, 0.25] }}
            transition={{ duration: 2.8, ease: "easeInOut", repeat: Infinity, delay: stagger * 0.12 }}
          />
          {/* Staggered per card, so the glint sweeps across a fan as a wave. */}
          <motion.span
            className="skin-art__glint"
            style={{ skewX: -18 }}
            initial={{ x: "-180%" }}
            animate={{ x: ["-180%", "320%"] }}
            transition={{ duration: 1.1, ease: [0.4, 0, 0.2, 1], repeat: Infinity, repeatDelay: 4.5, delay: 0.8 + stagger * 0.07 }}
          />
        </>
      )}
    </motion.span>
  );
}
