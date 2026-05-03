import { Editor } from '../src/Editor.js';
import { PRESETS, getPresetLUT } from '../src/Presets.js';

const canvas = document.getElementById('stage');
const viewport = canvas.parentElement;
const editor = new Editor(canvas);

// Wire all sliders declared in the HTML to state keys.
const rows = document.querySelectorAll('.slider-row');
for (const row of rows) {
  const key = row.dataset.key;
  const input = row.querySelector('input[type="range"]');
  const valEl = row.querySelector('.val');
  if (!key || !input) continue;

  const targetAttr = row.dataset.target;
  const target = targetAttr ? targetAttr.split(',').map(Number) : [-1, 1];

  editor.bindSlider(input, key, { target });
  input.addEventListener('input', () => { valEl.textContent = input.value; });
}

// Mirror state -> slider DOM (used by Reset).
editor.onChange((key, value) => {
  const row = document.querySelector(`.slider-row[data-key="${key}"]`);
  if (!row) return;
  const input = row.querySelector('input[type="range"]');
  const valEl = row.querySelector('.val');
  const targetAttr = row.dataset.target;
  const [tMin, tMax] = targetAttr ? targetAttr.split(',').map(Number) : [-1, 1];
  const sMin = Number(input.min), sMax = Number(input.max);
  const t = (value - tMin) / (tMax - tMin);
  const raw = sMin + t * (sMax - sMin);
  input.value = String(raw);
  valEl.textContent = String(Math.round(raw));
});

// ---------- Preset grid ----------
// Build the preset buttons. Thumbnails are generated from the LUT canvas
// tinted over a neutral grey gradient to give a preview of the color grade.
let activePresetId = 'none';

const presetGrid = document.getElementById('preset-grid');

for (const preset of PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'preset-btn' + (preset.id === 'none' ? ' active' : '');
  btn.dataset.id = preset.id;

  const thumb = makeThumb(preset);
  thumb.className = 'preset-thumb';
  btn.appendChild(thumb);

  const label = document.createElement('span');
  label.className = 'preset-label';
  label.textContent = preset.label;
  btn.appendChild(label);

  btn.addEventListener('click', () => applyPreset(preset.id));
  presetGrid.appendChild(btn);
}

function applyPreset(id) {
  // Deactivate previous
  presetGrid.querySelector('.preset-btn.active')?.classList.remove('active');
  presetGrid.querySelector(`[data-id="${id}"]`)?.classList.add('active');
  activePresetId = id;

  const lut = getPresetLUT(id); // null for 'none'
  editor.applyLUTData(lut);
}

// Generate a small preview thumbnail showing the LUT's color grade
// applied to a horizontal grey ramp with a warm-to-cool gradient.
function makeThumb(preset) {
  const W = 80, H = 60;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  if (!preset.transform) {
    // Identity — show a plain grey ramp.
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#111');
    grad.addColorStop(0.5, '#888');
    grad.addColorStop(1, '#fff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return cv;
  }

  // Build a representative preview: sample rows of varying luminance & hue.
  const id = ctx.createImageData(W, H);
  const px = id.data;
  for (let y = 0; y < H; y++) {
    const row = y / (H - 1); // 0..1
    for (let x = 0; x < W; x++) {
      const col = x / (W - 1); // 0..1
      // Diagonal gradient: luminance increases left→right, hue rotates top→bottom
      const lum = col;
      // Shift hue by row: top = warm (reddish), bottom = cool (blueish)
      const warm = (1 - row) * 0.3;
      const cool = row * 0.3;
      let r = clamp01(lum + warm * (1 - lum));
      let g = clamp01(lum - warm * 0.15 - cool * 0.15);
      let b = clamp01(lum + cool * (1 - lum));
      const [ro, go, bo] = preset.transform(r, g, b);
      const i = (y * W + x) * 4;
      px[i]     = Math.round(clamp01(ro) * 255);
      px[i + 1] = Math.round(clamp01(go) * 255);
      px[i + 2] = Math.round(clamp01(bo) * 255);
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return cv;
}

const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------- File picker + drop ----------
const fileInput = document.getElementById('file-input');
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await openFile(file);
});
['dragenter', 'dragover'].forEach(ev =>
  viewport.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); })
);
viewport.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) await openFile(file);
});

async function openFile(file) {
  await editor.load(file);
  viewport.classList.add('has-image');
  // Re-apply the active preset on new image load.
  if (activePresetId !== 'none') applyPreset(activePresetId);
}

// ---------- Reset ----------
document.getElementById('reset-btn').addEventListener('click', () => {
  editor.reset();
  applyPreset('none');
});

// ---------- Export ----------
document.getElementById('export-btn').addEventListener('click', async () => {
  try {
    const blob = await editor.export({ quality: 0.95 });
    if (!blob) { alert('Nothing to export — load an image first.'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spectra-export.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
  }
});

window.__editor = editor;
