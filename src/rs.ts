/**
 * Reed-Solomon decoder over GF(256) with erasure support for ECC200.
 *
 * Field: prime poly 0x12d, generator α=2, fcr=1 (DataMatrix spec).
 * Algorithm: syndromes → erasure locator → Berlekamp-Massey error locator →
 * Forney syndromes → Chien search → error evaluator → magnitudes.
 */

const PRIM = 0x12d;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function div(a: number, b: number): number {
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function polyMul(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) {
      out[i + j] ^= mul(a[i], b[j]);
    }
  }
  return out;
}

function polyEval(p: number[], x: number): number {
  // p[0] = highest-degree coefficient
  let y = p[0];
  for (let i = 1; i < p.length; i++) {
    y = mul(y, x) ^ p[i];
  }
  return y;
}

/**
 * Decode a codeword array (data + ecc). erasePos: indices of known-bad
 * codewords. Returns corrected data portion or null.
 */
export function rsDecode(
  cw: Uint8Array,
  nData: number,
  nEcc: number,
  erasePos?: number[],
): Uint8Array | null {
  if (cw.length !== nData + nEcc) return null;
  const msg = Array.from(cw);

  const eraseCount = erasePos?.length ?? 0;
  if (eraseCount > nEcc) return null;

  // syndromes S_j = C(α^(fcr+j)) for j = 0..nEcc-1
  const syndromes: number[] = [];
  for (let j = 0; j < nEcc; j++) {
    let s = 0;
    for (let i = 0; i < msg.length; i++) {
      // msg[0] is highest degree (len-1)
      s = mul(s, EXP[(1 + j) % 255]) ^ msg[i];
    }
    syndromes.push(s);
  }
  if (syndromes.every((s) => s === 0)) {
    return Uint8Array.from(msg.slice(0, nData));
  }

  // erasure locator: Λ(x) = Π (1 - X_i x) with X_i = α^(pos_i)
  let errLoc: number[] = [1];
  if (eraseCount > 0) {
    for (const pos of erasePos) {
      const Xi = EXP[(pos + 1) % 255]; // degree of position pos = len-1-pos → α^(len-1-pos - (len-1-nEcc)) = α^(nEcc-1-(pos-... simplified below
      // For syndrome index j (α^(1+j)) and codeword degree d = len-1:
      // error position exponent: e = len - 1 - pos; X = α^e
      const e = msg.length - 1 - pos;
      const X = EXP[e % 255];
      errLoc = polyMul(errLoc, [1, X]);
    }
  }

  // Forney syndromes: remove erasure influence
  let forney = syndromes.slice();
  if (eraseCount > 0) {
    // Ω_forney = S(x) * Λ(x) mod x^nEcc
    const prod = polyMul(syndromes, errLoc);
    forney = prod.slice(prod.length - nEcc);
  }

  // Berlekamp-Massey on Forney syndromes to find error locator additions
  // Combined locator: start from erasure locator, BM adjusts.
  // Standard approach: run modified BM with erasures accounted.
  let C = errLoc.slice(); // current locator, C[0] = 1
  let B = errLoc.slice(); // previous
  let L = eraseCount;
  let m = 1;
  let b = 1;
  for (let nn = 0; nn < nEcc; nn++) {
    // discrepancy
    let d = forney[nn] ?? 0;
    for (let i = 1; i <= L; i++) {
      if (C[i] && forney[nn - i] !== undefined) {
        d ^= mul(C[i], forney[nn - i]);
      }
    }
    if (d === 0) {
      m++;
    } else if (2 * L <= nn) {
      const T = C.slice();
      const coef = mul(d, div(1, b));
      // C(x) = C(x) - (d/b) x^m B(x)
      const shiftedB = new Array(m).fill(0).concat(B);
      for (let i = 0; i < shiftedB.length; i++) {
        if (C[i] === undefined) C[i] = 0;
        C[i] ^= mul(coef, shiftedB[i] ?? 0);
      }
      L = nn + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      const coef = mul(d, div(1, b));
      const shiftedB = new Array(m).fill(0).concat(B);
      for (let i = 0; i < shiftedB.length; i++) {
        if (C[i] === undefined) C[i] = 0;
        C[i] ^= mul(coef, shiftedB[i] ?? 0);
      }
      m++;
    }
  }

  const numErrors = L - eraseCount;
  if (numErrors < 0 || numErrors * 1 + eraseCount > nEcc) return null;
  if (2 * numErrors + eraseCount > nEcc) return null;

  // Chien search: roots of C
  const positions: number[] = [];
  for (let i = 0; i < msg.length; i++) {
    // degree of position i = len-1-i; root when C(α^-(len-1-i)) == 0
    const e = msg.length - 1 - i;
    if (polyEval(C, EXP[(255 - (e % 255)) % 255]) === 0) {
      positions.push(i);
    }
  }
  const errorPositions = positions.filter((p) => !erasePos?.includes(p));
  if (errorPositions.length !== numErrors) return null;

  // error evaluator Ω = S(x)·C(x) mod x^nEcc
  const omega = polyMul(syndromes, C).slice(-nEcc);

  // Forney: Y_i = X_i^(1-fcr) · Ω(X_i^-1) / Λ'(X_i^-1)
  const derivative: number[] = [];
  for (let i = 1; i < C.length; i += 2) {
    derivative.push(C[i]);
  }
  for (const pos of positions) {
    const e = msg.length - 1 - pos;
    const Xi = EXP[e % 255];
    const XiInv = EXP[(255 - (e % 255)) % 255];
    let num = polyEval(omega, XiInv);
    // multiply by X_i^(1-fcr) → fcr=1 → factor 1
    let den = 0;
    // Λ'(x): formal derivative — only odd-power terms survive in char 2
    for (let i = 0; i < derivative.length; i++) {
      // term degree 2i+1 → evaluate at XiInv with power (2i+1)
      den ^= mul(derivative[i], EXP[((255 - (e % 255)) * (2 * i + 1)) % 255]);
    }
    if (den === 0) return null;
    const mag = div(num, den);
    msg[pos] ^= mag;
  }

  // final verify
  for (let j = 0; j < nEcc; j++) {
    let s = 0;
    for (let i = 0; i < msg.length; i++) {
      s = mul(s, EXP[(1 + j) % 255]) ^ msg[i];
    }
    if (s !== 0) return null;
  }
  return Uint8Array.from(msg.slice(0, nData));
}
