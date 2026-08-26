/**
 * Portable grayscale image primitives.
 *
 * Works on plain {data,width,height} structs so the same code runs in the
 * browser (canvas ImageData) and under Node (pngjs/jpeg-js) for testing.
 */

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export function fromRGBA(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Gray {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000 | 0;
  }
  return { data: out, width, height };
}

export function toRGBA(g: Gray): { data: Uint8ClampedArray; width: number; height: number } {
  const n = g.width * g.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = g.data[i];
    out[j + 3] = 255;
  }
  return { data: out, width: g.width, height: g.height };
}

export function crop(src: Gray, x0: number, y0: number, x1: number, y1: number): Gray {
  x0 = Math.max(0, x0 | 0);
  y0 = Math.max(0, y0 | 0);
  x1 = Math.min(src.width, Math.ceil(x1));
  y1 = Math.min(src.height, Math.ceil(y1));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * src.width + x0);
    out.set(src.data.subarray(s, s + w), y * w);
  }
  return { data: out, width: w, height: h };
}

/** Area-average downscale; falls back to bilinear for upscale factors. */
export function resize(src: Gray, w2: number, h2: number): Gray {
  w2 = Math.max(1, w2 | 0);
  h2 = Math.max(1, h2 | 0);
  if (w2 === src.width && h2 === src.height) return src;
  const sx = src.width / w2;
  const sy = src.height / h2;
  if (sx <= 1 && sy <= 1) return resizeBilinear(src, w2, h2);
  return resizeArea(src, w2, h2);
}

function resizeBilinear(src: Gray, w2: number, h2: number): Gray {
  const out = new Uint8Array(w2 * h2);
  const sx = src.width / w2;
  const sy = src.height / h2;
  for (let y = 0; y < h2; y++) {
    const fy = Math.min(src.height - 1.001, (y + 0.5) * sy - 0.5);
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const r0 = y0 * src.width;
    const r1 = (y0 + 1) * src.width;
    for (let x = 0; x < w2; x++) {
      const fx = Math.min(src.width - 1.001, (x + 0.5) * sx - 0.5);
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const a = src.data[r0 + x0];
      const b = src.data[r0 + x0 + 1];
      const c = src.data[r1 + x0];
      const d = src.data[r1 + x0 + 1];
      out[y * w2 + x] =
        (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return { data: out, width: w2, height: h2 };
}

function resizeArea(src: Gray, w2: number, h2: number): Gray {
  const out = new Uint8Array(w2 * h2);
  const sx = src.width / w2;
  const sy = src.height / h2;
  for (let y = 0; y < h2; y++) {
    const ya = y * sy;
    const yb = Math.min(src.height, (y + 1) * sy);
    for (let x = 0; x < w2; x++) {
      const xa = x * sx;
      const xb = Math.min(src.width, (x + 1) * sx);
      let sum = 0;
      let cnt = 0;
      for (let yy = Math.floor(ya); yy < yb; yy++) {
        const row = yy * src.width;
        const wy = Math.min(yy + 1, yb) - yy;
        for (let xx = Math.floor(xa); xx < xb; xx++) {
          const wx = Math.min(xx + 1, xb) - xx;
          sum += src.data[row + xx] * wx * wy;
          cnt += wx * wy;
        }
      }
      out[y * w2 + x] = sum / cnt;
    }
  }
  return { data: out, width: w2, height: h2 };
}

/** Horizontal mirror. */
export function flipH(src: Gray): Gray {
  const out = new Uint8Array(src.data.length);
  for (let y = 0; y < src.height; y++) {
    const row = y * src.width;
    for (let x = 0; x < src.width; x++) {
      out[row + (src.width - 1 - x)] = src.data[row + x];
    }
  }
  return { data: out, width: src.width, height: src.height };
}

/** Global Otsu binarization on a lightly blurred copy. */
export function otsuBin(src: Gray): Gray {
  const g = gaussianBlur3(src);
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  const total = g.data.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = v;
    }
  }
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) out[i] = g.data[i] > thr ? 255 : 0;
  return { data: out, width: src.width, height: src.height };
}

/** Separable [1,2,1] blur, one pass. */
export function gaussianBlur3(src: Gray): Gray {
  const { width: w, height: h, data } = src;
  const tmp = new Uint8Array(data.length);
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = data[r + Math.max(0, x - 1)];
      const c = data[r + x];
      const rr = data[r + Math.min(w - 1, x + 1)];
      tmp[r + x] = (l + 2 * c + rr) >> 2;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const dn = Math.min(h - 1, y + 1) * w;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      out[r + x] = (tmp[up + x] + 2 * tmp[r + x] + tmp[dn + x]) >> 2;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Mean adaptive threshold over an integral image.
 * blockSize must be odd; C shifts the threshold (higher C = darker pixels
 * qualify as black more readily).
 */
export function adaptiveThresholdMean(src: Gray, blockSize: number, c: number): Gray {
  const bs = Math.max(3, blockSize | 1);
  const half = bs >> 1;
  const { width: w, height: h } = src;
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src.data[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s =
        ii[(y1 + 1) * (w + 1) + (x1 + 1)] -
        ii[y0 * (w + 1) + (x1 + 1)] -
        ii[(y1 + 1) * (w + 1) + x0] +
        ii[y0 * (w + 1) + x0];
      out[y * w + x] = src.data[y * w + x] > s / area - c ? 255 : 0;
    }
  }
  return { data: out, width: w, height: h };
}
