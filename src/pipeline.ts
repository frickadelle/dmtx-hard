/**
 * Full DataMatrix scan pipeline for damaged German registration seals.
 *
 * Stage A: hypothesis ladder over seal crops × channels × binarizations ×
 *          scales × mirror, each fed to the zxing-wasm decoder.
 * Stage B: grid-rescue search + own ECC200 decoder with erasure support, for
 *          codes whose finder pattern is physically destroyed.
 */
import { readBarcodes } from 'zxing-wasm/reader';
import {
  type Gray,
  resize,
  crop,
  flipH,
  otsuBin,
  adaptiveThresholdMean,
} from './image.ts';

/**
 * Centroid of the largest yellow region (the seal's coat-of-arms sticker).
 * The shield DataMatrix always sits on it, making yellow a strong localisation
 * prior that heraldry-textured grey-scale peaks lack.
 */
function yellowCentroid(rgb: Uint8Array | Uint8ClampedArray, width: number, height: number): { x: number; y: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.round(Math.min(width, height) / 500));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const j = (y * width + x) * 4;
      const r = rgb[j];
      const g = rgb[j + 1];
      const b = rgb[j + 2];
      // sticker yellow: r≈g, both well above blue; rejects the gold rim (r>g)
      if (Math.abs(r - g) > 40 || g - b < 40 || g < 110 || r < 110) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 20) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  return { x: xs[xs.length >> 1], y: ys[ys.length >> 1] }; // median: robust to outliers
}
import { rescueScan, densityPeaks, normalize } from './rescue.ts';
import type { RescueHit } from './rescue.ts';
import { decodeMatrix } from './ecc200.ts';

export interface ScanHit {
  text: string;
  source: 'zxing' | 'rescue';
  recipe?: string;
  score?: number;
}

export interface ScanOptions {
  /** max dimension for the stage-A base image */
  maxDim?: number;
  /** run the expensive grid-rescue stage when stage A finds nothing */
  rescue?: boolean;
  /** stop at the first decoded code (fast, but may miss the shield code) */
  firstOnly?: boolean;
  /** wall-clock budget for the stage-A ladder in ms (default 15000) */
  budgetMs?: number;
  /** wall-clock budget for the stage-B rescue in ms (default 60000) */
  rescueBudgetMs?: number;
  verbose?: boolean;
}

export interface Channels {
  /** luma */
  gray: Gray;
  /** HSV value = max(r,g,b); survives coloured overprints better */
  value: Gray;
  /** optional RGBA source for colour priors (yellow sticker) */
  rgba?: Uint8Array | Uint8ClampedArray;
}

function asImageData(g: Gray) {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = g.data[i];
    out[j + 3] = 255;
  }
  return { data: out, width: g.width, height: g.height, colorSpace: 'srgb' as const };
}

async function decodeOne(g: Gray): Promise<string[]> {
  try {
    const res = await readBarcodes(asImageData(g) as never, {
      formats: ['DataMatrix'],
      tryDownscale: true,
      tryInvert: true,
      tryRotate: true,
    });
    return res.filter((r) => r.text).map((r) => r.text);
  } catch {
    return [];
  }
}

/** Binarization variants for one channel image, cheapest first. */
function* variants(img: Gray, set: 'fast' | 'all'): Generator<[string, Gray]> {
  yield ['raw', img];
  yield ['otsu', otsuBin(img)];
  yield ['ad61', adaptiveThresholdMean(img, 61, 9)];
  if (set === 'all') {
    yield ['ad31', adaptiveThresholdMean(img, 31, 9)];
    yield ['ad121', adaptiveThresholdMean(img, 121, 9)];
  }
}

interface Region {
  name: string;
  ch: Channels;
  scales: number[];
  set: 'fast' | 'all';
}

/**
 * Candidate regions ordered by cost: cheap whole-frame pass first, then
 * native-resolution crops around texture-density peaks, then expensive
 * upscaled passes. Native crops matter because a 12 MP seal photo carries
 * codes only ~150 px wide; a global downscale destroys module detail.
 */
