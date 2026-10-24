import { MOLTEN, NEBULA, VERTEX } from "./shaders";

// One shared WebGL canvas for every animated card back on the page. Browsers
// cap live WebGL contexts at ~16, and a table can show 40+ backs, so each
// frame renders a 2x2 atlas per skin (4 seed variants) once and blits a cell
// into each card's 2D canvas.

export type AnimatedSkinId = "nebula" | "molten-core";

export const CELL_W = 200;
export const CELL_H = 280;
const VARIANTS = 4;

const SOURCES: Record<AnimatedSkinId, string> = { nebula: NEBULA, "molten-core": MOLTEN };

interface Target {
  ctx: CanvasRenderingContext2D;
  variant: number;
}

interface ProgramInfo {
  program: WebGLProgram;
  uTime: WebGLUniformLocation | null;
  uSeed: WebGLUniformLocation | null;
  uFace: WebGLUniformLocation | null;
}

interface Group {
  skin: AnimatedSkinId;
  face: boolean;
  set: Set<Target>;
}

/** Keyed `${skin}|${face}`: backs and fronts render as separate atlases. */
const targets = new Map<string, Group>();
let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let programs: Partial<Record<AnimatedSkinId, ProgramInfo>> = {};
let failed = false;
let frame = 0;
const start = performance.now();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function compile(ctx: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = ctx.createShader(type)!;
  ctx.shaderSource(shader, src);
  ctx.compileShader(shader);
  if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
    throw new Error(ctx.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

function buildProgram(ctx: WebGLRenderingContext, fragment: string): ProgramInfo {
  const program = ctx.createProgram()!;
  ctx.attachShader(program, compile(ctx, ctx.VERTEX_SHADER, VERTEX));
  ctx.attachShader(program, compile(ctx, ctx.FRAGMENT_SHADER, fragment));
  ctx.bindAttribLocation(program, 0, "a_pos");
  ctx.linkProgram(program);
  if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) {
    throw new Error(ctx.getProgramInfoLog(program) ?? "program link failed");
  }
  return {
    program,
    uTime: ctx.getUniformLocation(program, "u_time"),
    uSeed: ctx.getUniformLocation(program, "u_seed"),
    uFace: ctx.getUniformLocation(program, "u_face"),
  };
}

/** Lazily creates the context and quad. False once WebGL is unavailable. */
function ensureGl(): boolean {
  if (gl) return true;
  if (failed) return false;
  canvas = document.createElement("canvas");
  canvas.width = CELL_W * 2;
  canvas.height = CELL_H * 2;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    gl = null;
    programs = {};
    cancelAnimationFrame(frame);
    frame = 0;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    canvas = null;
    schedule();
  });
  const ctx = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!ctx) {
    failed = true;
    return false;
  }
  const buf = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
  ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), ctx.STATIC_DRAW);
  ctx.enableVertexAttribArray(0);
  ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);
  gl = ctx;
  return true;
}

function programFor(skin: AnimatedSkinId): ProgramInfo | null {
  if (!gl) return null;
  if (!programs[skin]) {
    try {
      programs[skin] = buildProgram(gl, SOURCES[skin]);
    } catch (err) {
      console.error(`skin shader ${skin}:`, err);
      failed = true;
      return null;
    }
  }
  return programs[skin]!;
}

function render(time: number) {
  if (!ensureGl() || !gl || !canvas) return;
  for (const { skin, face, set } of targets.values()) {
    if (set.size === 0) continue;
    const info = programFor(skin);
    if (!info) return;
    gl.useProgram(info.program);
    gl.uniform1f(info.uTime, time);
    gl.uniform1f(info.uFace, face ? 1 : 0);
    const used = new Set([...set].map((t) => t.variant));
    for (const v of used) {
      // Row 0 is the top of the 2D image; GL's viewport origin is bottom-left.
      gl.viewport((v % 2) * CELL_W, (1 - Math.floor(v / 2)) * CELL_H, CELL_W, CELL_H);
      gl.uniform1f(info.uSeed, v * 1.618 + 0.37);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // Blit in the same task as the draw; the drawing buffer clears after compositing.
    for (const t of set) {
      t.ctx.drawImage(canvas, (t.variant % 2) * CELL_W, Math.floor(t.variant / 2) * CELL_H, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
    }
  }
}

function tick(now: number) {
  frame = 0;
  if (document.hidden || targets.size === 0) return;
  render((now - start) / 1000);
  if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(tick);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) schedule();
});
reducedMotion.addEventListener("change", schedule);

/**
 * Feeds `target` the skin's animation until the returned cleanup runs.
 * False return = WebGL unavailable; caller keeps its CSS fallback.
 */
export function subscribe(
  target: HTMLCanvasElement,
  skin: AnimatedSkinId,
  seed: number,
  face = false,
): (() => void) | false {
  if (!ensureGl()) return false;
  const ctx = target.getContext("2d");
  if (!ctx) return false;
  target.width = CELL_W;
  target.height = CELL_H;
  const entry: Target = { ctx, variant: ((seed % VARIANTS) + VARIANTS) % VARIANTS };
  const key = `${skin}|${face}`;
  let group = targets.get(key);
  if (!group) targets.set(key, (group = { skin, face, set: new Set() }));
  const { set } = group;
  set.add(entry);
  // Reduced motion draws one still frame per new card; otherwise the loop picks it up.
  if (reducedMotion.matches) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  schedule();
  return () => {
    set.delete(entry);
    if (set.size === 0) targets.delete(key);
  };
}

export function isAnimatedSkin(skin: string): skin is AnimatedSkinId {
  return skin in SOURCES;
}
