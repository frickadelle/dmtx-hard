/**
 * Corpus runner: decodes every image in /tmp/dmtx/corpus with the library and
 * prints a pass table. Runs the exact pipeline the browser uses (same TS
 * sources, same WASM decoder); only image file decoding is Node-specific.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { scanRGBA } from '../src/index.ts';

const DIR = '/tmp/dmtx/corpus';

// images that contain no DataMatrix at all (correct result: no hit)
const NO_CODE = new Set(['IMG_1663.png', 'IMG_1714.png']);

function decodeImage(path) {
  const buf = readFileSync(path);
  if (path.toLowerCase().endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  const jp = jpeg.decode(buf, { useTArray: true });
  return { data: jp.data, width: jp.width, height: jp.height };
}

const files = readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
const rescue = process.argv.includes('--rescue');
let ok = 0;
let codeFiles = 0;
const rows = [];
for (const f of files) {
  const t0 = Date.now();
  let hits = [];
  try {
    const img = decodeImage(`${DIR}/${f}`);
    hits = await scanRGBA(img.data, img.width, img.height, { rescue });
  } catch (e) {
    rows.push([f, 'ERR', String(e).slice(0, 60), 0]);
    continue;
  }
  const ms = Date.now() - t0;
  const isNoCode = NO_CODE.has(f);
  if (!isNoCode) codeFiles++;
  const good = isNoCode ? hits.length === 0 : hits.length > 0;
  if (good && !isNoCode) ok++;
  rows.push([f, good ? (isNoCode ? 'REJECT' : 'OK') : 'MISS',
             hits.map((h) => `${h.text}(${h.source})`).join(','), ms]);
}
for (const [f, tag, txt, ms] of rows) {
  console.log(`${tag.padEnd(6)} ${String(ms).padStart(6)}ms  ${f.padEnd(42)} ${txt}`);
}
console.log(`\n== ${ok}/${codeFiles} code-bearing files decoded (${(100 * ok / codeFiles).toFixed(0)}%) ==`);
