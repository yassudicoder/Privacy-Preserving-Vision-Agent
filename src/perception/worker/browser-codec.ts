import type { RgbaImage } from '@/contracts/index.ts';
import type { FrameCodec } from './backend.ts';

/**
 * Turns a captured data URL into pixels, using the DOM.
 *
 * WHERE THIS CAN RUN: the Chrome offscreen document, or the Firefox background
 * event page. Both have a real `document`. It CANNOT run in a Chrome MV3 service
 * worker, which is exactly why the offscreen document exists.
 *
 * BROWSER-ONLY, AND THEREFORE UNTESTED IN NODE. There is no canvas under vitest,
 * so nothing here is covered by `npm test`. That is the reason `FrameCodec` is an
 * interface at all: every consumer of it is tested against a fake, and the
 * untestable part is kept to this one small file with no logic in it worth
 * testing. Treat changes here as unverified until run in a browser.
 */
export class BrowserFrameCodec implements FrameCodec {
  async decode(dataUrl: string): Promise<RgbaImage> {
    // fetch() parses the data URL for us, including base64, rather than
    // hand-rolling a decoder that would have to get padding right.
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);

    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;

      // willReadFrequently: this canvas exists only to be read back, and the
      // default GPU-backed path makes getImageData markedly slower.
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx === null) throw new Error('BrowserFrameCodec: 2d context unavailable');

      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: image.width, height: image.height, data: image.data };
    } finally {
      // Releases the decoded bitmap immediately rather than waiting for GC.
      // Resource use is 20% of the score and these are multi-megabyte objects.
      bitmap.close();
    }
  }
}
