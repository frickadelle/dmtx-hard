/**
 * Grid-rescue decoder for damaged DataMatrix codes.
 *
 * Port of the verified Python prototype (proto4/6/7): when stock localization
 * fails (destroyed finder L, tilt, occlusion), estimate the symbol grid by
 * brute-force alignment search, score candidates by finder/clock-track fit,
 * synthesize a clean symbol bitmap (border rebuilt from spec), and hand it to
 * the WASM decoder for Reed-Solomon decoding.
 */
import { gaussianBlur3 } from './image.ts';

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RescueHit {
  text: string;
  score: number;
  modules: number;
  pitch: number;
  angle: number;
}

export interface SearchOptions {
  /** symbol sizes (even) to try */
  nValues?: number[];
  /** rotation search range in degrees */
  angles?: number[];
  /** number of top candidates to hand to the decoder */
  decodeTop?: number;
  /** density-peak count */
  peaks?: number;
  verbose?: boolean;
}

type Mu = { d: Float32Array; n: number };

/** Percentile contrast normalization (p10..p90 stretch). */
export function normalize(gray: Gray): Gray {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.data.length; i++) hist[gray.data[i]]++;
  const total = gray.data.length;
  const pick = (p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= total * p) return v;
    }
    return 255;
  };
  const lo = pick(0.1);
  const hi = pick(0.9);
  if (hi - lo < 5) return gray;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, ((v - lo) * 255) / (hi - lo)));
  }
  const out = new Uint8Array(gray.data.length);
  for (let i = 0; i < out.length; i++) out[i] = lut[gray.data[i]];
  return { data: out, width: gray.width, height: gray.height };
}

/** Separable gaussian blur, sigma in pixels. */
export function gaussianBlur(gray: Gray, sigma: number): Gray {
  if (sigma < 0.3) return gray;
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    ks += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const { width: w, height: h, data } = gray;
  const tmp = new Float32Array(data.length);
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += data[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return { data: out, width: w, height: h };
}

/** Top-k high-transition-density block centers (candidate code regions). */
export function densityPeaks(gray: Gray, k = 6, block = 14): Array<[number, number]> {
  const { width: w, height: h, data } = gray;
  const pw = Math.max(1, Math.floor(w / block));
  const ph = Math.max(1, Math.floor(h / block));
  const dens = new Float32Array(ph * pw);
  for (let j = 0; j < ph; j++) {
    for (let i = 0; i < pw; i++) {
      let s = 0;
      let c = 0;
      for (let y = j * block; y < Math.min(h, (j + 1) * block) - 1; y++) {
        for (let x = i * block; x < Math.min(w, (i + 1) * block) - 1; x++) {
          const v = data[y * w + x];
          s += Math.abs(v - data[y * w + x + 1]) + Math.abs(v - data[(y + 1) * w + x]);
          c += 2;
        }
      }
      dens[j * pw + i] = c ? s / c : 0;
    }
  }
  // smooth 3x3
  const sm = new Float32Array(ph * pw);
  for (let j = 0; j < ph; j++) {
    for (let i = 0; i < pw; i++) {
      let s = 0;
      let c = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const jj = j + dj;
          const ii = i + di;
          if (jj < 0 || ii < 0 || jj >= ph || ii >= pw) continue;
          s += dens[jj * pw + ii];
          c++;
        }
      }
      sm[j * pw + i] = s / c;
    }
  }
  const peaks: Array<[number, number]> = [];
  const used = new Uint8Array(ph * pw);
  for (let n = 0; n < k; n++) {
    let best = -1;
    let bj = 0;
    let bi = 0;
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const idx = j * pw + i;
        if (!used[idx] && sm[idx] > best) {
          best = sm[idx];
          bj = j;
          bi = i;
        }
      }
    }
    if (best < 0) break;
    peaks.push([bi * block + block / 2, bj * block + block / 2]);
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const jj = bj + dj;
        const ii = bi + di;
        if (jj >= 0 && ii >= 0 && jj < ph && ii < pw) used[jj * pw + ii] = 1;
      }
    }
  }
  return peaks;
}

/** Module-pitch candidates from projection autocorrelation local maxima,
 *  strongest first, capped. */
export function pitchCandidates(gray: Gray, lo = 4, hi = 64, maxCount = 8): number[] {
  const { width: w, height: h, data } = gray;
  const sx = new Float64Array(w);
  const sy = new Float64Array(h);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const d = Math.abs(data[y * w + x] - data[y * w + x + 1]);
      sx[x] += d;
      sy[y] += d;
    }
  }
  const L = Math.min(w, h);
  const sig = new Float64Array(L);
  for (let i = 0; i < L; i++) sig[i] = (sx[i] + sy[i]) / L;
  let mean = 0;
  for (let i = 0; i < L; i++) mean += sig[i];
  mean /= L;
  const ac = new Float64Array(L);
  for (let lag = 0; lag < L; lag++) {
    let s = 0;
    for (let i = 0; i < L - lag; i++) s += (sig[i] - mean) * (sig[i + lag] - mean);
    ac[lag] = s;
  }
  let mx = 0;
  for (let lag = 1; lag < L; lag++) mx = Math.max(mx, ac[lag]);
  if (mx <= 0) return [];
  const peaks: Array<[number, number]> = [];
  for (let lag = lo; lag < Math.min(hi, L - 2); lag++) {
    if (ac[lag] > 0.12 * mx && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      peaks.push([lag, ac[lag]]);
    }
  }
  peaks.sort((a, b) => b[1] - a[1]);
  const out = new Set<number>();
  for (const [lag] of peaks.slice(0, maxCount)) {
    out.add(Math.round(lag * 0.92 * 100) / 100);
    out.add(Math.round(lag * 100) / 100);
    out.add(Math.round(lag * 1.08 * 100) / 100);
  }
  return [...out].sort((a, b) => a - b);
}

