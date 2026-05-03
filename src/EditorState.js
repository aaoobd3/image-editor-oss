// Centralized normalized state. All sliders live in [-1, 1] except where noted.
// The UI layer is responsible for mapping its own scale onto these values.

const DEFAULTS = Object.freeze({
  // Light
  exposure:   0.0,  // -1..1   -> -2..+2 EV
  brightness: 0.0,  // -1..1   -> linear gain
  contrast:   0.0,  // -1..1
  highlights: 0.0,  // -1..1   negative = recover
  shadows:    0.0,  // -1..1   positive = lift
  whites:     0.0,  // -1..1
  blacks:     0.0,  // -1..1

  // Color / White Balance
  temperature: 0.0, // -1..1   negative = cool, positive = warm
  tint:        0.0, // -1..1   negative = green, positive = magenta
  vibrance:    0.0, // -1..1
  saturation:  0.0, // -1..1

  // Detail
  sharpness:  0.0,  // 0..1
  definition: 0.0,  // -1..1   "Clarity"

  // Filters
  lutIntensity: 1.0, // 0..1
  lutEnabled: 0,     // 0 or 1
});

const CLAMP_RANGES = {
  lutIntensity: [0, 1],
  sharpness:    [0, 1],
};

export class EditorState {
  constructor(initial = {}) {
    this._values = { ...DEFAULTS, ...initial };
    this._listeners = new Set();
    this._dirty = true;
  }

  get(key) { return this._values[key]; }

  set(key, value) {
    if (!(key in DEFAULTS)) return;
    const range = CLAMP_RANGES[key] || [-1, 1];
    const v = Math.max(range[0], Math.min(range[1], +value));
    if (this._values[key] === v) return;
    this._values[key] = v;
    this._dirty = true;
    this._notify(key, v);
  }

  setMany(obj) {
    for (const [k, v] of Object.entries(obj)) this.set(k, v);
  }

  reset() {
    for (const k of Object.keys(DEFAULTS)) this.set(k, DEFAULTS[k]);
  }

  /** Snapshot all current values as a plain object. */
  snapshot() { return { ...this._values }; }

  isDirty() { return this._dirty; }
  clearDirty() { this._dirty = false; }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(key, value) {
    for (const l of this._listeners) l(key, value, this._values);
  }
}

export const STATE_DEFAULTS = DEFAULTS;
