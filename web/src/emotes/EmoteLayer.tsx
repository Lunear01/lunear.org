import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate } from "motion";
import { motion } from "motion/react";
import type { EmoteMessage } from "worker/src/durable-objects/emote-protocol";
import { getEmote } from "worker/src/shop/emotes";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { ACTIONS, type EmoteAction, type Impact } from "./actions";
import { SOUNDS, playEmoteSound } from "./sound";
import "./emotes.css";

export type EmoteEvent = EmoteMessage & { seq: number };

interface SeatName {
  seat: number;
  username: string | null;
}

interface Flight {
  id: string;
  glyph: string;
  action: EmoteAction;
  from: { x: number; y: number };
  to: { x: number; y: number };
  caption: string | null;
}

/** Centre of the element tagged data-emote-seat, or a screen-edge fallback. */
function seatPoint(seat: number, fallbackY: number): { x: number; y: number } {
  const el = document.querySelector(`[data-emote-seat="${seat}"]`);
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight * fallbackY };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const jitter = (p: { x: number; y: number }, by: number) => ({ x: p.x + (Math.random() - 0.5) * 2 * by, y: p.y + (Math.random() - 0.5) * 2 * by });

const BARRAGE_GAP_MS = 420;
// Used when the track can't play (muted, autoplay blocked); matches the clip length.
const BARRAGE_FALLBACK_MS = 7000;
const BARRAGE_MAX_MS = 12000;

/**
 * Plays each emote broadcast as a flight from sender seat to target seat,
 * an impact, and a caption. Every player at the table sees the same thing.
 */
export function EmoteLayer({ event, seats, mySeat }: { event: EmoteEvent | null; seats: readonly SeatName[] | null; mySeat: number | null }) {
  const [flights, setFlights] = useState<Flight[]>([]);
  const reduced = usePrefersReducedMotion();
  const barrages = useRef(new Set<() => void>());

  // Leaving the table stops running barrages and their tracks.
  useEffect(() => {
    const set = barrages.current;
    return () => set.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    if (!event) return;
    const emote = getEmote(event.emoteId);
    if (!emote) return;
    const name = (seat: number) => (seat === mySeat ? "you" : (seats?.find((s) => s.seat === seat)?.username ?? `Seat ${seat + 1}`));
    const from = name(event.from);
    const make = (i: number, spread: number): Flight => ({
      id: `${event.seq}:${i}`,
      glyph: emote.glyph,
      action: ACTIONS[emote.id],
      from: jitter(seatPoint(event.from, 0.85), spread / 2),
      to: jitter(seatPoint(event.to, 0.2), spread),
      caption: i === 0 ? `${from.charAt(0).toUpperCase()}${from.slice(1)} ${emote.verb} ${name(event.to)}` : null,
    });
    setFlights((list) => [...list.slice(-15), make(0, 0)]);
    if (!SOUNDS[emote.id]) return;

    // Keep throwing until the track ends.
    let throws = 0;
    let stopped = false;
    const started = Date.now();
    let until = started + BARRAGE_FALLBACK_MS;
    const sound = playEmoteSound(emote.id).then(
      (audio) => {
        until = started + BARRAGE_MAX_MS;
        audio.addEventListener("ended", () => (stopped = true));
        audio.addEventListener("pause", () => (stopped = true));
        return audio;
      },
      () => null,
    );
    const timer = reduced
      ? null
      : setInterval(() => {
          if (stopped || Date.now() >= until) return void (timer && clearInterval(timer));
          throws += 1;
          setFlights((list) => [...list.slice(-15), make(throws, 18)]);
        }, BARRAGE_GAP_MS);
    barrages.current.add(() => {
      if (timer) clearInterval(timer);
      void sound.then((a) => a?.pause());
    });
    // Seats and names are read once per event; later changes don't replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.seq]);

  return (
    <div className="emote-layer" aria-live="polite">
      {flights.map((f) => (
        <FlightView key={f.id} flight={f} onDone={() => setFlights((list) => list.filter((x) => x.id !== f.id))} />
      ))}
    </div>
  );
}

function FlightView({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [landed, setLanded] = useState(reduced);
  const { action, from, to } = flight;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const captionRef = useRef<HTMLSpanElement>(null);
  const [captionX, setCaptionX] = useState(to.x);

  // Keep the caption on screen when the target sits near a side edge.
  useLayoutEffect(() => {
    const half = (captionRef.current?.offsetWidth ?? 0) / 2 + 8;
    setCaptionX(Math.min(Math.max(to.x, half), window.innerWidth - half));
  }, [landed, to.x]);

  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(onDone, 1700);
    return () => clearTimeout(t);
  }, [landed, onDone]);

  return (
    <>
      {!landed && <FlightGlyph glyph={flight.glyph} action={action} from={from} dx={dx} dy={dy} onLand={() => setLanded(true)} />}
      {landed && (
        <span className="emote-impact" style={{ left: to.x, top: to.y }}>
          {!reduced && <ImpactView impact={action.impact} color={action.color} />}
          <motion.span
            className="emote-glyph emote-glyph--landed"
            initial={{ scale: 1, opacity: 1 }}
            animate={{ scale: reduced ? 1 : [1, 1.25, 0.9], opacity: [1, 1, 0] }}
            transition={{ duration: 1.2, times: [0, 0.3, 1] }}
          >
            {flight.glyph}
          </motion.span>
        </span>
      )}
      {landed && flight.caption && (
        // Above the target when it sits near the bottom edge (own hand on phones).
        <span
          className={`emote-caption-anchor ${to.y > window.innerHeight - 90 ? "emote-caption-anchor--above" : ""}`}
          style={{ left: captionX, top: to.y }}
        >
          <motion.span
            ref={captionRef}
            className="emote-caption"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: [0, 1, 1, 0], y: [6, 0, 0, -4] }}
            transition={{ duration: 1.7, times: [0, 0.15, 0.8, 1] }}
          >
            {flight.caption}
          </motion.span>
        </span>
      )}
    </>
  );
}

