import type { PixelRedactionOp, RgbaImage } from '@/contracts/index.ts';
import { bakeRedactions } from './canvas-redact.ts';

/**
 * The browser half of pixel redaction: encoding.
 *
 * `canvas-redact.ts` is pure and fully tested in Node - it writes pixels into a
 * buffer and knows nothing about images. The only environment-specific step is
 * turning that buffer back into JPEG bytes, which is this file.
 *
 * WHY toDataURL AND NOT convertToBlob: `ImageEncoder` is synchronous, because
 * `bakeRedactions` is synchronous, because making it async would make the single
 * minting point of `BakedScreenshot` async and infect every caller.
 * `OffscreenCanvas.convertToBlob()` is a Promise; `HTMLCanvasElement.toDataURL()`
 * is not. Both contexts that bake - the Chrome offscreen document and the
 * Firefox background page - have a real `document`, so the synchronous path is
 * available and is the one that fits.
 *
 * BROWSER-ONLY, AND THEREFORE UNTESTED IN NODE: vitest has no canvas. The logic
 * worth testing is all in canvas-redact.ts, which this delegates to; what is
 * left here is the encode call. Unverified until run in a browser.
 */

export interface BrowserBakeResult {
  readonly base64: string;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
  readonly opsApplied: number;
  readonly opsOutsideFrame: number;
  readonly opsRequested: number;
}

/**
 * Builds the `BakeFn` the worker runtime expects.
 *
 * Returned rather than exported as a plain function so the canvas is created per
 * call and never retained: holding one alive would keep a full-frame backing
 * store resident between agent steps.
 */
/**
 * @param maxEdgePx Longest edge of the ENCODED image. Redaction happens at full
 * resolution first and the result is shrunk for transmission - doing it the
 * other way round would move every box relative to the pixels it covers.
 *
 * This is what finally applies `maxEdgePx`. `downscaleFactor` was written for it
 * and never called, so a screenshot went to the server at full viewport size:
 * ~110 KB of base64 and, for a vision model, one to two thousand image tokens
 * per step. On a 6 GB laptop GPU already holding a 3B VLM, that is the
 * difference between fitting and not.
 */
export function createBrowserBake(
  maxEdgePx = 0,
): (
  img: RgbaImage,
  ops: readonly PixelRedactionOp[],
  quality: number,
) => BrowserBakeResult {
  return (img, ops, quality) => {
    const { screenshot } = bakeRedactions(img, ops, (out) => {
      const canvas = document.createElement('canvas');
      canvas.width = out.width;
      canvas.height = out.height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('createBrowserBake: 2d context unavailable');

      // createImageData rather than `new ImageData(out.data, ...)`: the
      // constructor's type demands a plain ArrayBuffer, and our buffer is typed
      // as ArrayBufferLike. This also makes the copy explicit rather than
      // implied.
      const image = ctx.createImageData(out.width, out.height);
      image.data.set(out.data);
      ctx.putImageData(image, 0, 0);

      /*
       * Shrink for transmission, AFTER the redaction pixels are in place.
       * `drawImage` with a smaller destination is the resample.
       */
      const longest = Math.max(out.width, out.height);
      const scale = maxEdgePx > 0 && longest > maxEdgePx ? maxEdgePx / longest : 1;
      let encodeFrom = canvas;
      if (scale < 1) {
        const small = document.createElement('canvas');
        small.width = Math.max(1, Math.round(out.width * scale));
        small.height = Math.max(1, Math.round(out.height * scale));
        const sctx = small.getContext('2d');
        if (sctx !== null) {
          sctx.drawImage(canvas, 0, 0, small.width, small.height);
          encodeFrom = small;
        }
      }

      // quality is 0-100 in CaptureOptions; toDataURL wants 0-1.
      const url = encodeFrom.toDataURL('image/jpeg', Math.max(0, Math.min(100, quality)) / 100);
      // Strip the "data:image/jpeg;base64," prefix - the field is named base64
      // and the server contract expects payload bytes, not a URL.
      const comma = url.indexOf(',');
      return { base64: comma === -1 ? url : url.slice(comma + 1), format: 'jpeg' };
    });

    return {
      base64: screenshot.base64,
      format: screenshot.format,
      width: screenshot.width,
      height: screenshot.height,
      opsApplied: screenshot.opsApplied,
      opsOutsideFrame: screenshot.opsOutsideFrame,
      opsRequested: screenshot.opsRequested,
    };
  };
}
