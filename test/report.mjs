/**
 * Generates docs/report.html: every corpus test photo with its decode result,
 * embedded as a self-contained page (base64 thumbnails).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { scanRGBA } from '../src/index.ts';

const DIR = process.env.CORPUS_DIR ?? '/tmp/dmtx/corpus';
const THUMBS = '/tmp/dmtx/thumbs';

const files = readdirSync(DIR).filter((f) => /^IMG_20.*\.png$/i.test(f)).sort();

const rows = [];
let ok = 0;
const t00 = Date.now();
for (const f of files) {
  const png = PNG.sync.read(readFileSync(`${DIR}/${f}`));
  const t0 = Date.now();
  let hits = [];
  try {
    hits = await scanRGBA(png.data, png.width, png.height, {});
  } catch (e) {
    rows.push({ file: f, ok: false, ms: Date.now() - t0, error: String(e).slice(0, 120) });
    continue;
  }
  const ms = Date.now() - t0;
  if (hits.length > 0) ok++;
  rows.push({
    file: f,
    ok: hits.length > 0,
    ms,
    results: hits.map((h) => ({ text: h.text, source: h.source, recipe: h.recipe ?? '', score: h.score })),
  });
  process.stderr.write(`${hits.length ? 'OK  ' : 'MISS'} ${f} ${ms}ms\n`);
}
const totalS = ((Date.now() - t00) / 1000).toFixed(1);

const cards = [];
for (const r of rows) {
  const thumb = existsSync(`${THUMBS}/${r.file.replace('.png', '.jpg')}`)
    ? readFileSync(`${THUMBS}/${r.file.replace('.png', '.jpg')}`).toString('base64')
    : '';
  const chips = r.ok
    ? r.results.map((h) =>
        `<span class="hit">${h.text}</span><span class="meta">${h.source}${h.recipe ? ' · ' + h.recipe : ''}</span>`,
      ).join(' ')
    : '<span class="miss">nicht erkannt</span>';
  cards.push(`
  <div class="card ${r.ok ? 'good' : 'bad'}">
    <img src="data:image/jpeg;base64,${thumb}" alt="${r.file}">
    <div class="info">
      <div class="file">${r.file}</div>
      <div class="chips">${chips}</div>
      <div class="time">${(r.ms / 1000).toFixed(1)} s</div>
    </div>
  </div>`);
}

const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>dmtx-hard Korpus-Report</title>
<style>
 body { font-family: -apple-system, sans-serif; background: #14161a; color: #e8e8e8; margin: 0; padding: 2rem; }
 h1 { font-size: 1.4rem; } .sum { color: #9ab; margin-bottom: 1.5rem; }
 .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
 .card { background: #1d2127; border-radius: 10px; overflow: hidden; border: 1px solid #2c313a; }
 .card.good { border-left: 4px solid #4a4; }
 .card.bad { border-left: 4px solid #a55; }
 img { width: 100%; display: block; }
 .info { padding: .6rem .8rem; }
 .file { font-size: .75rem; color: #889; margin-bottom: .3rem; }
 .hit { display: inline-block; background: #23331f; color: #9e9; border: 1px solid #4a4; border-radius: 5px; padding: .15rem .5rem; font-family: ui-monospace, monospace; font-size: .95rem; }
 .miss { color: #b77; }
 .meta { display: block; font-size: .65rem; color: #778; margin: .2rem 0 .4rem; word-break: break-all; }
 .time { font-size: .7rem; color: #778; }
</style></head><body>
<h1>dmtx-hard — Korpus-Report</h1>
<p class="sum">${ok}/${rows.length} erkannt (${(100 * ok / rows.length).toFixed(1)} %) · Fehlerquote ${(100 * (rows.length - ok) / rows.length).toFixed(1)} % · Gesamtzeit ${totalS} s · generiert ${new Date().toLocaleString('de-DE')}</p>
<div class="grid">${cards.join('\n')}</div>
</body></html>`;

writeFileSync('docs/report.html', html);
console.log(JSON.stringify({ ok, total: rows.length, rate: +(100 * ok / rows.length).toFixed(1) }));
