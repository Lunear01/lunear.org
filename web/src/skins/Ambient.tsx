import { motion } from "motion/react";
import type { AnimatedSkinId } from "./renderer";

// Fixed spot tables; a card's index picks its offsets so a fan doesn't pulse in sync.
const SPARK_SPOTS = [
  { x: "22%", y: "18%" },
  { x: "74%", y: "30%" },
  { x: "35%", y: "72%" },
  { x: "68%", y: "84%" },
  { x: "50%", y: "46%" },
];
const EMBER_LANES = ["18%", "42%", "63%", "81%", "30%"];

/**
 * Per-skin sweep and `particles` sparks/embers over an animated card.
 * Backs pass 0: a 20-card fan of infinite particle loops is the main frame cost.
 */
export function Ambient({ skin, index, particles = 2 }: { skin: AnimatedSkinId; index: number; particles?: number }) {
  const lanes = Array.from({ length: particles }, (_, n) => n);
  const stagger = Math.min(index, 20);
  const pick = (n: number, len: number) => (index * 2 + n) % len;

  if (skin === "nebula") {
    return (
      <>
        <motion.span
          className="fx-track"
          initial={{ x: "-100%", y: "-100%" }}
          animate={{ x: ["-100%", "100%"], y: ["-100%", "100%"] }}
          transition={{ duration: 1.25, ease: "easeIn", repeat: Infinity, repeatDelay: 5.2, delay: 1 + stagger * 0.09 }}
        >
          <span className="fx-comet" />
        </motion.span>
        {lanes.map((n) => {
          const spot = SPARK_SPOTS[pick(n, SPARK_SPOTS.length)];
          return (
            <motion.span
              key={n}
              className="fx-spark"
              style={{ left: spot.x, top: spot.y }}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: [0, 1, 0], rotate: [0, 90], opacity: [0, 1, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 2.2 + n, delay: n * 0.9 + stagger * 0.27 }}
            />
          );
        })}
      </>
    );
  }

  return (
    <>
      <motion.span
        className="fx-track"
        initial={{ y: "100%" }}
        animate={{ y: ["100%", "-100%"] }}
        transition={{ duration: 1.7, ease: "easeInOut", repeat: Infinity, repeatDelay: 4, delay: 0.8 + stagger * 0.09 }}
      >
        <span className="fx-heat" />
      </motion.span>
      {lanes.map((n) => (
        <motion.span
          key={n}
          className="fx-track"
          initial={{ y: "0%", opacity: 0 }}
          animate={{ y: ["0%", "-85%"], x: ["0%", n % 2 ? "6%" : "-6%"], opacity: [0, 1, 0] }}
          transition={{ duration: 2.2, ease: "easeOut", repeat: Infinity, repeatDelay: 0.6 + n * 0.7, delay: n * 0.8 + stagger * 0.23 }}
        >
          <span className="fx-ember" style={{ left: EMBER_LANES[pick(n, EMBER_LANES.length)] }} />
        </motion.span>
      ))}
    </>
  );
}
