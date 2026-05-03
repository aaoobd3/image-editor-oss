// Computes a 3x3 matrix that, when applied to a linear sRGB color, performs
// a Bradford chromatic adaptation from D65 to a target white derived from the
// user's temperature/tint sliders. The matrix is precomputed JS-side and
// uploaded as a single uniform mat3, so the shader stays fast.
//
// Pipeline: linRGB -> XYZ -> Bradford LMS -> diag scale -> LMS -> XYZ -> linRGB

// sRGB primaries (D65, IEC 61966-2-1)
const M_RGB2XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
const M_XYZ2RGB = [
  [ 3.2404542, -1.5371385, -0.4985314],
  [-0.9692660,  1.8760108,  0.0415560],
  [ 0.0556434, -0.2040259,  1.0572252],
];
// Bradford cone-response matrix and its inverse
const M_BRADFORD = [
  [ 0.8951,  0.2664, -0.1614],
  [-0.7502,  1.7135,  0.0367],
  [ 0.0389, -0.0685,  1.0296],
];
const M_BRADFORD_INV = [
  [ 0.9869929, -0.1470543,  0.1599627],
  [ 0.4323053,  0.5183603,  0.0492912],
  [-0.0085287,  0.0400428,  0.9684867],
];
// D65 reference white (Y normalized to 1)
const W_D65 = [0.95047, 1.00000, 1.08883];

function multMatVec(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ];
}
function multMat(A, B) {
  const out = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        out[i][j] += A[i][k] * B[k][j];
  return out;
}

// CCT (in Kelvin) -> CIE 1931 xy chromaticity (Krystek / CIE D-illuminant fit).
function kelvinToXY(T) {
  T = Math.max(1667, Math.min(25000, T));
  let x;
  if (T <= 4000) {
    x = -0.2661239e9 / (T*T*T) - 0.2343589e6 / (T*T) + 0.8776956e3 / T + 0.179910;
  } else {
    x = -3.0258469e9 / (T*T*T) + 2.1070379e6 / (T*T) + 0.2226347e3 / T + 0.24039;
  }
  let y;
  if (T <= 2222) {
    y = -1.1063814*x*x*x - 1.34811020*x*x + 2.18555832*x - 0.20219683;
  } else if (T <= 4000) {
    y = -0.9549476*x*x*x - 1.37418593*x*x + 2.09137015*x - 0.16748867;
  } else {
    y =  3.0817580*x*x*x - 5.87338670*x*x + 3.75112997*x - 0.37001483;
  }
  return [x, y];
}
function xyToXYZ(x, y) {
  return [x / y, 1.0, (1 - x - y) / y];
}

/**
 * Build the chromatic-adaptation matrix the shader expects.
 * @param {number} temperature - slider in [-1, 1]. Positive = warmer.
 * @param {number} tint        - slider in [-1, 1]. Positive = magenta, negative = green.
 * @returns {Float32Array} column-major 3x3 (mat3 layout for WebGL).
 */
export function buildChromaticAdaptationMatrix(temperature = 0, tint = 0) {
  // Map slider to Kelvin. Positive slider -> warmer image -> lower Kelvin target.
  const Tcenter = 6500;
  const T = Tcenter - temperature * 3500; // ~3000K..10000K range
  const [tx, ty0] = kelvinToXY(T);
  // Tint shifts y (green-magenta axis) by a small amount.
  const ty = ty0 - tint * 0.05;

  const Wt = xyToXYZ(tx, ty);

  const lmsSrc = multMatVec(M_BRADFORD, W_D65);
  const lmsDst = multMatVec(M_BRADFORD, Wt);
  const D = [lmsDst[0] / lmsSrc[0], lmsDst[1] / lmsSrc[1], lmsDst[2] / lmsSrc[2]];

  // Full CAT in linear sRGB space:
  //   M = XYZ2RGB · BRADFORD_INV · D · BRADFORD · RGB2XYZ
  const Dmat = [[D[0],0,0],[0,D[1],0],[0,0,D[2]]];
  const a = multMat(M_BRADFORD, M_RGB2XYZ);   // BRADFORD · RGB2XYZ
  const b = multMat(Dmat, a);                 // D · BRADFORD · RGB2XYZ
  const c = multMat(M_BRADFORD_INV, b);       // BRADFORD_INV · ...
  const M = multMat(M_XYZ2RGB, c);            // XYZ2RGB · ...

  // WebGL mat3 is column-major.
  return new Float32Array([
    M[0][0], M[1][0], M[2][0],
    M[0][1], M[1][1], M[2][1],
    M[0][2], M[1][2], M[2][2],
  ]);
}

export const IDENTITY_CAT = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
