/**
 * Synthetic benchmark: generates labeled hard variants from reliably-decoded
 * corpus images (scratch masks, glare) and measures decode rate vs damage
 * level. Ground truth is exact by construction: the clean decode of each
 * source image.
 *
 * Usage: node test/bench.mjs [--out results.json]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { scanRGBA } from '../src/index.ts';

const DIR = process.env.CORPUS_DIR ?? '/tmp/dmtx/corpus';

// no DataMatrix content, or documentation graphics rather than photos
const SKIP = new Set([
  'IMG_1663.png', 'IMG_1714.png',
  'kennzeichencode-rubbeln.jpg', 'Kennzeichencode-spiegelverkehrt.jpg',
]);

function decodeImage(path) {
  const buf = readFileSync(path);
  if (path.toLowerCase().endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  return jpeg.decode(buf, { useTArray: true });
}

/** deterministic PRNG so runs are comparable */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate scratch/peel damage: random light-grey scratch strokes and blobs
 * over the image centre (where the seal sits) plus optional glare.
 * severity 0..1 controls coverage.
 */
function damage(img, severity, rnd) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(data);
  const cx = w / 2;
  const cy = h / 2;
  const rad = Math.min(w, h) * 0.22;
  const strokes = Math.round(2 + severity * 14);
  for (let s = 0; s < strokes; s++) {
    const ang = rnd() * Math.PI * 2;
    const len = rad * (0.4 + rnd() * 1.1) * (0.4 + severity);
    const x0 = cx + (rnd() - 0.5) * rad * 1.4;
    const y0 = cy + (rnd() - 0.5) * rad * 1.4;
    const thick = 2 + rnd() * 10 * severity;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const steps = Math.round(len);
    for (let i = 0; i < steps; i++) {
      const px = Math.round(x0 + dx * i);
      const py = Math.round(y0 + dy * i);
      for (let ty = -thick; ty <= thick; ty++) {
        for (let tx = -thick; tx <= thick; tx++) {
          if (tx * tx + ty * ty > thick * thick) continue;
          const x = px + tx;
          const y = py + ty;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const j = (y * w + x) * 4;
          const v = 190 + rnd() * 50; // silver peel: bright, low contrast
          out[j] = out[j + 1] = out[j + 2] = v;
        }
      }
    }
  }
  if (rnd() < severity) {
    const gr = rad * (0.5 + rnd());
    const gx = cx + (rnd() - 0.5) * rad;
    const gy = cy + (rnd() - 0.5) * rad;
    for (let y = Math.max(0, gy - gr) | 0; y < Math.min(h, gy + gr); y++) {
      for (let x = Math.max(0, gx - gr) | 0; x < Math.min(w, gx + gr); x++) {
        const d = Math.hypot(x - gx, y - gy) / gr;
        if (d > 1) continue;
        const a = (1 - d) * 0.75 * severity;
        const j = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) out[j + c] = out[j + c] * (1 - a) + 255 * a;
      }
    }
  }
  return { data: out, width: w, height: h };
}

// ---- build source set: images that decode cleanly (stable ground truth) ----
const files = readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()
  .filter((f) => !SKIP.has(f));

const sources = [];
for (const f of files) {
  const img = decodeImage(`${DIR}/${f}`);
  const hits = await scanRGBA(img.data, img.width, img.height, { rescue: false, budgetMs: 6000 });
  const primary = hits.find((x) => /^[A-Z0-9]{6,10}$/.test(x.text));
  if (primary) sources.push({ file: f, truth: primary.text, img });
}
console.error(`sources with clean decode: ${sources.length}`);

// ---- benchmark: damage levels x variants ----
const LEVELS = [0.2, 0.4, 0.6, 0.8];
const VARIANTS_PER_LEVEL = 3;
const results = [];
let totalOk = 0;
let totalN = 0;

for (const level of LEVELS) {
  let ok = 0;
  let n = 0;
  const latencies = [];
  for (let v = 0; v < VARIANTS_PER_LEVEL; v++) {
    const rnd = mulberry32(1000 + Math.round(level * 100) * 31 + v);
    for (const src of sources) {
      const damaged = damage(src.img, level, rnd);
      const t0 = Date.now();
      let hit = null;
      try {
        const hits = await scanRGBA(damaged.data, damaged.width, damaged.height, { budgetMs: 6000, rescueBudgetMs: 15000 });
        hit = hits.find((x) => x.text === src.truth) ?? null;
      } catch { /* count as miss */ }
      latencies.push(Date.now() - t0);
      if (hit) ok++;
      n++;
    }
  }
  const lat = latencies.sort((a, b) => a - b);
  results.push({
    level,
    decoded: ok,
    total: n,
    rate: +(ok / n).toFixed(4),
    p50ms: lat[Math.floor(lat.length / 2)],
    p95ms: lat[Math.floor(lat.length * 0.95)],
  });
  totalOk += ok;
  totalN += n;
  console.error(`level ${level}: ${ok}/${n} = ${(100 * ok / n).toFixed(1)}%  p50 ${results.at(-1).p50ms}ms p95 ${results.at(-1).p95ms}ms`);
}

const summary = {
  date: new Date().toISOString(),
  sources: sources.map((s) => ({ file: s.file, truth: s.truth })),
  levels: LEVELS,
  variantsPerLevel: VARIANTS_PER_LEVEL,
  results,
  aggregate: { decoded: totalOk, total: totalN, rate: +(totalOk / totalN).toFixed(4) },
};
const outIdx = process.argv.indexOf('--out');
if (outIdx > 0) {
  writeFileSync(process.argv[outIdx + 1], JSON.stringify(summary, null, 2));
  console.error(`wrote ${process.argv[outIdx + 1]}`);
}
console.log(JSON.stringify(summary.aggregate));