/** Bilinear module-darkness sampler on an affine (rotation) grid. */
export function sampleMu(
  gray: Gray,
  cx: number,
  cy: number,
  pitch: number,
  n: number,
  angleDeg: number,
): Mu | null {
  const t = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(t) * pitch;
  const uy = Math.sin(t) * pitch;
  const vx = -Math.sin(t) * pitch;
  const vy = Math.cos(t) * pitch;
  const { width: w, height: h, data } = gray;
  const d = new Float32Array(n * n);
  const half = (n - 1) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = i - half;
      const b = j - half;
      const x = cx + a * ux + b * vx;
      const y = cy + a * uy + b * vy;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) return null;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const tx = x - x0;
      const ty = y - y0;
      const r0 = y0 * w;
      const v =
        (data[r0 + x0] * (1 - tx) + data[r0 + x0 + 1] * tx) * (1 - ty) +
        (data[r0 + w + x0] * (1 - tx) + data[r0 + w + x0 + 1] * tx) * ty;
      d[j * n + i] = 1 - v / 255;
    }
  }
  return { d, n };
}

type Orient = (m: Mu) => Mu;

function mkOrient(f: (i: number, j: number, n: number) => [number, number]): Orient {
  return (m: Mu) => {
    const { d, n } = m;
    const out = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [si, sj] = f(i, j, n);
        out[j * n + i] = d[sj * n + si];
      }
    }
    return { d: out, n };
  };
}

/** 8 orientations (4 rotations × mirror) mapping sampled grid to spec pose. */
export const ORIENTS: Orient[] = [
  mkOrient((i, j) => [i, j]),
  mkOrient((i, j, n) => [j, n - 1 - i]),
  mkOrient((i, j, n) => [n - 1 - i, n - 1 - j]),
  mkOrient((i, j, n) => [n - 1 - j, i]),
  mkOrient((i, j, n) => [n - 1 - i, j]),
  mkOrient((i, j, n) => [i, n - 1 - j]),
  mkOrient((i, j, n) => [n - 1 - j, n - 1 - i]),
  mkOrient((i, j, n) => [j, i]),
];

/** 1 = expect black. L: left col + bottom row; clock: top even-x, right odd-y. */
export function borderExpect(n: number): { e: Float32Array; mask: Uint8Array } {
  const e = new Float32Array(n * n);
  const mask = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    e[(n - 1) * n + i] = 1; // bottom solid
    mask[(n - 1) * n + i] = 1;
    mask[i] = 1; // top row
    mask[i * n] = 1; // left col
    mask[i * n + n - 1] = 1; // right col
    // top clock: even x black, odd x white
    e[i] = i % 2 === 0 ? 1 : 0;
    // right clock: odd y black, even y white
    e[i * n + n - 1] = i % 2 === 1 ? 1 : 0;
  }
  e[0] = 1; // top-left corner part of L
  e[(n - 1) * n + n - 1] = 1; // bottom-right corner part of L
  return { e, mask };
}

export function borderScore(m: Mu): number {
  const { e, mask } = borderExpect(m.n);
  let s = 0;
  let c = 0;
  for (let i = 0; i < m.d.length; i++) {
    if (!mask[i]) continue;
    s += m.d[i] * e[i] + (1 - m.d[i]) * (1 - e[i]);
    c++;
  }
  return s / c;
}

/** Clock-track-only fit; robust when the solid L is destroyed. */
export function clockScore(m: Mu): number {
  const n = m.n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += i % 2 === 0 ? m.d[i] : 1 - m.d[i]; // top row
    s += i % 2 === 1 ? m.d[i * n + n - 1] : 1 - m.d[i * n + n - 1]; // right col
  }
  return s / (2 * n);
}

export function alignmentScore(m: Mu): number {
  return Math.max(borderScore(m), clockScore(m));
}

/** Synthesize a clean symbol bitmap (0/255) from an oriented darkness grid. */
export function synthSymbol(m: Mu): Gray {
  const n = m.n;
  const out = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) out[i] = m.d[i] > 0.5 ? 0 : 255;
  const { e, mask } = borderExpect(n);
  for (let i = 0; i < n * n; i++) {
    if (mask[i]) out[i] = e[i] === 1 ? 0 : 255;
  }
  return { data: out, width: n, height: n };
}

