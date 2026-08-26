/**
 * @finn/dmtx-hard — robust DataMatrix scanning for damaged German
 * registration seals. Browser-first; also runs under Node for testing.
 *
 * Public API:
 *   scanImageData(imageData)  — browser canvas ImageData
 *   scanRGBA(data, w, h)      — raw RGBA buffer
 *   scanBlob(blob)            — File/Blob from <input type=file> or camera
 */
import { fromRGBA, resize, type Gray } from './image.ts';
import { scanChannels, scanGray, type Channels, type ScanHit, type ScanOptions } from './pipeline.ts';

export type { ScanHit, ScanOptions, Gray, Channels };
export { scanGray, scanChannels };

/** luma + HSV value channels, downscaled so the long edge is <= maxDim. */
export function toChannels(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxDim = 1600,
): Channels {
  const n = width * height;
  const gray = new Uint8Array(n);
  const value = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j];
    const g = data[j + 1];
    const b = data[j + 2];
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000 | 0;
    value[i] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
  // Native resolution is kept on purpose: seal codes are only ~100-200 px
  // wide in a 12 MP photo, so an early downscale destroys module detail.
  // The whole-frame pass downscales internally instead.
  return { gray: { data: gray, width, height }, value: { data: value, width, height } };
}

export async function scanRGBA(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts?: ScanOptions,
): Promise<ScanHit[]> {
  return scanChannels(toChannels(data, width, height, opts?.maxDim), opts);
}

export async function scanImageData(
  image: { data: Uint8ClampedArray; width: number; height: number },
  opts?: ScanOptions,
): Promise<ScanHit[]> {
  return scanChannels(toChannels(image.data, image.width, image.height, opts?.maxDim), opts);
}

/**
 * Decode an image Blob/File (browser). Uses createImageBitmap + OffscreenCanvas
 * so it works on the main thread and inside workers.
 */
export async function scanBlob(blob: Blob, opts?: ScanOptions): Promise<ScanHit[]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return scanChannels(toChannels(img.data, img.width, img.height, opts?.maxDim), opts);
}
