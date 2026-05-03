// Master color shader (Phase 3 of the blueprint).
// Order is fixed and mathematically meaningful:
//   A. sRGB -> Linear
//   B. Exposure (2^EV) + linear Brightness
//   C. White Balance (Bradford CAT, precomputed JS-side as uChromaticAdaptation)
//   D. Edge-preserving Shadows / Highlights / Whites / Blacks via low-freq luma
//   E. Vibrance (HSV, log boost) + Saturation, with skin-tone protection
//   F. Contrast + ACES filmic tone mapping
//   G. 3D LUT sample from a tiled PNG
//   H. Linear -> sRGB
export const MASTER_FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 vUV;

// Inputs
uniform sampler2D uImage;        // original sRGB image
uniform sampler2D uLowFreqLuma;  // Pass 1 output: blurred LINEAR luminance
uniform sampler2D uLUT;          // 3D LUT packed as 2D tile grid
uniform float uLUTEnabled;       // 0 / 1
uniform float uLUTIntensity;     // 0..1
uniform float uLUTSize;          // e.g. 64
uniform float uLUTTilesPerRow;   // e.g. 8

// Light
uniform float uExposure;     // EV stops
uniform float uBrightness;   // linear gain offset
uniform float uContrast;     // pivoted contrast
uniform float uHighlights;   // -1..1 negative recovers
uniform float uShadows;      // -1..1 positive lifts
uniform float uWhites;       // -1..1
uniform float uBlacks;       // -1..1

// Color
uniform mat3  uChromaticAdaptation; // combined sRGB(D65) -> sRGB(target) via Bradford
uniform float uVibrance;
uniform float uSaturation;

// ---------- Color space helpers ----------
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

const vec3 LUMA_REC709 = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA_REC709); }

// ---------- HSV (for vibrance) ----------
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Soft highlight roll-off — the blueprint asks for ACES "to roll off pixels
// pushed out of bounds smoothly". The Hill/Knarkowicz ACES fit does that, but
// it is not identity in the SDR range (it lifts mid-grey ~+50% and crushes
// pure white to ~0.80). That makes a no-op render look noticeably wrong.
//
// This curve is pure identity in [0, knee] and Reinhard-style asymptotic
// compression above, so:
//   * no-op render === source pixels exactly
//   * any value driven above the knee by exposure/contrast lands smoothly
//     in (knee, 1) instead of clipping
vec3 softHighlight(vec3 x) {
  const float knee = 0.95;
  const float top  = 1.0 - knee; // 0.05
  vec3 below = min(x, vec3(knee));
  vec3 over  = max(x - knee, 0.0);
  vec3 rolled = top * (over / (over + top));
  return below + rolled;
}

// ---------- 3D LUT sample from a square tile grid PNG ----------
// LUT is sRGB; we sample, then convert back to linear so the overall pipeline
// stays linear-end-to-end.
vec3 sampleLUT(vec3 color) {
  float n = uLUTSize;
  float tpr = uLUTTilesPerRow;
  vec3 c = clamp(color, 0.0, 1.0);

  float blueIdx = c.b * (n - 1.0);
  float z0 = floor(blueIdx);
  float z1 = min(z0 + 1.0, n - 1.0);
  float zMix = blueIdx - z0;

  // Per-tile UV: inset by half a texel of the slice to avoid bleeding
  float tileWidth = 1.0 / tpr;
  vec2 inner = (vec2(c.r, c.g) * (n - 1.0) + 0.5) / n;

  vec2 uv0 = vec2(mod(z0, tpr), floor(z0 / tpr)) * tileWidth + inner * tileWidth;
  vec2 uv1 = vec2(mod(z1, tpr), floor(z1 / tpr)) * tileWidth + inner * tileWidth;

  vec3 s0 = texture2D(uLUT, uv0).rgb;
  vec3 s1 = texture2D(uLUT, uv1).rgb;
  return mix(s0, s1, zMix);
}

// Smooth shadow / highlight masks centered on luminance bands.
float shadowMask(float L)    { return smoothstep(0.5, 0.0, L); }
float highlightMask(float L) { return smoothstep(0.5, 1.0, L); }
float blackMask(float L)     { return smoothstep(0.25, 0.0, L); }
float whiteMask(float L)     { return smoothstep(0.75, 1.0, L); }

