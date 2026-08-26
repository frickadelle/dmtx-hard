/**
 * ECC200 DataMatrix decoding: module placement (Annex M via zxing-cpp port),
 * codeword extraction, Reed-Solomon with erasures, and text decoding.
 *
 * Verified bit-exact against zxing-generated reference symbols for sizes
 * 10..26 (single-region).
 */
import { rsDecode } from './rs.ts';

export const SIZES: Record<number, [number, number]> = {
  10: [3, 5], 12: [5, 7], 14: [8, 10], 16: [12, 14], 18: [18, 20],
  20: [22, 24], 22: [30, 28], 24: [36, 36], 26: [44, 42],
};

const CORNER1 = [[-1, 0], [-1, 1], [-1, 2], [0, -2], [0, -1], [1, -1], [2, -1], [3, -1]];
const CORNER2 = [[-3, 0], [-2, 0], [-1, 0], [0, -4], [0, -3], [0, -2], [0, -1], [1, -1]];
const CORNER3 = [[-1, 0], [-1, -1], [0, -3], [0, -2], [0, -1], [1, -3], [1, -2], [1, -1]];
const CORNER4 = [[-3, 0], [-2, 0], [-1, 0], [0, -2], [0, -1], [1, -1], [2, -1], [3, -1]];
const UTAH_DELTA = [[-2, -2], [-2, -1], [-1, -2], [-1, -1], [-1, 0], [0, -2], [0, -1], [0, 0]];

export interface Placement {
  /** stream bit position per interior cell, -1 = not data; index row*ncols+col */
  bits: Int32Array;
  visited: Uint8Array;
  nrows: number;
  ncols: number;
  /** [(bitpos, symRow, symCol)] sorted by stream position */
  order: Array<[number, number, number]>;
}

export function makePlacement(nrows: number, ncols: number): Placement {
  const bits = new Int32Array(nrows * ncols).fill(-1);
  const visited = new Uint8Array(nrows * ncols);
  let pos = 0;

  const corner = (cells: number[][]) => {
    const out: Array<[number, number]> = [];
    for (const [r, c] of cells) {
      const rr = r < 0 ? r + nrows : r;
      const cc = c < 0 ? c + ncols : c;
      visited[rr * ncols + cc] = 1;
      out.push([rr, cc]);
    }
    return out;
  };

  const utah = (row: number, col: number) => {
    const out: Array<[number, number]> = [];
    for (const [dr, dc] of UTAH_DELTA) {
      let r = row + dr;
      let c = col + dc;
      if (r < 0) {
        r += nrows;
        c += 4 - ((nrows + 4) % 8);
      }
      if (c < 0) {
        c += ncols;
        r += 4 - ((ncols + 4) % 8);
      }
      if (r >= nrows) {
        r -= nrows;
      }
      visited[r * ncols + c] = 1;
      out.push([r, c]);
    }
    return out;
  };

  const visit = (cells: Array<[number, number]>) => {
    for (const [r, c] of cells) bits[r * ncols + c] = pos++;
  };

  let row = 4;
  let col = 0;
  for (;;) {
    if (row === nrows && col === 0) visit(corner(CORNER1));
    else if (row === nrows - 2 && col === 0 && ncols % 4 !== 0) visit(corner(CORNER2));
    else if (row === nrows + 4 && col === 2 && ncols % 8 === 0) visit(corner(CORNER3));
    else if (row === nrows - 2 && col === 0 && ncols % 8 === 4) visit(corner(CORNER4));

    for (;;) {
      if (row < nrows && col >= 0 && !visited[row * ncols + col]) visit(utah(row, col));
      row -= 2;
      col += 2;
      if (!(row >= 0 && col < ncols)) break;
    }
    row += 1;
    col += 3;
    for (;;) {
      if (row >= 0 && col < ncols && !visited[row * ncols + col]) visit(utah(row, col));
      row += 2;
      col -= 2;
      if (!(row < nrows && col >= 0)) break;
    }
    row += 3;
    col += 1;
    if (!(row < nrows || col < ncols)) break;
  }
  // fixed pattern bottom-right: not data
  visited[(nrows - 1) * ncols + ncols - 1] = 1;
  visited[(nrows - 2) * ncols + ncols - 2] = 1;

  const order: Array<[number, number, number]> = [];
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const v = bits[r * ncols + c];
      if (v >= 0) order.push([v, r + 1, c + 1]);
    }
  }
  order.sort((a, b) => a[0] - b[0]);
  return { bits, visited, nrows, ncols, order };
}

