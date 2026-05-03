// Multi-pass FBO pipeline (Phase 2 of the blueprint).
//
// Pass 1: Build a low-frequency LINEAR LUMINANCE map of the source image.
//         Uses two passes (horizontal + vertical) of a separable Gaussian blur,
//         with a luminance-extracting variant on the first pass.
// Pass 2: The Master color shader. Reads the source + low-freq map and the
//         optional 3D LUT, performs the entire color pipeline, writes to FBO B.
// Pass 3: The Spatial shader. Reads FBO B and applies Sharpness + Definition,
//         writing to the destination framebuffer (display canvas or export FBO).

import {
  createGL, createProgram, createFullScreenQuad, bindQuad, createFBO,
  uploadImageTexture,
} from './WebGLContext.js';
import { VERTEX_SHADER } from './shaders/vertex.js';
import { BLUR_FRAGMENT, LUMINANCE_BLUR_FRAGMENT } from './shaders/blur.js';
import { MASTER_FRAGMENT } from './shaders/master.js';
import { SPATIAL_FRAGMENT } from './shaders/spatial.js';
import { DOWNSAMPLE_FRAGMENT } from './shaders/downsample.js';
import { buildChromaticAdaptationMatrix, IDENTITY_CAT } from './WhiteBalance.js';

export class Pipeline {
  constructor(canvas, { preserveDrawingBuffer = false } = {}) {
    this.canvas = canvas;
    this.gl = createGL(canvas, { preserveDrawingBuffer });

    const gl = this.gl;
    this.quad = createFullScreenQuad(gl);

    this.lumBlurProg    = createProgram(gl, VERTEX_SHADER, LUMINANCE_BLUR_FRAGMENT);
    this.blurProg       = createProgram(gl, VERTEX_SHADER, BLUR_FRAGMENT);
    this.masterProg     = createProgram(gl, VERTEX_SHADER, MASTER_FRAGMENT);
    this.spatialProg    = createProgram(gl, VERTEX_SHADER, SPATIAL_FRAGMENT);
    this.downsampleProg = createProgram(gl, VERTEX_SHADER, DOWNSAMPLE_FRAGMENT);

    // Lazily allocated when an image is bound. `image.fbo` is set when the
    // image was produced by the GPU downsample pass (in which case both fbo
    // and texture must be released on replacement).
    this.image = null;       // { texture, width, height, fbo? }
    this.fboLuma = null;     // ping-pong target A (luminance blurred)
    this.fboLumaTmp = null;  // ping-pong target for the horizontal pass
    this.fboMaster = null;   // master shader output
    this.targetW = 0;
    this.targetH = 0;

    // LUT
    this.lut = null; // { texture, size, tilesPerRow }
  }

  /** Resize internal FBOs to a target processing resolution (px). */
  _ensureFBOs(w, h) {
    if (this.targetW === w && this.targetH === h && this.fboMaster) return;
    const gl = this.gl;
    if (this.fboLuma)    { gl.deleteFramebuffer(this.fboLuma.fbo);    gl.deleteTexture(this.fboLuma.texture); }
    if (this.fboLumaTmp) { gl.deleteFramebuffer(this.fboLumaTmp.fbo); gl.deleteTexture(this.fboLumaTmp.texture); }
    if (this.fboMaster)  { gl.deleteFramebuffer(this.fboMaster.fbo);  gl.deleteTexture(this.fboMaster.texture); }
    this.fboLuma    = createFBO(gl, w, h, { float: true });
    this.fboLumaTmp = createFBO(gl, w, h, { float: true });
    this.fboMaster  = createFBO(gl, w, h, { float: true });
    this.targetW = w;
    this.targetH = h;
  }

