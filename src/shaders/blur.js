// Separable Gaussian blur. Run once horizontally, once vertically.
// uDirection = vec2(1,0) for horizontal, vec2(0,1) for vertical.
// uTexel = 1.0 / textureSize. uRadius scales the kernel footprint.
export const BLUR_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uRadius; // in pixels along the axis

// 13-tap Gaussian using linear sampling tricks (effective ~25-tap kernel).
// Weights from a sigma ≈ uRadius / 2.5 normal distribution, evaluated for the
// pre-summed offset/weight pairs so each tap reads a bilinear-mixed sample.
void main() {
  vec3 color = vec3(0.0);
  float sigma = max(uRadius, 0.5) / 2.5;
  float twoSig2 = 2.0 * sigma * sigma;

  // Center weight
  float w0 = 1.0;
  color += texture2D(uTex, vUV).rgb * w0;
  float wsum = w0;

  // 12 symmetric pairs of taps spread out to ~3 sigma
  for (int i = 1; i <= 12; i++) {
    float fi = float(i);
    float offset = fi * (uRadius / 12.0);
    float w = exp(-(offset * offset) / twoSig2);
    vec2 d = uDirection * uTexel * offset;
    color += texture2D(uTex, vUV + d).rgb * w;
    color += texture2D(uTex, vUV - d).rgb * w;
    wsum += 2.0 * w;
  }

  gl_FragColor = vec4(color / wsum, 1.0);
}
`;

// Variant that extracts luminance only (Rec. 709) before blurring.
// Used to build the low-frequency luminance map for edge-preserving tone math.
export const LUMINANCE_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uRadius;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  float sigma = max(uRadius, 0.5) / 2.5;
  float twoSig2 = 2.0 * sigma * sigma;

  vec3 c0 = srgbToLinear(texture2D(uTex, vUV).rgb);
  float acc = luma(c0);
  float wsum = 1.0;

  for (int i = 1; i <= 12; i++) {
    float fi = float(i);
    float offset = fi * (uRadius / 12.0);
    float w = exp(-(offset * offset) / twoSig2);
    vec2 d = uDirection * uTexel * offset;
    vec3 a = srgbToLinear(texture2D(uTex, vUV + d).rgb);
    vec3 b = srgbToLinear(texture2D(uTex, vUV - d).rgb);
    acc += (luma(a) + luma(b)) * w;
    wsum += 2.0 * w;
  }

  float l = acc / wsum;
  gl_FragColor = vec4(l, l, l, 1.0);
}
`;