const TRAIL = [0.03, 0.06, 0.09, 0.12, 0.15];

/** Flying glyph plus fading ghosts; transform keyframes run on the compositor, off the main thread. */
function FlightGlyph({ glyph, action, from, dx, dy, onLand }: { glyph: string; action: EmoteAction; from: { x: number; y: number }; dx: number; dy: number; onLand: () => void }) {
  const lead = useRef<HTMLSpanElement>(null);
  const ghosts = useRef<(HTMLSpanElement | null)[]>([]);
  const trail = action.path !== "drop" && action.path !== "pop";

  useEffect(() => {
    if (!lead.current) return;
    const { transform, opacity } = flightFrames(action, dx, dy);
    const run = [animate(lead.current, { transform, opacity }, { duration: action.duration, ease: "linear" })];
    if (trail)
      ghosts.current.forEach((el, i) => {
        if (!el) return;
        const fade = opacity.map((o, k) => o * (0.42 - i * 0.075) * (k === opacity.length - 1 ? 0 : 1));
        run.push(animate(el, { transform, opacity: fade }, { duration: action.duration, delay: TRAIL[i], ease: "linear" }));
      });
    let live = true;
    run[0].finished.then(() => live && onLand());
    return () => {
      live = false;
      run.forEach((r) => r.stop());
    };
    // Plays once per flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {trail &&
        TRAIL.map((_, i) => (
          <span key={i} ref={(el) => void (ghosts.current[i] = el)} className="emote-glyph emote-glyph--ghost" style={{ left: from.x, top: from.y, opacity: 0 }}>
            {glyph}
          </span>
        ))}
      <span ref={lead} className="emote-glyph" style={{ left: from.x, top: from.y, opacity: 0 }}>
        {glyph}
      </span>
    </>
  );
}

