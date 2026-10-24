import { motion } from "motion/react";
import type { AnimatedSkinId } from "./renderer";

// Fixed spot and lane tables; a card's index picks its offsets so a fan doesn't pulse in sync.
const SPOTS = [
  { x: "22%", y: "18%" },
  { x: "74%", y: "30%" },
  { x: "35%", y: "72%" },
  { x: "68%", y: "84%" },
  { x: "50%", y: "46%" },
];
const LANES = ["18%", "42%", "63%", "81%", "30%"];

type Keyframes = Record<string, string | number | (string | number)[]>;

/** One pass across the card; Motion moves its card-sized track in % of the card. */
interface Sweep {
  className: string;
  from: Keyframes;
  to: Keyframes;
  duration: number;
  ease: "easeIn" | "easeInOut" | "linear";
  repeatDelay: number;
}

/** "spot" pulses in place; "lane" travels a card-sized track. */
interface Particle {
  kind: "spot" | "lane";
  className: string;
  from: Keyframes;
  to: (n: number) => Keyframes;
  duration: number;
  repeatDelay: number;
}

const SWEEPS: Record<AnimatedSkinId, Sweep> = {
  nebula: {
    className: "fx-comet",
    from: { x: "-100%", y: "-100%" },
    to: { x: ["-100%", "100%"], y: ["-100%", "100%"] },
    duration: 1.25,
    ease: "easeIn",
    repeatDelay: 5.2,
  },
  "molten-core": {
    className: "fx-heat",
    from: { y: "100%" },
    to: { y: ["100%", "-100%"] },
    duration: 1.7,
    ease: "easeInOut",
    repeatDelay: 4,
  },
  aurora: {
    className: "fx-ribbon",
    from: { x: "-100%" },
    to: { x: ["-100%", "100%"] },
    duration: 2.4,
    ease: "easeInOut",
    repeatDelay: 3.4,
  },
  thunderstrike: {
    className: "fx-arc",
    from: { x: "-100%", y: "100%" },
    to: { x: ["-100%", "100%"], y: ["100%", "-100%"] },
    duration: 0.3,
    ease: "linear",
    repeatDelay: 5.5,
  },
};

const PARTICLES: Record<AnimatedSkinId, Particle> = {
  nebula: {
    kind: "spot",
    className: "fx-spark",
    from: { scale: 0, opacity: 0 },
    to: () => ({ scale: [0, 1, 0], rotate: [0, 90], opacity: [0, 1, 0] }),
    duration: 1.4,
    repeatDelay: 2.2,
  },
  "molten-core": {
    kind: "lane",
    className: "fx-ember",
    from: { y: "0%", opacity: 0 },
    to: (n) => ({ y: ["0%", "-85%"], x: ["0%", n % 2 ? "6%" : "-6%"], opacity: [0, 1, 0] }),
    duration: 2.2,
    repeatDelay: 0.6,
  },
  aurora: {
    kind: "lane",
    className: "fx-snow",
    from: { y: "0%", opacity: 0 },
    to: (n) => ({ y: ["0%", "90%"], x: ["0%", n % 2 ? "8%" : "-8%", "0%"], opacity: [0, 1, 1, 0] }),
    duration: 3.4,
    repeatDelay: 0.4,
  },
  thunderstrike: {
    kind: "spot",
    className: "fx-zap",
    from: { scale: 0.6, opacity: 0 },
    to: () => ({ opacity: [0, 1, 0.2, 1, 0], scale: [0.6, 1.2, 0.8, 1.1, 0.6] }),
    duration: 0.45,
    repeatDelay: 3,
  },
};

/**
 * Per-skin sweep and `particles` loops over an animated card.
 * Backs pass 0: a 20-card fan of infinite particle loops is the main frame cost.
 */
export function Ambient({ skin, index, particles = 2 }: { skin: AnimatedSkinId; index: number; particles?: number }) {
  const stagger = Math.min(index, 20);
  const pick = (n: number, len: number) => (index * 2 + n) % len;
  const sweep = SWEEPS[skin];
  const particle = PARTICLES[skin];

  return (
    <>
      <motion.span
        className="fx-track"
        initial={sweep.from}
        animate={sweep.to}
        transition={{ duration: sweep.duration, ease: sweep.ease, repeat: Infinity, repeatDelay: sweep.repeatDelay, delay: 0.8 + stagger * 0.09 }}
      >
        <span className={sweep.className} />
      </motion.span>
      {Array.from({ length: particles }, (_, n) => {
        const transition = {
          duration: particle.duration,
          ease: "easeOut" as const,
          repeat: Infinity,
          repeatDelay: particle.repeatDelay + n * 0.8,
          delay: n * 0.85 + stagger * 0.25,
        };
        if (particle.kind === "spot") {
          const spot = SPOTS[pick(n, SPOTS.length)];
          return (
            <motion.span
              key={n}
              className={particle.className}
              style={{ left: spot.x, top: spot.y }}
              initial={particle.from}
              animate={particle.to(n)}
              transition={transition}
            />
          );
        }
        return (
          <motion.span key={n} className="fx-track" initial={particle.from} animate={particle.to(n)} transition={transition}>
            <span className={particle.className} style={{ left: LANES[pick(n, LANES.length)] }} />
          </motion.span>
        );
      })}
    </>
  );
}