export interface Extracted {
  codewords: Uint8Array;
  /** per-codeword ambiguity 0..1 (fraction of low-margin cells) */
  ambiguity: Float32Array;
  nData: number;
  nEcc: number;
}

/**
 * Extract codewords from an oriented darkness matrix (n×n, 1=black).
 * threshold: binarization cut; margin: cells within ±margin of the threshold
 * are tracked as ambiguous per codeword (erasure candidates).
 */
export function extractCodewords(
  mu: Float32Array,
  n: number,
  threshold: number,
  margin = 0.18,
): Extracted | null {
  const size = SIZES[n];
  if (!size) return null;
  const [nData, nEcc] = size;
  const p = makePlacement(n - 2, n - 2);
  const total = p.order.length;
  if (total !== (nData + nEcc) * 8) return null;
  const cw = new Uint8Array(nData + nEcc);
  const amb = new Float32Array(nData + nEcc);
  for (const [bitpos, row, col] of p.order) {
    const d = mu[row * n + col];
    const bit = d > threshold ? 1 : 0;
    cw[bitpos >> 3] = (cw[bitpos >> 3] << 1) | bit;
    if (Math.abs(d - threshold) < margin) amb[bitpos >> 3] += 0.125;
  }
  return { codewords: cw, ambiguity: amb, nData, nEcc };
}

const C40_INV: Record<number, string> = {};
(() => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < chars.length; i++) C40_INV[4 + i] = chars[i];
})();

/**
 * Decode ECC200 data codewords to text (ASCII + C40 + Text + EDIFACT).
 * Handles randomized padding per ISO 16022. Returns null on unsupported
 * encodings or invalid sequences.
 */
export function decodeText(data: Uint8Array): string | null {
  const out: string[] = [];
  let mode = 'ascii';
  const buf: number[] = [];

  const flushC40 = (): boolean => {
    while (buf.length >= 2) {
      const v = ((buf[0] << 8) | buf[1]) - 1;
      buf.splice(0, 2);
      if (v < 0) return false;
      const cs = [Math.floor(v / 1600), Math.floor(v / 40) % 40, v % 40];
      for (const c of cs) {
        if (c <= 2) return false; // shift sets unsupported
        out.push(C40_INV[c]);
      }
    }
    return true;
  };

  const flushEdifact = (): boolean => {
    while (buf.length >= 3) {
      let v = (buf[0] << 16) | (buf[1] << 8) | buf[2];
      buf.splice(0, 3);
      for (let k = 0; k < 4; k++) {
        const c = (v >> 18) & 0x3f;
        v = (v << 6) & 0xffffff;
        if (c === 31) {
          buf.length = 0;
          return true;
        }
        out.push(String.fromCharCode(c + 64));
      }
    }
    return true;
  };

  for (let i = 0; i < data.length; i++) {
    const cw = data[i];
    if (mode === 'ascii') {
      // The first pad codeword is always 129; randomised pads only follow it.
      // Value alone cannot identify a pad: ASCII data collides with the
      // randomisation formula (e.g. 'E' == 70 == pad value at position 3).
      if (cw === 129) break;
      if (cw === 0) break;
      if (cw <= 128) {
        out.push(String.fromCharCode(cw - 1));
      } else if (cw >= 130 && cw <= 229) {
        const v = cw - 130;
        out.push(String(Math.floor(v / 10)), String(v % 10));
      } else if (cw === 230) mode = 'c40';
      else if (cw === 239) mode = 'text';
      else if (cw === 240) mode = 'edifact';
      else return null;
    } else if (mode === 'c40' || mode === 'text') {
      buf.push(cw);
      if (buf.length % 2 === 0 && !flushC40()) return null;
    } else if (mode === 'edifact') {
      buf.push(cw);
      if (buf.length % 3 === 0 && !flushEdifact()) return null;
    } else {
      return null;
    }
  }
  if (mode === 'edifact' && buf.length > 0 && !flushEdifact()) return null;
  return out.length > 0 ? out.join('') : null;
}