export interface DecodePure {
  (mu: Float32Array, n: number): Promise<string | null>;
}

interface Cand {
  score: number;
  n: number;
  pitch: number;
  angle: number;
  cx: number;
  cy: number;
}

/**
 * Exhaustive grid search over density peaks, pitches, sizes, angles, centers.
 * Returns decoded texts for the top candidates.
 */
export async function rescueScan(
  gray: Gray,
  decode: DecodePure,
  opts: SearchOptions = {},
): Promise<RescueHit[]> {
  const nValues = opts.nValues ?? [10, 12, 14, 16, 18, 20, 22, 24, 26, 28];
  const angles = opts.angles ?? [-12, -9, -6, -3, 0, 3, 6, 9, 12];
  const decodeTop = opts.decodeTop ?? 30;
  const normed = normalize(gray);
  const blurred = gaussianBlur(normed, 1.4);
  const { width: w, height: h } = blurred;
  const peaks = densityPeaks(normed, opts.peaks ?? 6);
  const cands: Cand[] = [];

  for (const [px, py] of peaks) {
    const pitches = pitchCandidates(blurred);
    const top: Cand[] = []; // min-heap by score, bounded 40
    const pushTop = (c: Cand) => {
      if (top.length < 40) {
        top.push(c);
        top.sort((a, b) => a.score - b.score);
      } else if (c.score > top[0].score) {
        top[0] = c;
        top.sort((a, b) => a.score - b.score);
      }
    };
    for (const pitch of pitches) {
      for (const n of nValues) {
        const span = pitch * n;
        if (span > 1.02 * Math.min(w, h) || span < 36) continue;
        for (const ang of angles) {
          const t = (ang * Math.PI) / 180;
          const ux = Math.cos(t) * pitch;
          const uy = Math.sin(t) * pitch;
          const vx = -Math.sin(t) * pitch;
          const vy = Math.cos(t) * pitch;
          const half = (n - 1) / 2;
          const minX = half * ux + half * vx;
          const minY = half * uy + half * vy;
          const maxX = (n - 1 - half) * ux + (n - 1 - half) * vx;
          const maxY = (n - 1 - half) * uy + (n - 1 - half) * vy;
          for (let cy = span / 2; cy <= h - span / 2 + 0.01; cy += pitch) {
            for (let cx = span / 2; cx <= w - span / 2 + 0.01; cx += pitch) {
              if (cx + minX < 1 || cy + minY < 1) continue;
              if (cx + maxX > w - 2 || cy + maxY > h - 2) continue;
              const mu = sampleMu(blurred, cx, cy, pitch, n, ang);
              if (!mu) continue;
              let s = -1;
              for (const of of ORIENTS) {
                const os = alignmentScore(of(mu));
                if (os > s) s = os;
              }
              pushTop({ score: s, n, pitch, angle: ang, cx, cy });
            }
          }
        }
      }
    }
    top.sort((a, b) => b.score - a.score);
    if (opts.verbose) {
      console.log(
        `peak (${px.toFixed(0)},${py.toFixed(0)}) top:`,
        top.slice(0, 4).map((c) => [c.score.toFixed(3), c.n, c.pitch.toFixed(1), c.angle]),
      );
    }
    // refine top 3 around (cx, cy)
    for (const c0 of top.slice(0, 3)) {
      let best: Cand = { ...c0 };
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          for (const da of [-1.5, 0, 1.5]) {
            const mu = sampleMu(
              blurred,
              c0.cx + (dx * c0.pitch) / 4,
              c0.cy + (dy * c0.pitch) / 4,
              c0.pitch,
              c0.n,
              c0.angle + da,
            );
            if (!mu) continue;
            for (const of of ORIENTS) {
              const s = alignmentScore(of(mu));
              if (s > best.score) {
                best = {
                  score: s,
                  n: c0.n,
                  pitch: c0.pitch,
                  angle: c0.angle + da,
                  cx: c0.cx + (dx * c0.pitch) / 4,
                  cy: c0.cy + (dy * c0.pitch) / 4,
                };
              }
            }
          }
        }
      }
      cands.push(best);
    }
  }
  cands.sort((a, b) => b.score - a.score);
  if (opts.verbose) {
    console.log(
      'global top:',
      cands.slice(0, 6).map((c) => [c.score.toFixed(3), c.n, c.pitch.toFixed(1), c.angle]),
    );
  }
  const hits: RescueHit[] = [];
  for (const c of cands.slice(0, decodeTop)) {
    const mu = sampleMu(blurred, c.cx, c.cy, c.pitch, c.n, c.angle);
    if (!mu) continue;
    let bestOrient: Mu | null = null;
    let bestS = -1;
    for (const of of ORIENTS) {
      const om = of(mu);
      const s = alignmentScore(om);
      if (s > bestS) {
        bestS = s;
        bestOrient = om;
      }
    }
    if (!bestOrient) continue;
    const text = await decode(bestOrient.d, bestOrient.n);
    if (text) {
      hits.push({ text, score: c.score, modules: c.n, pitch: c.pitch, angle: c.angle });
    }
  }
  return hits;
}
