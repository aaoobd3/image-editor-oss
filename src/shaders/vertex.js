// Single full-screen vertex shader reused by every pass.
export const VERTEX_SHADER = /* glsl */ `
precision highp float;
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;