function regions(ch: Channels, maxDim: number): Region[] {
  const { gray, value } = ch;
  const minDim = Math.min(gray.width, gray.height);
  const fscale = Math.min(1, maxDim / Math.max(gray.width, gray.height));
  if (ch.rgba) {
    const yc = yellowCentroid(ch.rgba, gray.width, gray.height);
    if (yc) {
      const out0: Region[] = [];
      for (const frac of [0.07, 0.13]) {
        const half = Math.round(minDim * frac);
        if (half < 40) continue;
        out0.push({
          name: `yellow@${Math.round(yc.x)},${Math.round(yc.y)}/${frac}`,
          ch: {
            gray: crop(gray, yc.x - half, yc.y - half, yc.x + half, yc.y + half),
            value: crop(value, yc.x - half, yc.y - half, yc.x + half, yc.y + half),
          },
          scales: [1, 1.8],
          set: 'all',
        });
      }
      return [...out0, ...regionsWithoutYellow(ch, maxDim)];
    }
  }
  return regionsWithoutYellow(ch, maxDim);
}

function regionsWithoutYellow(ch: Channels, maxDim: number): Region[] {
  const { gray, value } = ch;
  const minDim = Math.min(gray.width, gray.height);
  const fscale = Math.min(1, maxDim / Math.max(gray.width, gray.height));
  const full: Channels = fscale < 1
    ? {
        gray: resize(gray, Math.round(gray.width * fscale), Math.round(gray.height * fscale)),
        value: resize(value, Math.round(value.width * fscale), Math.round(value.height * fscale)),
      }
    : ch;
  const up = fscale < 1 ? 1 / fscale : 1;
  const peaks = densityPeaks(
    normalize(full.gray),
    4,
    Math.max(8, Math.round(Math.min(full.gray.width, full.gray.height) / 28)),
  );
  const cropAt = (cx: number, cy: number, half: number): Channels => ({
    gray: crop(gray, cx - half, cy - half, cx + half, cy + half),
    value: crop(value, cx - half, cy - half, cx + half, cy + half),
  });

  const out: Region[] = [{ name: 'full', ch: full, scales: [1], set: 'fast' }];
  for (const frac of [0.09, 0.16]) {
    const half = Math.round(minDim * frac);
    if (half < 40) continue;
    for (const [px, py] of peaks) {
      out.push({
        name: `peak@${Math.round(px * up)},${Math.round(py * up)}/${frac}`,
        ch: cropAt(px * up, py * up, half),
        scales: [1, 1.8],
        set: 'all',
      });
    }
  }
  for (const frac of [0.28, 0.45]) {
    const half = Math.round(minDim * frac);
    for (const [px, py] of peaks.slice(0, 2)) {
      out.push({
        name: `peak@${Math.round(px * up)},${Math.round(py * up)}/${frac}`,
        ch: cropAt(px * up, py * up, half),
        scales: [1],
        set: 'all',
      });
    }
  }
  out.push({ name: 'full-up', ch: full, scales: [2, 4], set: 'all' });
  return out;
}

