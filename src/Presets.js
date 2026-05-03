// Programmatically generated LUT presets.
//
// Each preset is a 16-level Hald CLUT stored as a 64×64 canvas (4×4 tile grid).
// No external files needed — transforms are pure math on (r,g,b) ∈ [0,1].
//
// The GLSL sampler interprets the canvas as:
//   tile (tx, ty)  →  b_index = tx + ty*4  (0..15)
//   pixel (px, py) within tile  →  r = px/15, g = py/15

const SIZE = 16;
const TILES_PER_ROW = 4;

// ---------- helpers ----------
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const luma  = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const desaturate = (r, g, b, amt) => {
  const L = luma(r, g, b);
  return [lerp(r, L, amt), lerp(g, L, amt), lerp(b, L, amt)];
};
// Pivoted S-curve contrast (pivot at 0.5)
const sCurve = (v, s) => {
  const x = v - 0.5;
  return clamp(x * (1 + s * (1 - 2 * Math.abs(x))) + 0.5);
};

// ---------- transforms ----------
// Each receives (r, g, b) ∈ [0,1] sRGB and returns [r, g, b] ∈ [0,1].

const identity = (r, g, b) => [r, g, b];

const cinematic = (r, g, b) => {
  // Teal shadows, orange highlights — classic Hollywood split-tone.
  const L = luma(r, g, b);
  const sh = smoothstep(0.45, 0.0, L);   // shadow zone
  const hi = smoothstep(0.55, 1.0, L);   // highlight zone
  let ro = r - sh * 0.12 + hi * 0.10;
  let go = g + sh * 0.02 - hi * 0.03;
  let bo = b + sh * 0.10 - hi * 0.12;
  [ro, go, bo] = desaturate(ro, go, bo, 0.08);
  return [ro, go, bo].map(v => clamp(v));
};

const fadedFilm = (r, g, b) => {
  // Lifted blacks, slight warm cast, reduced saturation.
  let ro = r * 0.88 + 0.07;
  let go = g * 0.86 + 0.07;
  let bo = b * 0.83 + 0.06;
  ro = clamp(ro + 0.015);
  bo = clamp(bo - 0.015);
  [ro, go, bo] = desaturate(ro, go, bo, 0.22);
  return [ro, go, bo].map(v => clamp(v));
};

const noir = (r, g, b) => {
  // Near-monochrome with punchy contrast.
  const L = luma(r, g, b);
  const c = sCurve(L, 0.45);
  // Retain a sliver of warm tone in highlights.
  const hi = smoothstep(0.65, 1.0, L);
  return [clamp(c + hi * 0.04), clamp(c - hi * 0.01), clamp(c - hi * 0.03)];
};

const goldenHour = (r, g, b) => {
  // Warm, sun-drenched with glowing highlights.
  let ro = clamp(r * 1.07 + 0.02);
  let go = clamp(g * 1.01);
  let bo = clamp(b * 0.78 - 0.03);
  // Slight saturation boost.
  const L = luma(ro, go, bo);
  ro = clamp(lerp(ro, L, -0.12));
  go = clamp(lerp(go, L, -0.08));
  bo = clamp(lerp(bo, L, -0.12));
  return [ro, go, bo];
};

const coolBreeze = (r, g, b) => {
  // Cool blue shadows, neutral highlights.
  const L = luma(r, g, b);
  const sh = smoothstep(0.5, 0.0, L);
  let ro = clamp(r - sh * 0.10);
  let go = clamp(g - sh * 0.02);
  let bo = clamp(b + sh * 0.13);
  return [ro, go, bo];
};

const muted = (r, g, b) => {
  // Heavy lift, strong desaturation — modern matte look.
  let ro = r * 0.72 + 0.12;
  let go = g * 0.72 + 0.12;
  let bo = b * 0.72 + 0.12;
  [ro, go, bo] = desaturate(ro, go, bo, 0.45);
  return [ro, go, bo].map(v => clamp(v));
};

const vivid = (r, g, b) => {
  // Punchy S-curve + boosted saturation.
  let ro = sCurve(r, 0.3);
  let go = sCurve(g, 0.3);
  let bo = sCurve(b, 0.3);
  const L = luma(ro, go, bo);
  ro = clamp(lerp(ro, L, -0.25));
  go = clamp(lerp(go, L, -0.20));
  bo = clamp(lerp(bo, L, -0.25));
  return [ro, go, bo];
};

const fujiesque = (r, g, b) => {
  // Pastel skin tones, slightly cyan highlights, lifted blacks.
  let ro = r * 0.94 + 0.03;
  let go = g * 0.97 + 0.02;
  let bo = b * 1.03 + 0.01;
  const L = luma(ro, go, bo);
  const hi = smoothstep(0.55, 1.0, L);
  go = clamp(go + hi * 0.03);
  bo = clamp(bo + hi * 0.04);
  [ro, go, bo] = desaturate(ro, go, bo, 0.12);
  return [ro, go, bo].map(v => clamp(v));
};

// ---------- generator ----------
/**
 * Bake a transform function into a 64×64 HTMLCanvasElement LUT.
 * @param {(r:number, g:number, b:number) => [number,number,number]} fn
 * @returns {HTMLCanvasElement}
 */
function bakeToCanvas(fn) {
  const imgSize = SIZE * TILES_PER_ROW; // 64
  const cv = document.createElement('canvas');
  cv.width = imgSize;
  cv.height = imgSize;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(imgSize, imgSize);
  const px = id.data;

  for (let b_i = 0; b_i < SIZE; b_i++) {
    const tileCol = b_i % TILES_PER_ROW;
    const tileRow = Math.floor(b_i / TILES_PER_ROW);
    const b = b_i / (SIZE - 1);

    for (let g_i = 0; g_i < SIZE; g_i++) {
      const g = g_i / (SIZE - 1);
      for (let r_i = 0; r_i < SIZE; r_i++) {
        const r = r_i / (SIZE - 1);
        const [ro, go, bo] = fn(r, g, b);
        const cx = tileCol * SIZE + r_i;
        const cy = tileRow * SIZE + g_i;
        const idx = (cy * imgSize + cx) * 4;
        px[idx]     = Math.round(clamp(ro) * 255);
        px[idx + 1] = Math.round(clamp(go) * 255);
        px[idx + 2] = Math.round(clamp(bo) * 255);
        px[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(id, 0, 0);
  return cv;
}

// ---------- exports ----------
export const PRESETS = [
  { id: 'none',       label: 'None',        transform: null },
  { id: 'cinematic',  label: 'Cinematic',   transform: cinematic },
  { id: 'faded',      label: 'Faded Film',  transform: fadedFilm },
  { id: 'noir',       label: 'Noir',        transform: noir },
  { id: 'golden',     label: 'Golden Hour', transform: goldenHour },
  { id: 'cool',       label: 'Cool Breeze', transform: coolBreeze },
  { id: 'muted',      label: 'Muted',       transform: muted },
  { id: 'vivid',      label: 'Vivid',       transform: vivid },
  { id: 'fuji',       label: 'Fujiesque',   transform: fujiesque },
];

// Lazily bake canvases (generated on first call, cached after).
const _cache = new Map();
export function getPresetLUT(id) {
  if (id === 'none') return null;
  if (_cache.has(id)) return _cache.get(id);
  const preset = PRESETS.find(p => p.id === id);
  if (!preset || !preset.transform) return null;
  const canvas = bakeToCanvas(preset.transform);
  const lut = { image: canvas, size: SIZE, tilesPerRow: TILES_PER_ROW };
  _cache.set(id, lut);
  return lut;
}
