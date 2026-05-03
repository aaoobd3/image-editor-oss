// Public Editor API. Framework-agnostic.
//
// Architecture (Phase 1 — Dual Canvas):
//   * UI canvas: low-resolution proxy used by the real-time render loop, sized
//     to the viewport with a configurable max-edge cap (default 1920px).
//   * Memory buffer: the original full-resolution HTMLImageElement / Blob is
//     kept untouched.
//   * Export canvas: an off-screen canvas built lazily inside export(); it
//     reuses the exact same shader pipeline at full resolution.
//
// Render loop:
//   * One requestAnimationFrame loop that only runs the GL passes when the
//     EditorState is dirty. Sliders only update uniforms; the WebGL context
//     is never destroyed.

import { EditorState } from './EditorState.js';
import { Pipeline } from './Pipeline.js';
import { loadLUT } from './LUT.js';

const DEFAULT_MAX_PROXY_EDGE = 1920;

export class Editor {
  /**
   * @param {HTMLCanvasElement} canvas - the on-screen canvas to render into.
   * @param {object} [opts]
   * @param {number} [opts.maxProxyEdge=1920] - cap for the longest proxy edge.
   */
  constructor(canvas, opts = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Editor: first argument must be an HTMLCanvasElement.');
    }
    this.canvas = canvas;
    this.maxProxyEdge = opts.maxProxyEdge || DEFAULT_MAX_PROXY_EDGE;

    this.state = new EditorState();
    this.pipeline = new Pipeline(canvas);

    this._sourceImage = null;     // full-resolution HTMLImageElement
    this._sourceBlob = null;      // original Blob/File for downstream re-use
    this._proxyCanvas = null;     // 2D canvas holding the downscaled proxy
    this._running = false;
    this._rafHandle = 0;
    this._sliderUnbinds = [];

    // Re-render whenever state changes.
    this.state.onChange(() => this._scheduleRender());

