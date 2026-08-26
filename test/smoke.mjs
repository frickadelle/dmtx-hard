import { readFileSync } from 'node:fs';
import { readBarcodes } from 'zxing-wasm/reader';
const png = new Uint8Array(readFileSync('/tmp/dmtx/corpus/IMG_2028.png'));
for (const opts of [{}, { formats: ['DataMatrix'] }, { tryDownscale: true }]) {
  const res = await readBarcodes(png, opts);
  console.log(JSON.stringify(opts), '->', res.map(r => r.text));
}