  /**
   * Bind a source image (HTMLImageElement / ImageBitmap / HTMLCanvasElement).
   *
   * @param {object} [opts]
   * @param {number} [opts.maxEdge] - if set and the image's longest edge is
   *   greater than this, run a gamma-correct GPU downsample pass to a proxy
   *   FBO of that size and use it as the working texture. Skipping the 2D
   *   canvas drawImage step preserves saturation (drawImage averages in
   *   sRGB-encoded space, which desaturates the result).
   */
  setImage(image, opts = {}) {
    const gl = this.gl;
    this._releaseImage();

    const srcW = image.naturalWidth || image.width;
    const srcH = image.naturalHeight || image.height;
    const maxEdge = opts.maxEdge;

    let dstW = srcW, dstH = srcH;
    if (maxEdge && Math.max(srcW, srcH) > maxEdge) {
      const scale = maxEdge / Math.max(srcW, srcH);
      dstW = Math.max(1, Math.round(srcW * scale));
      dstH = Math.max(1, Math.round(srcH * scale));
    }

    if (dstW === srcW && dstH === srcH) {
      // No downsampling needed (export path / small images): direct upload.
      this.image = uploadImageTexture(gl, image);
    } else {
      // Upload at full res to a temporary texture, then GPU-downsample into
      // a proxy-sized FBO. NEAREST filtering on the source is critical: with
      // LINEAR, every texture2D() tap inside the downsample shader would be
      // a bilinear average of 4 sRGB-encoded texels (gamma-incorrect) BEFORE
      // we get a chance to convert to linear. NEAREST + per-tap UV snapping
      // ensures every tap reads a single source texel verbatim.
      const tempTex = uploadImageTexture(gl, image);
      gl.bindTexture(gl.TEXTURE_2D, tempTex.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      const proxyFBO = createFBO(gl, dstW, dstH);

      gl.bindFramebuffer(gl.FRAMEBUFFER, proxyFBO.fbo);
      gl.viewport(0, 0, dstW, dstH);
      gl.useProgram(this.downsampleProg.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tempTex.texture);
      gl.uniform1i(this.downsampleProg.uniforms.uTex, 0);
      gl.uniform2f(this.downsampleProg.uniforms.uSrcTexel, 1 / srcW, 1 / srcH);
      gl.uniform2f(this.downsampleProg.uniforms.uSrcSize, srcW, srcH);
      gl.uniform1f(this.downsampleProg.uniforms.uDownscale, srcW / dstW);
      this._drawQuad(this.downsampleProg);

      gl.deleteTexture(tempTex.texture);

      this.image = {
        texture: proxyFBO.texture,
        width: dstW,
        height: dstH,
        fbo: proxyFBO.fbo,
      };
    }

    this._ensureFBOs(this.image.width, this.image.height);
    this._lumaDirty = true;
  }

  _releaseImage() {
    const gl = this.gl;
    if (!this.image) return;
    if (this.image.fbo) gl.deleteFramebuffer(this.image.fbo);
    gl.deleteTexture(this.image.texture);
    this.image = null;
  }

  /** Bind a LUT object returned by loadLUT(). Pass null to clear. */
  setLUT(lut) {
    const gl = this.gl;
    if (this.lut) gl.deleteTexture(this.lut.texture);
    if (!lut) { this.lut = null; this._lutSourceImage = null; return; }
    this._lutSourceImage = lut.image; // retain so other pipelines can reuse
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lut.image);
    this.lut = { texture: tex, size: lut.size, tilesPerRow: lut.tilesPerRow, image: lut.image };
  }

