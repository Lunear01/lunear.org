import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import type { SkinId } from "worker/src/shop/catalog";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { Ambient } from "./Ambient";
import { playEntrance } from "./motion";
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
  if (isAnimatedSkin(skin)) return <AnimatedBack skin={skin} index={index} />;
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

function useShader(skin: AnimatedSkinId, index: number, face: boolean) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return subscribe(canvas, skin, index, face) || undefined;
  }, [skin, index, face]);
  return canvasRef;
}

function AnimatedBack({ skin, index }: { skin: AnimatedSkinId; index: number }) {
  const artRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useShader(skin, index, false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || !artRef.current) return;
    return playEntrance(artRef.current, skin, index);
    // Mount only: replaying on prop change would re-deal the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span ref={artRef} className={`skin-art skin-art--${skin}`} aria-hidden="true">
      <canvas ref={canvasRef} className="skin-art__canvas" />
      {!reduced && (
        <>
          <motion.span
            className="skin-art__glow"
            animate={{ opacity: [0.25, 0.85, 0.25] }}
            transition={{ duration: 2.8, ease: "easeInOut", repeat: Infinity, delay: Math.min(index, 20) * 0.12 }}
          />
          <Ambient skin={skin} index={index} particles={0} />
        </>
      )}
    </span>
  );
}

function FaceArt({ skin, index }: { skin: AnimatedSkinId; index: number }) {
  const canvasRef = useShader(skin, index, true);
  const reduced = usePrefersReducedMotion();
  return (
    <span className="face-art" aria-hidden="true">
      <canvas ref={canvasRef} className="skin-art__canvas" />
      {!reduced && <Ambient skin={skin} index={index} />}
    </span>
  );
}

/**
 * Skin for a card front: class for the host, an art layer to render first
 * inside it, and a ref that plays the skin's entrance on mount.
 */
export function useSkinFace<T extends HTMLElement>(skin: SkinId = "classic", index = 0) {
  const ref = useRef<T>(null);
  const reduced = usePrefersReducedMotion();
  const animated = isAnimatedSkin(skin);

  useEffect(() => {
    if (!animated || reduced || !ref.current) return;
    return playEntrance(ref.current, skin, index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ref,
    faceClass: skin === "classic" ? "" : `face-host face--${skin}`,
    faceArt: animated ? <FaceArt skin={skin} index={index} /> : null,
  };
}
