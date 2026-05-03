// Gamma-correct GPU downsample.
//
// Replaces the 2D canvas drawImage() proxy step. drawImage averages pixels in
// sRGB-encoded space, which desaturates and darkens. This shader does the
// averaging in linear space:
//
//   1. The source texture is bound with NEAREST filtering.
//   2. Each of 25 taps snaps its UV to the center of an integer source texel,
//      so texture2D() returns one source pixel verbatim — never a bilinear
//      mix of sRGB-encoded neighbors.
//   3. Each tap is converted sRGB -> linear, weighted by a Gaussian, summed.
//   4. The normalized sum is converted back to sRGB and written.
//
// Result: no part of the resampling chain ever averages in non-linear space.
export const DOWNSAMPLE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uSrcTexel;     // 1.0 / source size in pixels
uniform vec2 uSrcSize;      // source size in pixels
uniform float uDownscale;   // srcSize / dstSize (>= 1)

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Snap a UV onto the center of the nearest source texel.
vec2 snapToTexel(vec2 uv) {
  return (floor(uv * uSrcSize) + 0.5) * uSrcTexel;
}

void main() {
  // Sigma proportional to the downsample ratio so the kernel covers exactly
  // the source footprint of one destination pixel (no aliasing, no blur).
  float sigma = max(uDownscale * 0.5, 0.5);
  float twoSig2 = 2.0 * sigma * sigma;

  vec3 sum = vec3(0.0);
  float wsum = 0.0;

  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec2 offset = vec2(float(dx), float(dy)) * uDownscale * uSrcTexel;
      vec2 sampleUV = snapToTexel(vUV + offset);
      float r2 = float(dx * dx + dy * dy);
      float w = exp(-r2 / twoSig2);
      sum += srgbToLinear(texture2D(uTex, sampleUV).rgb) * w;
      wsum += w;
    }
  }

  gl_FragColor = vec4(linearToSRGB(sum / wsum), 1.0);
}
`;
