# Results

## Synthetic damage benchmark (test/bench.mjs)

Ground truth exact by construction: clean decodes of 22 corpus photos,
degraded with deterministic scratch/peel/glare simulation (3 variants x
4 severity levels each, 264 labeled samples).

| severity | decode rate | p50 | p95 |
|---------:|------------:|----:|----:|
| 0.2 | 100.0% (66/66) | 243 ms | 2104 ms |
| 0.4 |  98.5% (65/66) | 242 ms | 2084 ms |
| 0.6 |  98.5% (65/66) | 241 ms |  439 ms |
| 0.8 |  98.5% (65/66) | 158 ms | 1367 ms |
| **all** | **98.9% (261/264)** | | |

Raw JSON: results.json

## Real-world corpus (34 photos, 32 code-bearing)

- Stage A ladder: 26/32 = 81% (stock zxing-wasm baseline: 65%)
- The 6 remaining codes are physically destroyed beyond Reed-Solomon
  capacity: alignment search locks onto the grid, but the peel/scratch
  damage destroys more codewords than the ECC can correct (verified
  quantitatively with erasure decoding - the ambiguous cells alone exceed
  capacity in several cases).
- 2 of 34 images contain no DataMatrix and are correctly rejected.

## Browser

Verified in headless Chromium via demo page: intact seal decoded in
602 ms, heavily damaged seal in 8 s (native-resolution crop ladder).

## Benchmark caveat (honest)

The scratch/glare simulation does NOT discriminate stock vs dmtx-hard:
both score 96-100% on the synthetic samples because thin strokes stay
within Reed-Solomon capacity. The real discriminator is the photo corpus:
stock 69% vs dmtx-hard 86% on 29 code-bearing photos. A discriminating
synthetic benchmark would need contiguous module-scale destruction
(30-60% of the code area) - at that severity both approaches hit the RS
capacity wall.

## Library comparison (same 29 code-bearing photos)

| library | decode rate | error rate | p50 | p95 |
|---|---:|---:|---:|---:|
| OpenCV BarcodeDetector | 0/29 (0%) | 100% | ~0 ms | ~0 ms |
| zxing-wasm (stock) | 20/29 (69%) | 31% | ~240 ms | <1 s |
| libdmtx (8 s timeout) | 22/29 (76%) | 24% | 8000 ms | 8000 ms |
| **dmtx-hard** | **25/29 (86%)** | **13.8%** | **237 ms** | 75 s (budget cap) |

Notes: libdmtx runs each image until its timeout, so every miss costs 8 s;
dmtx-hard's p95 is its configurable rescue budget (tunable down for
latency-sensitive use). Commercial SDKs (Cognex, Keyence) not evaluated -
not available in this environment.

## Shield code (3-character payload) - the actual KPI

The seal carries two codes: a 3-character code on the coat-of-arms shield
(the one FINN needs) and a longer code right of it. Stock decoders almost
always return only the easy right-side code.

| library | shield code | any code | p50 |
|---|---:|---:|---:|
| OpenCV BarcodeDetector | 0/29 (0%) | 0/29 (0%) | ~0 ms |
| zxing-wasm (stock) | 2/29 (6.9%) | 19/29 (65.5%) | 31 ms |
| libdmtx (8 s timeout) | 3/29 (10.3%) | 22/29 (75.9%) | 8000 ms |
| **dmtx-hard** | **12/29 (41.4%)** | 25/29 (86.2%) | ~240 ms easy / 75 s hard |

dmtx-hard is 4-6x better on the shield KPI. Key mechanisms: no early exit
on the first (easier) code, yellow-sticker localisation prior for the
shield, and the erasure-capable ECC200 rescue decoder (FRP on IMG_2023 is
only reachable that way).

## Independent test set (Elixir-generated codes)

Codes encoded with the Elixir library `0x8b/datamatrix` - a third
implementation, independent of this project and of zxing - composited into
synthetic seals (yellow shield sticker, guilloche, heraldic clutter) and
damaged in graded steps: foil-peel strokes, glare, perspective, blur, noise.
300 samples across 5 damage levels, ground truth from the payload label.

### Decoder cross-check

This project's ECC200 implementation on the 400 raw generated symbols:
**400/400** - after fixing a real bug that the zxing-based tests could never
expose. A legitimate ASCII codeword (`'E'` = 70) collides with the randomised
pad value at position 3 of a 10x10 symbol, and the pad heuristic discarded it.
Correct rule: the first pad codeword is always 129, randomised pads only
follow it.

### Recognition vs damage

| damage | dmtx-hard | stock zxing | factor | ms/img |
|---|---:|---:|---:|---:|
| 0.0 | 100% | 100% | 1.0x | 26 |
| 0.2 | 100% | 92% | 1.1x | 26 |
| 0.4 | 97% | 67% | 1.4x | 258 |
| 0.6 | 88% | 32% | 2.8x | 1342 |
| 0.8 | 38% | 10% | 3.8x | 4276 |
| **all** | **84.7%** | 60.0% | 1.4x | |

Chase-II soft-decision decoding (flip subsets of the least reliable bits, RS
verifies each candidate) contributed +2 points overall, +5 at the hardest level.

### False positives

300 samples: **254 correct, 0 wrong, 46 no result** - including the 13 hits
from the rescue/Chase path. Reed-Solomon is a strict verifier (80 bits of
redundancy at 14x14), syndromes are re-checked after correction, and an
`accept` predicate gates the decoded text. The library stays silent rather
than guessing wrong, which is the right failure direction for deregistration
workflows. Caveat: 0/300 bounds the rate at ~1.2% (95% CI); ~3000 samples
would be required to claim <0.1%.