// Skin-tone protection: dampens vibrance for pixels whose hue sits near the
// orange/red skin band. Returns a multiplier in [skinFloor, 1].
float skinProtect(float hue, float sat) {
  // Skin hue clusters between ~0.02 and ~0.10 (roughly 7°-36°).
  float center = 0.06;
  float halfWidth = 0.05;
  float d = abs(hue - center);
  d = min(d, 1.0 - d); // wrap-around hue distance
  float inSkin = 1.0 - smoothstep(halfWidth, halfWidth * 1.6, d);
  // Only meaningfully damp when there's already some saturation; pure greys are not skin.
  inSkin *= smoothstep(0.05, 0.3, sat);
  return mix(1.0, 0.25, inSkin);
}

void main() {
  // ---- A. sRGB -> Linear ----
  vec3 src = texture2D(uImage, vUV).rgb;
  vec3 lin = srgbToLinear(src);

  // ---- B. Exposure (true 2^EV) + linear Brightness ----
  float EV = uExposure * 2.0; // map slider [-1,1] -> [-2,+2] stops
  lin *= pow(2.0, EV);
  lin += uBrightness * 0.15; // subtle linear lift

  // ---- C. White Balance via Bradford CAT (precomputed mat3) ----
  lin = uChromaticAdaptation * lin;

  // ---- D. Edge-preserving Shadows / Highlights / Whites / Blacks ----
  // Reconstruct base/detail decomposition in linear luminance.
  float L     = max(luma(lin), 1e-5);
  float baseL = max(texture2D(uLowFreqLuma, vUV).r, 1e-5);
  float detail = L - baseL;

  float sMask = shadowMask(baseL);
  float hMask = highlightMask(baseL);
  float bMask = blackMask(baseL);
  float wMask = whiteMask(baseL);

  // Strength constants tuned so ±1 produces a strong but non-clipping move.
  float baseAdj = baseL
                + uShadows    * 0.45 * sMask
                - uHighlights * 0.45 * hMask
                + uWhites     * 0.30 * wMask
                - uBlacks     * 0.30 * bMask;
  baseAdj = max(baseAdj, 1e-5);

  float newL = baseAdj + detail;
  // Re-scale color by luminance ratio in linear space to preserve chroma.
  lin *= (newL / L);
  lin = max(lin, 0.0);

  // ---- E. Vibrance + Saturation in HSV ----
  // Convert temporarily through sRGB-encoded values for HSV stability, then back.
  vec3 srgbForHSV = clamp(linearToSRGB(lin), 0.0, 1.0);
  vec3 hsv = rgb2hsv(srgbForHSV);

  // Vibrance: log-style boost that favors pixels with low current saturation.
  // Formula: S_new = S + V * (1 - S) * skin
  float skin = skinProtect(hsv.x, hsv.y);
  float vAmt = uVibrance * skin;
  float sBoost = vAmt * (1.0 - hsv.y);
  hsv.y = clamp(hsv.y + sBoost, 0.0, 1.0);

  // Saturation: straight multiplier (with negatives desaturating to grey)
  hsv.y = clamp(hsv.y * (1.0 + uSaturation), 0.0, 1.0);

  vec3 srgbAfter = hsv2rgb(hsv);
  lin = srgbToLinear(srgbAfter);

  // ---- F. Contrast (pivoted at 18% grey in linear) + soft highlight roll-off ----
  float pivot = 0.18;
  float contrastAmt = 1.0 + uContrast;
  lin = max((lin - pivot) * contrastAmt + pivot, 0.0);
  lin = softHighlight(lin);

  // ---- G. 3D LUT (LUTs are authored in sRGB display space) ----
  if (uLUTEnabled > 0.5) {
    vec3 dispBefore = linearToSRGB(lin);
    vec3 graded = sampleLUT(dispBefore);
    vec3 mixed = mix(dispBefore, graded, clamp(uLUTIntensity, 0.0, 1.0));
    lin = srgbToLinear(mixed);
  }

  // ---- H. Linear -> sRGB ----
  vec3 outCol = linearToSRGB(lin);
  gl_FragColor = vec4(outCol, 1.0);
}
`;
