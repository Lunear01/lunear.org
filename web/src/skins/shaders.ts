// GLSL ES 1.0 for the animated skins. Each draw fills one atlas cell;
// u_seed varies the pattern per cell so neighbouring cards differ.
// u_face = 1 renders the dimmed, frameless card-front variant.

export const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const COMMON = `
precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform float u_seed;
uniform float u_face;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
  float n = hash(p);
  return vec2(n, hash(p + n + 17.17));
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

vec3 fireRamp(float x) {
  x = clamp(x, 0.0, 1.0);
  return vec3(min(1.0, x * 1.9), pow(x, 1.8) * 1.15, pow(x, 4.5) * 1.1);
}

// Card space: x in [-1, 1], y in [-1.4, 1.4].
vec2 cardSpace() {
  return (v_uv - 0.5) * vec2(2.0, 2.8);
}

// Signed distance to the card's rounded-rect rim (negative inside).
float rimDist(vec2 p, float inset) {
  vec2 b = vec2(1.0, 1.4) - inset;
  vec2 q = abs(p) - b + 0.12;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.12;
}
`;

export const NEBULA = COMMON + `
vec3 stars(vec2 uv, float density, float t) {
  vec2 g = uv * density;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash(id + u_seed * 13.0);
  if (h < 0.78) return vec3(0.0);
  vec2 off = (hash2(id + 3.1) - 0.5) * 0.6;
  vec2 d = f - off;
  float twinkle = 0.55 + 0.45 * sin(t * (1.2 + h * 3.5) + h * 60.0);
  float core = smoothstep(0.09, 0.0, length(d));
  float flare = max(0.0, 1.0 - abs(d.x) * 30.0) * max(0.0, 1.0 - abs(d.y) * 4.0)
              + max(0.0, 1.0 - abs(d.y) * 30.0) * max(0.0, 1.0 - abs(d.x) * 4.0);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.7), hash(id + 9.0));
  return tint * (core + flare * 0.35 * smoothstep(0.93, 1.0, h)) * twinkle;
}

void main() {
  vec2 p = cardSpace();
  float t = u_time;

  // Domain-warped fbm: two warp passes give the curling gas filaments.
  vec2 np = p * 1.15 + u_seed * 7.31;
  float s = t * 0.07;
  vec2 q = vec2(fbm(np + vec2(0.0, s)), fbm(np + vec2(5.2, 1.3) - s));
  vec2 r = vec2(fbm(np + 3.2 * q + vec2(1.7, 9.2) + s * 1.6),
                fbm(np + 3.2 * q + vec2(8.3, 2.8) - s * 1.3));
  float f = fbm(np + 3.0 * r);

  vec3 col = vec3(0.02, 0.01, 0.06);
  col = mix(col, vec3(0.5, 0.08, 0.78), smoothstep(0.1, 0.75, f));
  col = mix(col, vec3(0.08, 0.62, 1.0), clamp(dot(q, q) * 0.8, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.38, 0.72), smoothstep(0.45, 0.95, r.x) * 0.9);
  col = mix(col, vec3(1.0, 0.92, 0.8), smoothstep(0.72, 0.95, f) * 0.7);
  col *= 0.6 + 1.7 * f * f;

  // Bright drifting core.
  vec2 cp = vec2(sin(t * 0.21 + u_seed * 4.0), cos(t * 0.17 + u_seed * 2.0)) * 0.25;
  col += vec3(0.9, 0.5, 1.0) * 0.22 / (1.0 + 12.0 * dot(p - cp, p - cp));

  col += stars(v_uv + vec2(t * 0.004, 0.0), 22.0, t) * 1.5;
  col += stars(v_uv * 1.7 + 5.0, 34.0, t * 1.3) * 0.75;

  // Central four-point emblem.
  vec2 e = abs(p);
  float diamond = e.x * 1.6 + e.y;
  float emblem = smoothstep(0.035, 0.0, abs(diamond - 0.42))
               + smoothstep(0.03, 0.0, abs(length(p) - 0.62)) * 0.55;
  float pulse = 0.6 + 0.4 * sin(t * 1.4);
  float frame = 1.0 - u_face;
  col += vec3(1.0, 0.8, 0.45) * emblem * (0.6 + 0.5 * pulse) * frame;
  col += vec3(0.8, 0.5, 1.0) * 0.12 / (0.05 + diamond * diamond) * 0.08 * pulse * frame;

  // Gold rim with a glint that orbits the card.
  float d = rimDist(p, 0.07);
  float rim = smoothstep(0.035, 0.0, abs(d));
  float a = atan(p.y, p.x * 1.4);
  float glint = pow(0.5 + 0.5 * cos(a - t * 1.3), 40.0);
  col = mix(col, vec3(0.85, 0.62, 0.25) + glint * 0.9, rim * frame);
  col += vec3(1.0, 0.85, 0.5) * glint * smoothstep(0.12, 0.0, abs(d)) * 0.35 * frame;

  float vig = smoothstep(1.9, 0.6, length(p * vec2(1.0, 0.75)));
  col *= 0.7 + 0.3 * vig;
  col *= mix(1.0, 0.42, u_face);

  gl_FragColor = vec4(pow(col, vec3(0.9)), 1.0);
}
`;

