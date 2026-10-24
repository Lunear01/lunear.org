import { useState } from "react";
import { motion } from "motion/react";
import type { SkinId } from "worker/src/shop/catalog";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { type AnimatedSkinId, isAnimatedSkin } from "../renderer";
import "./effects.css";

interface SkinBurstProps {
  skin: SkinId;
  /** New value = new burst. Pass through useFreshKey. */
  burstKey: string | number | null;
}

/** Skin burst centred on its positioned parent. Animated skins only. */
export function SkinBurst({ skin, burstKey }: SkinBurstProps) {
  const reduced = usePrefersReducedMotion();
  // Latched like SkinMoment: a key clearing next frame mustn't cut the burst.
  const [active, setActive] = useState<{ key: string | number; skin: SkinId } | null>(null);
  if (burstKey !== null && burstKey !== active?.key) setActive({ key: burstKey, skin });
  if (!active || reduced || !isAnimatedSkin(active.skin)) return null;
  return <Burst key={active.key} skin={active.skin} />;
}

const SHARDS = 14;
const EMBERS = 18;
// Jagged crack polylines from the centre, in a -100..100 box.
const CRACKS = [
  "M0 0 L18 -8 L30 -2 L52 -14 L80 -6",
  "M0 0 L-14 -12 L-26 -10 L-44 -30 L-70 -34",
  "M0 0 L6 16 L-2 30 L10 52 L4 78",
  "M0 0 L-16 8 L-34 4 L-50 20 L-82 16",
  "M0 0 L12 -20 L8 -36 L22 -56 L18 -80",
  "M0 0 L20 14 L38 12 L54 30 L76 34",
];

function Burst({ skin }: { skin: AnimatedSkinId }) {
  const [done, setDone] = useState(false);
  if (done) return null;
  const finish = () => setDone(true);

  if (skin === "nebula") {
    return (
      <span className="fx-burst" aria-hidden="true">
        <motion.span
          className="fx-burst__flash fx-burst__flash--nebula"
          initial={{ scale: 0, opacity: 0.95 }}
          animate={{ scale: 1.7, opacity: 0 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
        />
        {[0, 0.14].map((delay) => (
          <motion.span
            key={delay}
            className="fx-burst__ring"
            initial={{ scale: 0.15, opacity: 1 }}
            animate={{ scale: 3.4, opacity: 0 }}
            transition={{ duration: 0.95, delay, ease: [0.1, 0.7, 0.3, 1] }}
            onAnimationComplete={delay ? finish : undefined}
          />
        ))}
        {Array.from({ length: SHARDS }, (_, i) => {
          const a = (i / SHARDS) * Math.PI * 2 + (i % 2) * 0.2;
          const dist = 70 + (i % 3) * 28;
          return (
            <motion.span
              key={i}
              className="fx-burst__shard"
              initial={{ x: 0, y: 0, scale: 1.2, opacity: 1, rotate: 0 }}
              animate={{ x: Math.cos(a) * dist, y: Math.sin(a) * dist, scale: 0, opacity: [1, 1, 0], rotate: 180 }}
              transition={{ duration: 0.85, ease: [0.15, 0.8, 0.3, 1] }}
            />
          );
        })}
      </span>
    );
  }

  return (
    <span className="fx-burst" aria-hidden="true">
      <motion.span
        className="fx-burst__flash fx-burst__flash--molten"
        initial={{ scale: 0.3, opacity: 1 }}
        animate={{ scale: 2.1, opacity: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      />
      <svg className="fx-burst__cracks" viewBox="-100 -100 200 200">
        {CRACKS.map((d, i) => (
          <motion.path
            key={i}
            d={d}
            initial={{ pathLength: 0, opacity: 1 }}
            animate={{ pathLength: 1, opacity: [1, 1, 0] }}
            transition={{ pathLength: { duration: 0.25, ease: "easeOut" }, opacity: { duration: 1.1, times: [0, 0.6, 1] } }}
          />
        ))}
      </svg>
      {Array.from({ length: EMBERS }, (_, i) => {
        const a = (i / EMBERS) * Math.PI * 2;
        const dist = 50 + (i % 4) * 22;
        const x = Math.cos(a) * dist;
        const y = Math.sin(a) * dist;
        return (
          <motion.span
            key={i}
            className="fx-burst__ember"
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            // Up and out, then gravity pulls it down.
            animate={{ x: [0, x * 0.8, x], y: [0, y * 0.8 - 26, y + 34], opacity: [1, 1, 0], scale: [1, 1, 0.4] }}
            transition={{ duration: 1.1, ease: "easeOut" }}
            onAnimationComplete={i === 0 ? finish : undefined}
          />
        );
      })}
    </span>
  );
}