const SAMPLES = 48;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Sampled transform/opacity keyframes relative to the sender; the last frame sits on the target. */
function flightFrames(action: EmoteAction, dx: number, dy: number) {
  const dist = Math.hypot(dx, dy);
  // Quadratic Bezier with its control point lifted above the midpoint: a true projectile curve.
  const arc = (t: number, lift: number) => ({ x: dx * t, y: dy * t - 4 * lift * t * (1 - t) });
  const point = (t: number): { x: number; y: number; r: number; s: number; o: number } => {
    const bump = Math.sin(Math.PI * t);
    switch (action.path) {
      case "arc":
        return { ...arc(t, clamp(dist * 0.3, 60, 160)), r: 300 * t, s: 0.8 + 0.2 * t + 0.25 * bump, o: 1 };
      case "lob":
        return { ...arc(t, clamp(dist * 0.55, 110, 240)), r: -20 * bump + 10 * t, s: 0.8 + 0.2 * t + 0.35 * bump, o: 1 };
      case "toss":
        return { ...arc(t, clamp(dist * 0.2, 40, 100)), r: 360 * t, s: 0.8 + 0.2 * t, o: 1 };
      case "glide": {
        const e = t * t * (3 - 2 * t);
        const wave = Math.sin(e * Math.PI * 3) * 22 * bump;
        // Wobble perpendicular to the flight line.
        const nx = dist ? -dy / dist : 0;
        const ny = dist ? dx / dist : 0;
        return { x: dx * e + nx * wave, y: dy * e + ny * wave, r: Math.cos(e * Math.PI * 3) * 12 * bump, s: 0.8 + 0.2 * Math.min(1, t * 4), o: 1 };
      }
      case "straight": {
        const e = t * t;
        return { x: dx * e, y: dy * e, r: 0, s: 0.8 + 0.5 * e, o: 1 };
      }
      // Appear above the target, then settle onto it.
      case "drop": {
        const u = clamp((t - 0.45) / 0.55, 0, 1);
        const a = clamp(t / 0.45, 0, 1);
        return { x: dx, y: dy - 70 + 70 * u * u, r: 0, s: 0.6 + 0.4 * a, o: a };
      }
      case "pop": {
        const a = clamp(t / 0.3, 0, 1);
        const late = clamp((t - 0.6) / 0.4, 0, 1);
        return { x: dx, y: dy - 40 + 10 * late, r: 8 * Math.sin(t * Math.PI * 4) * (1 - late) - 15 * late, s: 0.6 + 0.4 * a + 0.2 * late, o: a };
      }
    }
  };
  const transform: string[] = [];
  const opacity: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const p = point(i / SAMPLES);
    transform.push(`translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${p.r.toFixed(1)}deg) scale(${p.s.toFixed(3)})`);
    opacity.push(p.o);
  }
  return { transform, opacity };
}

const PARTICLES = 12;

function ImpactView({ impact, color }: { impact: Impact; color: string }) {
  switch (impact) {
    case "splat":
      return (
        <>
          <motion.span className="emote-splat" style={{ background: color }} initial={{ scale: 0, opacity: 0.95 }} animate={{ scale: [0, 1.2, 1], opacity: [0.95, 0.95, 0] }} transition={{ duration: 1.4, times: [0, 0.15, 1] }} />
          <Burst count={PARTICLES} color={color} distance={46} gravity={30} size={8} />
        </>
      );
    case "splash":
      return <Burst count={16} color={color} distance={60} gravity={50} size={7} />;
    case "petals":
      return <Burst count={10} color={color} distance={40} gravity={70} size={9} petal />;
    case "confetti":
      return (
        <>
          <motion.span className="emote-foam" initial={{ scale: 0, opacity: 1 }} animate={{ scale: [0, 1.4], opacity: [1, 0] }} transition={{ duration: 0.9 }} />
          <Burst count={18} color="multi" distance={80} gravity={60} size={6} />
        </>
      );
    case "clap":
      return (
        <>
          {Array.from({ length: 8 }, (_, i) => (
            <motion.span
              key={i}
              className="emote-ray"
              style={{ rotate: `${i * 45}deg`, background: color }}
              initial={{ scaleX: 0, opacity: 1 }}
              animate={{ scaleX: [0, 1, 1], opacity: [1, 1, 0] }}
              transition={{ duration: 0.5 }}
            />
          ))}
        </>
      );
    case "steam":
      return (
        <>
          {[-10, 2, 12].map((x, i) => (
            <motion.span
              key={i}
              className="emote-steam"
              style={{ left: x }}
              initial={{ y: -14, opacity: 0, scaleY: 0.6 }}
              animate={{ y: [-14, -56], opacity: [0, 0.8, 0], scaleY: [0.6, 1.2], x: [0, i % 2 ? 6 : -6] }}
              transition={{ duration: 1.5, delay: i * 0.2, ease: "easeOut" }}
            />
          ))}
        </>
      );
    case "sparkle":
      return <Burst count={8} color={color} distance={30} gravity={0} size={5} />;
  }
}

const CONFETTI = ["#e0362c", "#f0c66e", "#4fb3ff", "#6ad19a", "#c98bff"];

function Burst({ count, color, distance, gravity, size, petal = false }: { count: number; color: string; distance: number; gravity: number; size: number; petal?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 + (i % 2) * 0.3;
        const d = distance * (0.7 + (i % 3) * 0.2);
        const x = Math.cos(a) * d;
        const y = Math.sin(a) * d;
        return (
          <motion.span
            key={i}
            className={petal ? "emote-dot emote-dot--petal" : "emote-dot"}
            style={{ width: size, height: size, background: color === "multi" ? CONFETTI[i % CONFETTI.length] : color }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
            animate={{ x: [0, x * 0.8, x], y: [0, y * 0.8 - 10, y + gravity], opacity: [1, 1, 0], rotate: petal ? [0, 180, 300] : 0 }}
            transition={{ duration: 1.1, ease: "easeOut" }}
          />
        );
      })}
    </>
  );
}