  _drawQuad(prog) {
    const gl = this.gl;
    bindQuad(gl, this.quad, prog.attribs);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Pass 1: build low-frequency luma map. Only re-runs when source image changes.
  _runLuminancePass() {
    if (!this._lumaDirty) return;
    const gl = this.gl;
    const w = this.targetW, h = this.targetH;

    // The blur radius scales with image size so the "low frequency" carries
    // the same intent regardless of resolution. ~3% of the long edge.
    const radius = Math.max(8, Math.round(Math.max(w, h) * 0.03));

    // Horizontal pass: source -> fboLumaTmp (writes luma in R channel).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboLumaTmp.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.lumBlurProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.image.texture);
    gl.uniform1i(this.lumBlurProg.uniforms.uTex, 0);
    gl.uniform2f(this.lumBlurProg.uniforms.uTexel, 1 / w, 1 / h);
    gl.uniform2f(this.lumBlurProg.uniforms.uDirection, 1, 0);
    gl.uniform1f(this.lumBlurProg.uniforms.uRadius, radius);
    this._drawQuad(this.lumBlurProg);

    // Vertical pass: fboLumaTmp -> fboLuma (regular blur on already-luma data).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboLuma.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blurProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboLumaTmp.texture);
    gl.uniform1i(this.blurProg.uniforms.uTex, 0);
    gl.uniform2f(this.blurProg.uniforms.uTexel, 1 / w, 1 / h);
    gl.uniform2f(this.blurProg.uniforms.uDirection, 0, 1);
    gl.uniform1f(this.blurProg.uniforms.uRadius, radius);
    this._drawQuad(this.blurProg);

    this._lumaDirty = false;
  }

  // Pass 2: master color shader.
  _runMasterPass(state) {
    const gl = this.gl;
    const w = this.targetW, h = this.targetH;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMaster.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.masterProg.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.image.texture);
    gl.uniform1i(this.masterProg.uniforms.uImage, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboLuma.texture);
    gl.uniform1i(this.masterProg.uniforms.uLowFreqLuma, 1);

    // LUT is optional. Bind a dummy if missing to keep the sampler valid.
    if (this.lut && state.lutEnabled) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.lut.texture);
      gl.uniform1i(this.masterProg.uniforms.uLUT, 2);
      gl.uniform1f(this.masterProg.uniforms.uLUTEnabled, 1);
      gl.uniform1f(this.masterProg.uniforms.uLUTIntensity, state.lutIntensity);
      gl.uniform1f(this.masterProg.uniforms.uLUTSize, this.lut.size);
      gl.uniform1f(this.masterProg.uniforms.uLUTTilesPerRow, this.lut.tilesPerRow);
    } else {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.image.texture); // dummy bind
      gl.uniform1i(this.masterProg.uniforms.uLUT, 2);
      gl.uniform1f(this.masterProg.uniforms.uLUTEnabled, 0);
      gl.uniform1f(this.masterProg.uniforms.uLUTIntensity, 0);
      gl.uniform1f(this.masterProg.uniforms.uLUTSize, 64);
      gl.uniform1f(this.masterProg.uniforms.uLUTTilesPerRow, 8);
    }

    // Light
    gl.uniform1f(this.masterProg.uniforms.uExposure,   state.exposure);
    gl.uniform1f(this.masterProg.uniforms.uBrightness, state.brightness);
    gl.uniform1f(this.masterProg.uniforms.uContrast,   state.contrast);
    gl.uniform1f(this.masterProg.uniforms.uHighlights, state.highlights);
    gl.uniform1f(this.masterProg.uniforms.uShadows,    state.shadows);
    gl.uniform1f(this.masterProg.uniforms.uWhites,     state.whites);
    gl.uniform1f(this.masterProg.uniforms.uBlacks,     state.blacks);

    // Color
    const cat = (state.temperature === 0 && state.tint === 0)
      ? IDENTITY_CAT
      : buildChromaticAdaptationMatrix(state.temperature, state.tint);
    gl.uniformMatrix3fv(this.masterProg.uniforms.uChromaticAdaptation, false, cat);
    gl.uniform1f(this.masterProg.uniforms.uVibrance,   state.vibrance);
    gl.uniform1f(this.masterProg.uniforms.uSaturation, state.saturation);

    this._drawQuad(this.masterProg);
  }

  // Pass 3: spatial detail shader; writes to the bound destination.
  _runSpatialPass(state, destWidth, destHeight, destFBO = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO);
    gl.viewport(0, 0, destWidth, destHeight);
    gl.useProgram(this.spatialProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboMaster.texture);
    gl.uniform1i(this.spatialProg.uniforms.uTex, 0);
    gl.uniform2f(this.spatialProg.uniforms.uTexel, 1 / this.targetW, 1 / this.targetH);
    gl.uniform1f(this.spatialProg.uniforms.uSharpness, state.sharpness);
    gl.uniform1f(this.spatialProg.uniforms.uDefinition, state.definition);
    this._drawQuad(this.spatialProg);
  }

  /** Run all three passes and present to the canvas. */
  render(state) {
    if (!this.image) return;
    this._runLuminancePass();
    this._runMasterPass(state);
    this._runSpatialPass(state, this.canvas.width, this.canvas.height, null);
  }

  /** Read back the current canvas pixels (after render) as a Blob. */
  async toBlob(mime = 'image/jpeg', quality = 0.95) {
    return new Promise((resolve) => this.canvas.toBlob(resolve, mime, quality));
  }

  dispose() {
    const gl = this.gl;
    this._releaseImage();
    if (this.lut) gl.deleteTexture(this.lut.texture);
    for (const fbo of [this.fboLuma, this.fboLumaTmp, this.fboMaster]) {
      if (fbo) { gl.deleteFramebuffer(fbo.fbo); gl.deleteTexture(fbo.texture); }
    }
    for (const p of [this.lumBlurProg, this.blurProg, this.masterProg,
                     this.spatialProg, this.downsampleProg]) {
      if (p) gl.deleteProgram(p.program);
    }
    gl.deleteBuffer(this.quad);
  }
}
