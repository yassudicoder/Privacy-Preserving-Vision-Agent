import { describe, expect, it } from 'vitest';
import { createImage } from '@/redaction/index.ts';
import { letterboxImage, letterboxParams } from '@/perception/index.ts';

/**
 * Letterboxing is where detection accuracy is quietly lost.
 *
 * The model wants a square input. The frame is not square. Squashing it to fit
 * distorts every box the model emits, and the distortion is invisible in the
 * output: boxes still look plausible, they just land on the wrong pixels. So the
 * frame is scaled preserving aspect and the remainder padded, and `postprocess.
 * undoLetterbox` inverts it afterwards.
 *
 * `letterboxParams` (already tested) does the arithmetic. This is the pixel
 * half: it must agree with that arithmetic exactly, or the inverse mapping is
 * computed against different numbers than the forward one.
 */

/** Solid-colour helper: fills an RGBA image with one colour. */
function solid(width: number, height: number, r: number, g: number, b: number): ReturnType<typeof createImage> {
  const img = createImage(width, height);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = 255;
  }
  return img;
}

function pixelAt(
  img: ReturnType<typeof createImage>,
  x: number,
  y: number,
): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o] ?? -1, img.data[o + 1] ?? -1, img.data[o + 2] ?? -1, img.data[o + 3] ?? -1];
}

describe('letterboxImage produces the shape the model demands', () => {
  it('always emits a square of exactly the requested size', () => {
    for (const [w, h] of [
      [100, 50],
      [50, 100],
      [64, 64],
      [1280, 720],
      [3, 7],
    ] as const) {
      const out = letterboxImage(solid(w, h, 10, 20, 30), 64);
      expect(out.rgba.width, `${w}x${h}`).toBe(64);
      expect(out.rgba.height, `${w}x${h}`).toBe(64);
      expect(out.inputSize).toBe(64);
      expect(out.rgba.data.length).toBe(64 * 64 * 4);
    }
  });

  it('agrees with letterboxParams exactly', () => {
    // If these two ever disagree, undoLetterbox inverts the wrong transform and
    // every redaction lands slightly off. Same numbers, or nothing works.
    for (const [w, h] of [
      [100, 50],
      [37, 91],
      [640, 480],
    ] as const) {
      const expected = letterboxParams({ width: w, height: h }, 128);
      const out = letterboxImage(solid(w, h, 1, 2, 3), 128);
      expect(out.scale, `${w}x${h} scale`).toBeCloseTo(expected.scale, 10);
      expect(out.pad.left, `${w}x${h} pad.left`).toBeCloseTo(expected.pad.left, 10);
      expect(out.pad.top, `${w}x${h} pad.top`).toBeCloseTo(expected.pad.top, 10);
    }
  });

  it('pads a wide frame vertically and a tall frame horizontally', () => {
    const wide = letterboxImage(solid(100, 50, 255, 0, 0), 100);
    expect(wide.pad.left).toBeCloseTo(0, 10);
    expect(wide.pad.top).toBeCloseTo(25, 10);

    const tall = letterboxImage(solid(50, 100, 255, 0, 0), 100);
    expect(tall.pad.top).toBeCloseTo(0, 10);
    expect(tall.pad.left).toBeCloseTo(25, 10);
  });

  it('leaves a square frame unpadded', () => {
    const out = letterboxImage(solid(80, 80, 9, 9, 9), 40);
    expect(out.pad.left).toBeCloseTo(0, 10);
    expect(out.pad.top).toBeCloseTo(0, 10);
    expect(out.scale).toBeCloseTo(0.5, 10);
  });

  it('fills the padding with the fill value and the content with the image', () => {
    // Red 100x50 into a 100x100 square: rows 0-24 and 75-99 are padding.
    const out = letterboxImage(solid(100, 50, 255, 0, 0), 100, 0);

    expect(pixelAt(out.rgba, 50, 2)).toEqual([0, 0, 0, 0]); // top padding
    expect(pixelAt(out.rgba, 50, 97)).toEqual([0, 0, 0, 0]); // bottom padding

    const [r, g, b, a] = pixelAt(out.rgba, 50, 50); // centre = content
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    expect(a).toBe(255);
  });

  it('preserves aspect ratio rather than squashing', () => {
    /*
     * Two vertical bands, left green right blue, in a 2:1 frame. After
     * letterboxing into a square the boundary must still sit at the horizontal
     * midpoint of the CONTENT, and the content must occupy exactly half the
     * square's height. A squash-to-fit would fill the whole square instead.
     */
    const src = createImage(200, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 200; x++) {
        const o = (y * 200 + x) * 4;
        src.data[o] = 0;
        src.data[o + 1] = x < 100 ? 255 : 0;
        src.data[o + 2] = x < 100 ? 0 : 255;
        src.data[o + 3] = 255;
      }
    }

    const out = letterboxImage(src, 100, 0);
    expect(out.scale).toBeCloseTo(0.5, 10);
    expect(out.pad.top).toBeCloseTo(25, 10);

    // Content band is rows 25..74. Sample inside it, either side of centre.
    const [, gL, bL] = pixelAt(out.rgba, 20, 50);
    expect(gL).toBeGreaterThan(200);
    expect(bL).toBeLessThan(60);

    const [, gR, bR] = pixelAt(out.rgba, 80, 50);
    expect(gR).toBeLessThan(60);
    expect(bR).toBeGreaterThan(200);

    // And the rows outside the content band are still padding.
    expect(pixelAt(out.rgba, 20, 5)).toEqual([0, 0, 0, 0]);
  });

  it('does not upscale a frame smaller than the target beyond its aspect fit', () => {
    // A 10x10 into a 100 target legitimately scales up by 10 - letterboxing is
    // "fit to the model input", not "never enlarge". What must hold is that the
    // scale is the aspect-preserving fit and the result stays square.
    const out = letterboxImage(solid(10, 10, 5, 5, 5), 100);
    expect(out.scale).toBeCloseTo(10, 10);
    expect(out.rgba.width).toBe(100);
    expect(out.pad.left).toBeCloseTo(0, 10);
  });

  it('never reads outside the source buffer', () => {
    // Sampling arithmetic that runs off the end produces undefined -> NaN ->
    // silently black output, which looks like a dark screenshot rather than a
    // bug. Assert every output pixel is a real number.
    const out = letterboxImage(solid(37, 91, 12, 34, 56), 64);
    for (let i = 0; i < out.rgba.data.length; i++) {
      expect(Number.isFinite(out.rgba.data[i])).toBe(true);
    }
  });

  it('rejects a non-positive target rather than emitting a zero-size buffer', () => {
    expect(() => letterboxImage(solid(10, 10, 0, 0, 0), 0)).toThrow();
    expect(() => letterboxImage(solid(10, 10, 0, 0, 0), -8)).toThrow();
  });

  it('rejects an empty source rather than dividing by zero', () => {
    expect(() => letterboxImage(createImage(0, 0), 64)).toThrow();
  });
});
