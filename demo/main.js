import { Editor } from '../src/Editor.js';

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
  const target = targetAttr
    ? targetAttr.split(',').map(Number)
    : [-1, 1];

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

// File picker + drop target.
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
}

// Reset
document.getElementById('reset-btn').addEventListener('click', () => editor.reset());

// Export
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

// LUT controls
document.getElementById('lut-apply').addEventListener('click', async () => {
  const url = document.getElementById('lut-url').value.trim();
  if (!url) return;
  try {
    await editor.applyLUT(url);
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
  }
});
document.getElementById('lut-clear').addEventListener('click', () => editor.applyLUT(null));

// Expose for ad-hoc console debugging.
window.__editor = editor;