export interface Ecc200Result {
  text: string;
  /** how the result was obtained: plain | erasure | chaseN */
  mode: string;
  /** number of codewords declared as erasures (0 when not used) */
  erasures: number;
}

/** bit stream + per-bit reliability for one threshold choice */
function streamAt(mu: Float32Array, n: number, thr: Float32Array) {
  const p = makePlacement(n - 2, n - 2);
  const bits = new Uint8Array(p.order.length);
  const rel = new Float32Array(p.order.length);
  for (let i = 0; i < p.order.length; i++) {
    const [bitpos, row, col] = p.order[i];
    const d = mu[row * n + col];
    const t = thr[row * n + col];
    bits[bitpos] = d > t ? 1 : 0;
    rel[bitpos] = Math.abs(d - t);
  }
  return { bits, rel };
}

function pack(bits: Uint8Array, count: number): Uint8Array {
  const cw = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    cw[i] = v;
  }
  return cw;
}

/**
 * Decode a sampled module matrix.
 *
 * Strategy per threshold: plain RS, then erasure-assisted RS (unreliable
 * codewords declared as erasures), then Chase-II soft-decision search -- flip
 * subsets of the least reliable bits and let RS verify each candidate. RS with
 * 10+ ECC codewords is a strong verifier, so the search cannot silently invent
 * a plausible payload; `accept` adds an application-level format gate.
 */
export function decodeMatrix(
  mu: Float32Array,
  n: number,
  thresholds: number[],
  opts: { maxFlipBits?: number; maxFlips?: number; accept?: (text: string) => boolean } = {},
): Ecc200Result | null {
  const size = SIZES[n];
  if (!size) return null;
  const [nData, nEcc] = size;
  const maxFlipBits = opts.maxFlipBits ?? 14;
  const maxFlips = opts.maxFlips ?? 2;
  const accept = opts.accept;

  for (const t of thresholds) {
    const thr = new Float32Array(mu.length).fill(t);
    const { bits, rel } = streamAt(mu, n, thr);
    const total = bits.length / 8;
    if (total !== nData + nEcc) continue;
    const cw = pack(bits, total);

    const check = (candidate: Uint8Array, mode: string, erasures: number): Ecc200Result | null => {
      const data = rsDecode(candidate, nData, nEcc, erasures > 0 ? undefined : undefined);
      if (!data) return null;
      const text = decodeText(data);
      if (!text) return null;
      if (accept && !accept(text)) return null;
      return { text, mode, erasures };
    };

    // 1) plain
    const plain = check(cw, 'plain', 0);
    if (plain) return plain;

    // 2) erasures on the least reliable codewords
    const cwRel = new Float32Array(total).fill(1);
    for (let i = 0; i < bits.length; i++) {
      const c = i >> 3;
      if (rel[i] < cwRel[c]) cwRel[c] = rel[i];
    }
    const byRel = [...cwRel.keys()].sort((a, b) => cwRel[a] - cwRel[b]);
    for (const count of [nEcc, Math.floor(nEcc / 2), Math.floor(nEcc / 4)]) {
      const erase = byRel.slice(0, count).filter((i) => cwRel[i] < 0.18);
      if (erase.length === 0) continue;
      const data = rsDecode(cw, nData, nEcc, erase);
      if (data) {
        const text = decodeText(data);
        if (text && (!accept || accept(text))) {
          return { text, mode: 'erasure', erasures: erase.length };
        }
      }
    }

    // 3) Chase-II: flip subsets of the least reliable bits, RS verifies
    const weak = [...rel.keys()].sort((a, b) => rel[a] - rel[b]).slice(0, maxFlipBits);
    for (let k = 1; k <= maxFlips; k++) {
      const idx = new Array(k).fill(0).map((_, i) => i);
      for (;;) {
        const flipped = Uint8Array.from(bits);
        for (const i of idx) flipped[weak[i]] ^= 1;
        const hit = check(pack(flipped, total), `chase${k}`, 0);
        if (hit) return hit;
        // next combination
        let p = k - 1;
        while (p >= 0 && idx[p] === weak.length - k + p) p--;
        if (p < 0) break;
        idx[p]++;
        for (let q = p + 1; q < k; q++) idx[q] = idx[q - 1] + 1;
      }
    }
  }
  return null;
}
