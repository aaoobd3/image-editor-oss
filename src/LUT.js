// 3D LUT support. Loads a tiled-PNG LUT from a URL, infers its size and tile
// layout, and returns a metadata object the editor can bind to a sampler.
//
// Supported layouts:
//   - 64x64x64 LUT stored as 8x8 tiles (512x512 PNG) — most common
//   - 32x32x32 LUT stored as 8x4 or square tile grids (256x256 PNG, etc.)
//
// We auto-detect by trying square integer factorizations of `levels`.

function inferLayout(width, height) {
  if (width !== height) {
    // Some LUTs are stored as long strips (N x N*N). Handle that case.
    // E.g. 4096x64 means 64 tiles of 64x64 along x.
    if (width === height * height) {
      return { size: height, tilesPerRow: height };
    }
    if (height === width * width) {
      return { size: width, tilesPerRow: 1, vertical: true };
    }
  }
  // Square tile grid: width = sqrt(levels) * levels.
  // For levels=64, width=512, tilesPerRow=8.
  for (const candidate of [64, 32, 16, 17, 33, 65]) {
    const tpr = Math.round(width / candidate);
    if (tpr * candidate === width && tpr * tpr === candidate) {
      return { size: candidate, tilesPerRow: tpr };
    }
  }
  // Last-resort: assume 64-level / 8-tile.
  return { size: 64, tilesPerRow: 8 };
}

export async function loadLUT(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const layout = inferLayout(img.naturalWidth, img.naturalHeight);
      resolve({ image: img, ...layout });
    };
    img.onerror = (e) => reject(new Error(`Failed to load LUT at ${url}: ${e?.message || e}`));
    img.src = url;
  });
}
