import type { RgbaImage } from '@/contracts/index.ts';
import { letterboxParams } from '../postprocess.ts';
import type { ModelInput } from './backend.ts';

/**
 * Fit a frame into the model's square input, preserving aspect ratio.
 *
 * The alternative - squashing the frame to fit - is the tempting one because it
 * is three lines and the output looks fine. It is also wrong in a way nothing
 * downstream can detect: every box the model emits is distorted by the aspect
 * change, so redactions land near but not on the thing they were meant to cover.
 * A face box that misses by 15% still looks like a face box in the panel.
 *
 * So: scale by the smaller ratio, centre the result, pad the remainder. The
 * scale and padding go out with the pixels so `postprocess.undoLetterbox` can
 * invert exactly this transform rather than a recomputed approximation of it.
 *
 * Sampling is bilinear. Nearest-neighbour is faster and measurably worse for
 * small text and thin strokes, which is most of what matters on a form.
 */
export function letterboxImage(src: RgbaImage, target: number, fill = 0): ModelInput {
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error(`letterboxImage: target must be a positive number, got ${String(target)}`);
  }
  if (src.width <= 0 || src.height <= 0) {
    throw new Error(
      `letterboxImage: source must be non-empty, got ${String(src.width)}x${String(src.height)}`,
    );
  }

  const size = Math.round(target);
  // Same arithmetic the inverse mapping uses. Deliberately not reimplemented.
  const { scale, pad } = letterboxParams({ width: src.width, height: src.height }, size);

  const out = new Uint8ClampedArray(size * size * 4);
  if (fill !== 0) out.fill(fill);

  const left = Math.round(pad.left);
  const top = Math.round(pad.top);
  // Clamp so a rounding artefact can never write past the row or the buffer.
  const width = Math.min(Math.round(src.width * scale), size - left);
  const height = Math.min(Math.round(src.height * scale), size - top);

  const sw = src.width;
  const sh = src.height;

  for (let dy = 0; dy < height; dy++) {
    // Pixel centres, so the sampled grid is not shifted by half a pixel.
    const syRaw = (dy + 0.5) / scale - 0.5;
    const sy = syRaw < 0 ? 0 : syRaw > sh - 1 ? sh - 1 : syRaw;
    const y1 = Math.floor(sy);
    const y2 = y1 + 1 < sh ? y1 + 1 : sh - 1;
    const fy = sy - y1;
    const rowOut = (dy + top) * size;
    const row1 = y1 * sw;
    const row2 = y2 * sw;

    for (let dx = 0; dx < width; dx++) {
      const sxRaw = (dx + 0.5) / scale - 0.5;
      const sx = sxRaw < 0 ? 0 : sxRaw > sw - 1 ? sw - 1 : sxRaw;
      const x1 = Math.floor(sx);
      const x2 = x1 + 1 < sw ? x1 + 1 : sw - 1;
      const fx = sx - x1;

      const o = (rowOut + dx + left) * 4;
      const i11 = (row1 + x1) * 4;
      const i12 = (row1 + x2) * 4;
      const i21 = (row2 + x1) * 4;
      const i22 = (row2 + x2) * 4;

      for (let c = 0; c < 4; c++) {
        const p11 = src.data[i11 + c] ?? 0;
        const p12 = src.data[i12 + c] ?? 0;
        const p21 = src.data[i21 + c] ?? 0;
        const p22 = src.data[i22 + c] ?? 0;
        const a = p11 + (p12 - p11) * fx;
        const b = p21 + (p22 - p21) * fx;
        out[o + c] = a + (b - a) * fy;
      }
    }
  }

  return {
    rgba: { width: size, height: size, data: out },
    inputSize: size,
    scale,
    pad,
  };
}
