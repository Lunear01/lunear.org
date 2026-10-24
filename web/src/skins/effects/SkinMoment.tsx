import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { SkinId } from "worker/src/shop/catalog";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { type AnimatedSkinId, isAnimatedSkin } from "../renderer";
import { ERUPTION, GALAXY, VERTEX } from "../shaders";
import "./effects.css";

const DURATION = 1.4;

interface SkinMomentProps {
  skin: SkinId;
  /** New value = new moment. Pass through useFreshKey. */
  momentKey: string | number | null;
  label: string;
  /** Wait before starting, e.g. for card reveals to finish. */
  delayMs?: number;
}

interface Active {
  key: string | number;
  skin: SkinId;
  label: string;
  delayMs: number;
}

/**
 * Full-screen skin overlay with a headline, ~3s. Animated skins only.
 * Latches each new key, so the key clearing on the next frame doesn't cut it short.
 */
export function SkinMoment({ skin, momentKey, label, delayMs = 0 }: SkinMomentProps) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState<Active | null>(null);
  if (momentKey !== null && momentKey !== active?.key) setActive({ key: momentKey, skin, label, delayMs });
  if (!active || reduced || !isAnimatedSkin(active.skin)) return null;
  return <Moment key={active.key} skin={active.skin} label={active.label} delayMs={active.delayMs} />;
}

function Moment({ skin, label, delayMs }: { skin: AnimatedSkinId; label: string; delayMs: number }) {
  const [started, setStarted] = useState(delayMs <= 0);
  useEffect(() => {
    if (started) return;
    const t = setTimeout(() => setStarted(true), delayMs);
    return () => clearTimeout(t);
  }, [started, delayMs]);
  return started ? <MomentOverlay skin={skin} label={label} /> : null;
}

function MomentOverlay({ skin, label }: { skin: AnimatedSkinId; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Fresh canvas per run: cleanup loses the context, and a lost canvas can't be reused.
    const canvas = document.createElement("canvas");
    canvas.className = "fx-moment__canvas";
    host.prepend(canvas);
    // Own short-lived context at low resolution (soft glow upscales cleanly); cap pixel count.
    const scale = Math.min(0.3, 480 / window.innerWidth);
    canvas.width = Math.round(window.innerWidth * scale);
    canvas.height = Math.round(window.innerHeight * scale);
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true });
    const timer = setTimeout(() => setDone(true), DURATION * 1000);
    if (!gl) {
      return () => {
        clearTimeout(timer);
        canvas.remove();
      };
    }

    const program = link(gl, skin === "nebula" ? GALAXY : ERUPTION);
    let frame = 0;
    if (program) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.useProgram(program);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const uTime = gl.getUniformLocation(program, "u_time");
      const uFade = gl.getUniformLocation(program, "u_fade");
      gl.uniform2f(gl.getUniformLocation(program, "u_res"), canvas.width, canvas.height);
      gl.uniform1f(gl.getUniformLocation(program, "u_seed"), Math.random() * 10);
      const start = performance.now();
      const tick = (now: number) => {
        const t = (now - start) / 1000;
        const fade = Math.min(1, t / 0.15) * Math.min(1, Math.max(0, (DURATION - t) / 0.45));
        gl.uniform1f(uTime, t);
        gl.uniform1f(uFade, fade);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (t < DURATION) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    };
  }, [skin]);

  if (done) return null;
  return (
    <div ref={hostRef} className={`fx-moment fx-moment--${skin}`} aria-live="polite">
      <motion.div
        className="fx-moment__label"
        initial={{ scale: 0.92, opacity: 0, y: 8 }}
        animate={{ scale: [0.92, 1, 1, 1], opacity: [0, 1, 1, 0], y: [8, 0, 0, 0] }}
        transition={{ duration: DURATION, times: [0, 0.15, 0.7, 1], ease: "easeOut" }}
      >
        {label}
      </motion.div>
    </div>
  );
}

function link(gl: WebGLRenderingContext, fragment: string): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("moment shader:", gl.getShaderInfoLog(shader));
      return null;
    }
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}