export const MOLTEN = COMMON + `
// Voronoi: x = distance to nearest seed, y = edge distance (F2 - F1).
vec2 voronoi(vec2 p, float t) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(n + g + u_seed * 5.0);
      o = 0.5 + 0.35 * sin(t * 0.35 + 6.2831 * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2 - f1);
}

void main() {
  vec2 p = cardSpace();
  float t = u_time;

  // Heat shimmer bends the whole surface.
  p += 0.012 * vec2(sin(p.y * 9.0 + t * 3.1), cos(p.x * 8.0 - t * 2.7));

  vec2 wp = p * 2.1 + vec2(fbm(p * 1.3 + t * 0.05), fbm(p * 1.3 - t * 0.04)) * 0.9;
  vec2 v = voronoi(wp, t);
  vec2 v2 = voronoi(wp * 2.3 + 4.0, t * 1.3);

  // Lava: upward-flowing noise, brighter toward the card's core.
  float flow = fbm(p * 2.6 + vec2(0.0, -t * 0.45) + u_seed);
  float flow2 = fbm(p * 5.0 + vec2(t * 0.2, -t * 0.9));
  float heat = 0.55 + 0.45 * sin(t * 1.7 + flow * 6.0);
  float core = smoothstep(1.6, 0.0, length(p * vec2(1.0, 0.8)));
  float lava = (0.45 + 0.55 * flow) * (0.65 + 0.35 * flow2) * (0.6 + 0.6 * core) * (0.75 + 0.25 * heat);

  float crack = smoothstep(0.075, 0.0, v.y);
  float fine = smoothstep(0.035, 0.0, v2.y) * 0.55;
  float glow = exp(-v.y * 14.0) * 0.55 + exp(-v2.y * 22.0) * 0.18;

  // Obsidian plates: dark, faintly glossy, lit from the cracks.
  float plate = fbm(wp * 3.0 + 2.0);
  vec3 rock = vec3(0.035, 0.03, 0.035) + vec3(0.06, 0.05, 0.06) * plate;
  rock += vec3(0.22, 0.24, 0.3) * pow(max(0.0, 1.0 - v.x * 1.6), 6.0) * 0.25;
  vec3 col = rock + fireRamp(lava * 0.8) * glow;
  col = mix(col, fireRamp(lava * 1.25 + 0.15), max(crack, fine * lava));

  // Rising embers.
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    vec2 h = hash2(vec2(fi, u_seed * 3.0 + 1.0));
    float speed = 0.18 + h.y * 0.25;
    float y = fract(h.y + t * speed) * 3.2 - 1.6;
    float x = (h.x - 0.5) * 1.8 + sin(t * (0.8 + h.x) + fi) * 0.12;
    vec2 d = (p - vec2(x, y)) * vec2(1.0, 0.6);
    float life = smoothstep(-1.6, -1.0, y) * smoothstep(1.5, 0.4, y);
    col += fireRamp(0.9 - 0.4 * h.x) * exp(-dot(d, d) * 900.0) * life * 1.6;
  }

  // Iron rim with a breathing molten inner edge.
  float d = rimDist(p, 0.06);
  float rim = smoothstep(0.05, 0.0, abs(d));
  vec3 iron = vec3(0.07, 0.05, 0.045) + vec3(0.16, 0.12, 0.09) * pow(0.5 + 0.5 * sin(p.x * 3.0 + p.y * 2.0), 4.0);
  float frame = 1.0 - u_face;
  col = mix(col, iron, rim * frame);
  float inner = smoothstep(0.05, 0.0, abs(d + 0.06));
  col += fireRamp(0.55 + 0.3 * heat) * inner * (0.18 + 0.3 * heat) * frame;

  col *= 0.75 + 0.35 * core;
  col *= mix(1.0, 0.5, u_face);
  gl_FragColor = vec4(col, 1.0);
}
`;

