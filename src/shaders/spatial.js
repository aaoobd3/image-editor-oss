// Phase 4: Spatial detail shader.
// One pass that performs both Sharpness (small-radius Unsharp Mask) and
// Definition (large-radius, low-amplitude Local Contrast Enhancement).
// Inputs:
//   uTex                : Master shader output (sRGB display).
//   uTexel              : 1 / textureSize.
//   uSharpness          : 0..1
//   uDefinition         : -1..1
export const SPATIAL_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSharpness;
uniform float uDefinition;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// 13-tap 2D Gaussian approximation, normalized to sum=1.
// Uses sigma = r (in pixels), so the weights are:
//   center      :  1.0
//   cardinal @r :  exp(-0.5)   (4 taps)
//   diagonal @r :  exp(-0.5)   (4 taps; offset r/sqrt(2) on each axis)
//   cardinal @2r:  exp(-2.0)   (4 taps)
// All taps within ~2 sigma of center, which gives a smooth, brightness-
// preserving low-pass for the unsharp mask base.
vec3 gaussBlur(float r) {
  const float W1 = 0.60653066;  // exp(-0.5)  — 1 sigma
  const float W2 = 0.13533528;  // exp(-2.0)  — 2 sigma
  const float WSUM = 1.0 + 8.0 * W1 + 4.0 * W2;

  vec2 px = uTexel * r;
  vec2 pxDiag = px * 0.70710678; // r / sqrt(2)

  vec3 c = texture2D(uTex, vUV).rgb;

  c += (texture2D(uTex, vUV + vec2( px.x, 0.0)).rgb +
        texture2D(uTex, vUV - vec2( px.x, 0.0)).rgb +
        texture2D(uTex, vUV + vec2(0.0,  px.y)).rgb +
        texture2D(uTex, vUV - vec2(0.0,  px.y)).rgb) * W1;

  c += (texture2D(uTex, vUV + vec2( pxDiag.x,  pxDiag.y)).rgb +
        texture2D(uTex, vUV + vec2(-pxDiag.x,  pxDiag.y)).rgb +
        texture2D(uTex, vUV + vec2( pxDiag.x, -pxDiag.y)).rgb +
        texture2D(uTex, vUV - vec2( pxDiag.x,  pxDiag.y)).rgb) * W1;

  c += (texture2D(uTex, vUV + vec2(2.0 * px.x, 0.0)).rgb +
        texture2D(uTex, vUV - vec2(2.0 * px.x, 0.0)).rgb +
        texture2D(uTex, vUV + vec2(0.0, 2.0 * px.y)).rgb +
        texture2D(uTex, vUV - vec2(0.0, 2.0 * px.y)).rgb) * W2;

  return c / WSUM;
}

void main() {
  vec3 src = texture2D(uTex, vUV).rgb;

  // Sharpness: small radius (~1.2px), high-frequency edges only.
  if (uSharpness > 0.001) {
    vec3 blurredSmall = gaussBlur(1.2);
    vec3 detail = src - blurredSmall;
    src += detail * uSharpness * 1.5;
  }

  // Definition (Clarity): large radius (~8px), low-amplitude midtone contrast.
  if (abs(uDefinition) > 0.001) {
    vec3 blurredLarge = gaussBlur(8.0);
    vec3 lowFreqDetail = src - blurredLarge;
    // Mid-tone protection: damp effect on shadows and specular highlights.
    float L = luma(src);
    float midMask = 1.0 - smoothstep(0.0, 0.15, abs(L - 0.5) - 0.20);
    midMask = clamp(midMask, 0.4, 1.0);
    src += lowFreqDetail * uDefinition * 0.6 * midMask;
  }

  gl_FragColor = vec4(clamp(src, 0.0, 1.0), 1.0);
}
`;