    this._loop = this._loop.bind(this);
  }

  /**
   * Load an image from a File / Blob / URL / HTMLImageElement.
   * Builds the low-res proxy and starts the render loop.
   */
  async load(source) {
    const img = await coerceToImage(source);
    this._sourceImage = img;
    if (source instanceof Blob) this._sourceBlob = source;
    else this._sourceBlob = null;

    this._proxyCanvas = makeProxyCanvas(img, this.maxProxyEdge);
    // Match the canvas backing store to the proxy. The DOM size is left to CSS.
    this.canvas.width = this._proxyCanvas.width;
    this.canvas.height = this._proxyCanvas.height;

    this.pipeline.setImage(this._proxyCanvas);
    this.state._dirty = true;
    this.start();
    this._renderOnce();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }

  /** Apply a 3D LUT from a URL (.png tile grid). Pass null to clear. */
  async applyLUT(url) {
    if (url == null) {
      this.pipeline.setLUT(null);
      this.state.set('lutEnabled', 0);
      return;
    }
    const lut = await loadLUT(url);
    this.pipeline.setLUT(lut);
    this.state.set('lutEnabled', 1);
  }

  /**
   * Bind an HTML <input type="range"> (or any element with a value/property)
   * to a state key. The slider's domain is mapped onto the state range.
   *
   * @param {string|HTMLElement} elOrSelector
   * @param {string} key  - one of EditorState's keys.
   * @param {object} [opts]
   * @param {[number, number]} [opts.range] - slider min/max. Defaults to element min/max.
   * @param {[number, number]} [opts.target=[-1,1]] - state range.
   */
  bindSlider(elOrSelector, key, opts = {}) {
    const el = typeof elOrSelector === 'string'
      ? document.querySelector(elOrSelector)
      : elOrSelector;
    if (!el) throw new Error(`bindSlider: element not found for "${elOrSelector}"`);

    const sliderMin = opts.range ? opts.range[0] : Number(el.min || -100);
    const sliderMax = opts.range ? opts.range[1] : Number(el.max ||  100);
    const [tMin, tMax] = opts.target || [-1, 1];

    const toState = (raw) => {
      const t = (Number(raw) - sliderMin) / (sliderMax - sliderMin);
      return tMin + t * (tMax - tMin);
    };
    const fromState = (v) => {
      const t = (v - tMin) / (tMax - tMin);
      return sliderMin + t * (sliderMax - sliderMin);
    };

    el.value = String(fromState(this.state.get(key)));
    const handler = (e) => this.state.set(key, toState(e.target.value));
    el.addEventListener('input', handler);

    const unbind = () => el.removeEventListener('input', handler);
    this._sliderUnbinds.push(unbind);
    return unbind;
  }

  /** Subscribe a callback that fires whenever any state value changes. */
  onChange(cb) { return this.state.onChange(cb); }

  /** Reset every slider to default. */
  reset() { this.state.reset(); }

  /** Start the render loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._rafHandle = requestAnimationFrame(this._loop);
  }

  /** Stop the render loop. */
  stop() {
    this._running = false;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = 0;
  }

  _scheduleRender() {
    this.state._dirty = true;
    if (!this._running) this.start();
  }

  _loop() {
    if (!this._running) return;
    if (this.state.isDirty()) {
      this._renderOnce();
    }
    this._rafHandle = requestAnimationFrame(this._loop);
  }

  _renderOnce() {
    const snap = this.state.snapshot();
    this.pipeline.render(snap);
    this.state.clearDirty();
  }

  /**
   * Render the FULL-resolution image through the same pipeline on an
   * off-screen WebGL context and return a JPEG Blob.
   *
   * @param {object} [opts]
   * @param {string} [opts.mime='image/jpeg']
   * @param {number} [opts.quality=0.95]
   * @returns {Promise<Blob>}
   */
  async export(opts = {}) {
    if (!this._sourceImage) throw new Error('Editor.export(): no image loaded.');
    const mime = opts.mime || 'image/jpeg';
    const quality = opts.quality ?? 0.95;

    const fullW = this._sourceImage.naturalWidth;
    const fullH = this._sourceImage.naturalHeight;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = fullW;
    exportCanvas.height = fullH;

    const exportPipeline = new Pipeline(exportCanvas, { preserveDrawingBuffer: true });
    exportPipeline.setImage(this._sourceImage);
    if (this.pipeline.lut) {
      // Re-upload the same LUT image into the off-screen context.
      // Each WebGL context owns its own GPU resources, so the texture itself
      // can't be shared — but the source HTMLImageElement is reusable.
      exportPipeline.setLUT({
        image: this.pipeline.lut.image,
        size: this.pipeline.lut.size,
        tilesPerRow: this.pipeline.lut.tilesPerRow,
      });
    }

    exportPipeline.render(this.state.snapshot());

    const blob = await new Promise((resolve) =>
      exportCanvas.toBlob(resolve, mime, quality)
    );
    exportPipeline.dispose();
    return blob;
  }

  /** Tear down everything. */
  dispose() {
    this.stop();
    for (const u of this._sliderUnbinds) u();
    this._sliderUnbinds = [];
    this.pipeline.dispose();
    this._sourceImage = null;
    this._sourceBlob = null;
    this._proxyCanvas = null;
  }
}

// ---------- helpers ----------

async function coerceToImage(source) {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    if (source.complete && source.naturalWidth > 0) return source;
    return new Promise((resolve, reject) => {
      source.addEventListener('load', () => resolve(source), { once: true });
      source.addEventListener('error', reject, { once: true });
    });
  }
  if (source instanceof Blob) {
    const url = URL.createObjectURL(source);
    try {
      return await loadImageURL(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (typeof source === 'string') {
    return loadImageURL(source);
  }
  throw new Error('Editor.load(): unsupported source type.');
}

function loadImageURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${e?.message || e}`));
    img.src = url;
  });
}

function makeProxyCanvas(img, maxEdge) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const longest = Math.max(w, h);
  const scale = longest > maxEdge ? (maxEdge / longest) : 1;
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));
  const cv = document.createElement('canvas');
  cv.width = pw;
  cv.height = ph;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, pw, ph);
  return cv;
}
