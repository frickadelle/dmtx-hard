/**
 * Benchmark on the independent synthetic seal set (codes encoded by the Elixir
 * library, ground truth from the filename). Compares the full pipeline against
 * the stock decoder on identical samples.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { readBarcodes } from 'zxing-wasm/reader';
import { scanRGBA, toChannels } from '../src/index.ts';

const ROOT = process.env.SET_DIR ?? '/tmp/dmtx/gen/set';
const levels = readdirSync(ROOT).filter((d) => /^[\d.]+$/.test(d)).sort();

async function stock(img) {
  const ch = toChannels(img.data, img.width, img.height, 1600);
  const g = ch.gray;
  const rgba = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    rgba[j] = rgba[j + 1] = rgba[j + 2] = g.data[i];
    rgba[j + 3] = 255;
  }
  try {
    const r = await readBarcodes({ data: rgba, width: g.width, height: g.height },
      { formats: ['DataMatrix'], tryDownscale: true, tryInvert: true, tryRotate: true });
    return r.filter((x) => x.text).map((x) => x.text);
  } catch { return []; }
}

const table = [];
for (const level of levels) {
  const files = readdirSync(`${ROOT}/${level}`).filter((f) => f.endsWith('.png')).sort();
  let okOurs = 0, okStock = 0, n = 0, tOurs = 0;
  for (const f of files) {
    const truth = f.replace('.png', '').split('_')[1];
    const png = PNG.sync.read(readFileSync(`${ROOT}/${level}/${f}`));
    const img = { data: png.data, width: png.width, height: png.height };
    const t0 = Date.now();
    let ours = [];
    try {
      ours = (await scanRGBA(img.data, img.width, img.height,
        { budgetMs: 3000, rescueBudgetMs: 6000 })).map((h) => h.text);
    } catch {}
    tOurs += Date.now() - t0;
    const st = await stock(img);
    if (ours.includes(truth)) okOurs++;
    if (st.includes(truth)) okStock++;
    n++;
  }
  table.push({ level, n, ours: okOurs, stock: okStock, msOurs: Math.round(tOurs / n) });
  console.error(`level ${level}: ours ${okOurs}/${n} (${(100*okOurs/n).toFixed(0)}%)  stock ${okStock}/${n} (${(100*okStock/n).toFixed(0)}%)  ${Math.round(tOurs/n)} ms/img`);
}
const sum = table.reduce((a, r) => ({ n: a.n + r.n, ours: a.ours + r.ours, stock: a.stock + r.stock }), { n: 0, ours: 0, stock: 0 });
console.log(JSON.stringify({ table, total: { ...sum, oursRate: +(sum.ours / sum.n).toFixed(3), stockRate: +(sum.stock / sum.n).toFixed(3) } }, null, 2));
