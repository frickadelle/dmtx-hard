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
