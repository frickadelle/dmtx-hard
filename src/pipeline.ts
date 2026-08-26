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
  /** stop after the first decoded code instead of collecting all */
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
          if (hits.length > 0 && opts.firstOnly !== false) return hits;
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
  for (const [px, py] of peaks) {
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

export async function scanChannels(ch: Channels, opts: ScanOptions = {}): Promise<ScanHit[]> {
  const hits = await stageA(ch, opts);
  if (hits.length > 0 || opts.rescue === false) return hits;
  return stageB(ch, opts);
}

export async function scanGray(gray: Gray, opts: ScanOptions = {}): Promise<ScanHit[]> {
  return scanChannels({ gray, value: gray }, opts);
}

export type { RescueHit };
