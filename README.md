# dmtx-hard

Robust DataMatrix scanning for damaged German vehicle-registration seals
(`Sicherheitsfahrrandkennzeichen`). Browser-first TypeScript library.

## Why

Stock decoders (zxing, libdmtx) fail on scratched/peeled seals because the
finder pattern is destroyed before Reed-Solomon ever runs. This library adds:

1. **Hypothesis ladder** — seal crops × colour channels × binarizations ×
   scales × mirror, each fed to `zxing-wasm` (stage A).
2. **Grid rescue + own ECC200 decoder** — when localization fails, the symbol
   grid is found by brute-force alignment search, the border is rebuilt from
   spec, and a from-scratch ECC200 decoder with **erasure support** recovers
   codes beyond stock RS capacity (stage B).

The ECC200 implementation (placement, RS params `prim=0x12d fcr=1`, ASCII/C40/
EDIFACT text, randomized padding) is verified bit-exact against zxing-generated
reference symbols.

## Usage

```ts
import { scanBlob, scanImageData } from './src/index.ts';

const hits = await scanBlob(file);          // File/Blob from camera or input
// hits: [{ text: 'W9510AO6', source: 'zxing' | 'rescue', recipe?, score? }]
```

Runs in the browser (WASM decoder + pure-TS image ops) and under Node for
testing.

## Test corpus

`test/corpus.mjs` expects photos in `/tmp/dmtx/corpus` (not committed —
they contain private vehicle data). Place PNG/JPG photos of seals there and
run:

```sh
npm test   # node test/corpus.mjs
```

Current status: see docs/results.md.