async function stageA(ch: Channels, opts: ScanOptions): Promise<ScanHit[]> {
  const hits: ScanHit[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + (opts.budgetMs ?? 15000);
  for (const region of regions(ch, opts.maxDim ?? 1600)) {
    if (Date.now() > deadline) break;
    for (const scale of region.scales) {
      const w = Math.round(region.ch.gray.width * scale);
      const h = Math.round(region.ch.gray.height * scale);
      if (Math.max(w, h) > 3200 || Math.min(w, h) < 24) continue;
      for (const [cname, base] of [['gray', region.ch.gray], ['value', region.ch.value]] as const) {
        const scaled = scale === 1 ? base : resize(base, w, h);
        for (const [vname, v] of variants(scaled, region.set)) {
          for (const mirror of [false, true]) {
            const img = mirror ? flipH(v) : v;
            for (const text of await decodeOne(img)) {
              if (seen.has(text)) continue;
              seen.add(text);
              hits.push({
                text,
                source: 'zxing',
                recipe: `${region.name}/${cname}/${vname}/s${scale}${mirror ? '/mirror' : ''}`,
              });
            }
          }
          // stop as soon as the priority target (shield code) is found
          if (hits.length > 0 && (opts.firstOnly || hits.some(isShieldHit))) return hits;
          if (Date.now() > deadline) return hits;
        }
      }
    }
  }
  return hits;
}

/**
 * Scan pre-split channels for DataMatrix codes.
 */
/** Run the grid rescue on the most promising native-resolution crops. */
async function stageB(ch: Channels, opts: ScanOptions): Promise<ScanHit[]> {
  const thresholds: number[] = [];
  for (let t = 0.3; t <= 0.75; t += 0.05) thresholds.push(t);
  const minDim = Math.min(ch.gray.width, ch.gray.height);
  const fscale = Math.min(1, (opts.maxDim ?? 1600) / Math.max(ch.gray.width, ch.gray.height));
  const full: Gray = fscale < 1
    ? resize(ch.gray, Math.round(ch.gray.width * fscale), Math.round(ch.gray.height * fscale))
    : ch.gray;
  const up = fscale < 1 ? 1 / fscale : 1;
  const peaks = densityPeaks(
    normalize(full),
    3,
    Math.max(8, Math.round(Math.min(full.width, full.height) / 28)),
  );
  const rescueHits: ScanHit[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + (opts.rescueBudgetMs ?? 60000);
  const targets: Array<[number, number]> = [];
  if (ch.rgba) {
    const yc = yellowCentroid(ch.rgba, ch.gray.width, ch.gray.height);
    if (yc) targets.push([yc.x, yc.y]);
  }
  for (const [px, py] of [...targets, ...peaks]) {
    for (const frac of [0.09, 0.16]) {
      const half = Math.round(minDim * frac);
      if (half < 40) continue;
      if (Date.now() > deadline) return rescueHits;
      const region = crop(ch.gray, px * up - half, py * up - half, px * up + half, py * up + half);
      await rescueScan(
        region,
        async (mu, n) => {
          const r = decodeMatrix(mu, n, thresholds);
          if (!r) return null;
          if (!seen.has(r.text)) {
            seen.add(r.text);
            rescueHits.push({ text: r.text, source: 'rescue', score: r.corrected });
          }
          return r.text;
        },
        { verbose: opts.verbose, deadline },
      );
      if (rescueHits.length > 0 || Date.now() > deadline) return rescueHits;
    }
  }
  return rescueHits;
}

const SHIELD_RE = /^[A-Za-z0-9]{3}$/;

/** shield codes are the 3-character payloads printed on the coat of arms */
const isShieldHit = (h: ScanHit) => SHIELD_RE.test(h.text);

/**
 * Scan channels for DataMatrix codes. By default the whole hypothesis ladder
 * runs (no early exit) so the 3-character shield code is found even when the
 * easier right-side code decodes first; shield codes sort first.
 */
export async function scanChannels(ch: Channels, opts: ScanOptions = {}): Promise<ScanHit[]> {
  const hits = await stageA(ch, opts);
  if (opts.firstOnly && hits.length > 0) return hits;
  if (hits.some((h) => SHIELD_RE.test(h.text))) {
    hits.sort((a, b) => Number(SHIELD_RE.test(b.text)) - Number(SHIELD_RE.test(a.text)));
    return hits;
  }
  const rescue = opts.rescue === false ? [] : await stageB(ch, opts);
  const all = [...rescue, ...hits];
  all.sort((a, b) => Number(SHIELD_RE.test(b.text)) - Number(SHIELD_RE.test(a.text)));
  return all;
}

export async function scanGray(gray: Gray, opts: ScanOptions = {}): Promise<ScanHit[]> {
  return scanChannels({ gray, value: gray }, opts);
}

export type { RescueHit };
