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

// Sample a 9-tap Gaussian centered on vUV with given radius (in pixels).
vec3 gauss9(float r) {
  // Weights for sigma ~ r/2 (Pascal-derived approximation).
  const float w0 = 0.2270270270;
  const float w1 = 0.1945945946;
  const float w2 = 0.1216216216;
  const float w3 = 0.0540540541;
  const float w4 = 0.0162162162;

  vec3 c = texture2D(uTex, vUV).rgb * w0;
  vec2 dx = vec2(uTexel.x * r, 0.0);
  vec2 dy = vec2(0.0, uTexel.y * r);

  c += texture2D(uTex, vUV + dx).rgb * w1;
  c += texture2D(uTex, vUV - dx).rgb * w1;
  c += texture2D(uTex, vUV + dy).rgb * w1;
  c += texture2D(uTex, vUV - dy).rgb * w1;

  c += texture2D(uTex, vUV + dx * 2.0).rgb * w2;
  c += texture2D(uTex, vUV - dx * 2.0).rgb * w2;
  c += texture2D(uTex, vUV + dy * 2.0).rgb * w2;
  c += texture2D(uTex, vUV - dy * 2.0).rgb * w2;

  c += texture2D(uTex, vUV + (dx + dy) * 1.5).rgb * w3;
  c += texture2D(uTex, vUV + (dx - dy) * 1.5).rgb * w3;
  c += texture2D(uTex, vUV - (dx + dy) * 1.5).rgb * w3;
  c += texture2D(uTex, vUV - (dx - dy) * 1.5).rgb * w3;

  c += texture2D(uTex, vUV + dx * 4.0).rgb * w4;
  c += texture2D(uTex, vUV - dx * 4.0).rgb * w4;
  c += texture2D(uTex, vUV + dy * 4.0).rgb * w4;
  c += texture2D(uTex, vUV - dy * 4.0).rgb * w4;

  return c;
}

void main() {
  vec3 src = texture2D(uTex, vUV).rgb;

  // Sharpness: small radius (~1.5px), high-frequency edges only.
  if (uSharpness > 0.001) {
    vec3 blurredSmall = gauss9(1.5);
    vec3 detail = src - blurredSmall;
    src += detail * uSharpness * 1.5;
  }

  // Definition (Clarity): large radius (~10px), low-amplitude midtone contrast.
  if (abs(uDefinition) > 0.001) {
    vec3 blurredLarge = gauss9(10.0);
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