// Full-screen big-moment overlays. Premultiplied alpha over the table;
// u_fade is the 0..1 envelope, u_res the canvas size in pixels.
const MOMENT_HEAD = COMMON + `
uniform vec2 u_res;
uniform float u_fade;

vec2 screenSpace() {
  return (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 2.0;
}

void emit(vec3 col) {
  // Capped so the table stays readable underneath.
  float a = clamp(max(max(col.r, col.g), col.b), 0.0, 0.8) * u_fade;
  gl_FragColor = vec4(min(col, vec3(1.0)) * u_fade, a);
}
`;

export const GALAXY = MOMENT_HEAD + `
void main() {
  vec2 p = screenSpace();
  float t = u_time;
  float r = length(p);
  float a = atan(p.y, p.x);

  // Two logarithmic spiral arms, wound tighter as they spin.
  float spin = a + log(r + 0.05) * 2.6 - t * 1.4;
  float arms = pow(0.5 + 0.5 * cos(spin * 2.0), 2.5);
  float n = fbm(vec2(spin * 0.9, r * 5.0 - t * 0.6));
  float density = arms * (0.45 + 0.9 * n) * exp(-r * 1.35);
  vec3 col = mix(vec3(0.35, 0.08, 0.85), vec3(0.15, 0.85, 1.0), n) * density * 2.4;
  col += mix(vec3(1.0, 0.4, 0.8), vec3(1.0, 0.95, 0.85), exp(-r * 9.0)) * exp(-r * r * 10.0) * 1.6;

  // Stars drawn inward along the spiral.
  vec2 sp = vec2(a / 6.2831 + t * 0.05 + 0.6 / (r + 0.3), r * 3.0);
  vec2 g = sp * vec2(40.0, 14.0);
  vec2 id = floor(g);
  float h = hash(id);
  float star = step(0.9, h) * smoothstep(0.35, 0.0, length(fract(g) - 0.5));
  col += vec3(0.9, 0.9, 1.0) * star * (0.6 + 0.4 * sin(t * 5.0 + h * 40.0)) * smoothstep(1.8, 0.2, r);

  // Opening shock ring.
  float ring = smoothstep(0.05, 0.0, abs(r - t * 1.6)) * exp(-t * 1.1);
  col += vec3(0.85, 0.75, 1.0) * ring * 2.5;

  emit(col);
}
`;

export const ERUPTION = MOMENT_HEAD + `
void main() {
  vec2 p = screenSpace();
  float t = u_time;
  float y = v_uv.y;

  // Plume rises from the bottom centre and widens as it climbs.
  float rise = clamp(t * 1.1, 0.0, 1.3);
  float width = 0.2 + 0.75 * y;
  float x = abs(p.x + 0.18 * sin(y * 7.0 - t * 3.5) * y) / width;
  float body = smoothstep(1.0, 0.15, x) * smoothstep(rise, rise - 0.45, y);
  float n = fbm(vec2(p.x * 3.0, y * 4.5 - t * 3.0));
  vec3 col = fireRamp(body * (0.45 + 0.6 * n)) * 0.8;

  // Screen-edge heat glow.
  vec2 e = min(v_uv, 1.0 - v_uv);
  float edge = exp(-min(e.x * u_res.x / u_res.y, e.y) * 9.0);
  col += fireRamp(0.6 + 0.2 * sin(t * 7.0)) * edge * 0.6;

  // Ember spray.
  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    vec2 h = hash2(vec2(fi, 7.0));
    float life = fract(h.y + t * (0.35 + h.x * 0.4));
    vec2 pos = vec2((h.x - 0.5) * (0.4 + life * 2.2), -1.0 + life * 2.4 - life * life * 0.6);
    vec2 d = (p - pos) * vec2(1.0, 0.7);
    col += fireRamp(1.0 - life * 0.6) * exp(-dot(d, d) * 1800.0) * (1.0 - life) * 2.2;
  }

  emit(col);
}
`;
