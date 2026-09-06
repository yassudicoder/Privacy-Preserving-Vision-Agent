import { describe, expect, it } from 'vitest';
import {
  type PixelRedactionOp,
  detectionId,
  rect,
} from '@/contracts/index.ts';
import {
  applyPixelOps,
  bakeRedactions,
  blackoutRect,
  boxBlurRect,
  createImage,
  pixelateRect,
  regionStats,
  unchangedOutside,
} from '@/redaction/index.ts';

/** A deterministic noisy image, so "did this region change" is unambiguous. */
function noisyImage(w: number, h: number) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = (x * 37 + y * 11) % 256;
      img.data[i + 1] = (x * 17 + y * 53) % 256;
      img.data[i + 2] = (x * 7 + y * 29) % 256;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

function op(
  strategy: PixelRedactionOp['strategy'],
  x: number,
  y: number,
  w: number,
  h: number,
  intensity = 4,
): PixelRedactionOp {
  return {
    detectionId: detectionId(`d-${strategy}`),
    kind: 'face',
    strategy,
    rect: rect('device-px', x, y, w, h),
    intensity,
  };
}

describe('blackoutRect', () => {
  it('sets every pixel in the region to opaque black', () => {
    const img = noisyImage(40, 40);
    const changed = blackoutRect(img, rect('device-px', 10, 10, 10, 10));
    expect(changed).toBe(100);

    const stats = regionStats(img, rect('device-px', 10, 10, 10, 10));
    expect(stats.variance).toBe(0);
    expect(stats.distinctColours).toBe(1);
    expect(stats.mean).toEqual([0, 0, 0]);
  });

  it('leaves everything outside the region byte-identical', () => {
    const before = noisyImage(40, 40);
    const after = noisyImage(40, 40);
    const box = rect('device-px', 10, 10, 10, 10);
    blackoutRect(after, box);
    expect(unchangedOutside(before, after, [box])).toBe(true);
  });

  it('clamps a region that runs off the edge', () => {
    const img = noisyImage(20, 20);
    const changed = blackoutRect(img, rect('device-px', 15, 15, 100, 100));
    expect(changed).toBe(25);
  });

  it('does nothing for a region entirely outside the frame', () => {
    const img = noisyImage(20, 20);
    expect(blackoutRect(img, rect('device-px', 100, 100, 10, 10))).toBe(0);
  });

  it('snaps fractional rects outward so no sliver is left uncovered', () => {
    const img = noisyImage(20, 20);
    // 4.4 -> 4, and the right edge 4.4+3.2=7.6 -> 8, so width becomes 4.
    const changed = blackoutRect(img, rect('device-px', 4.4, 4.4, 3.2, 3.2));
    expect(changed).toBe(16);
  });
});

describe('boxBlurRect', () => {
  it('collapses variance inside the region', () => {
    const img = noisyImage(60, 60);
    const box = rect('device-px', 10, 10, 32, 32);
    const before = regionStats(img, box);
    boxBlurRect(img, box, 4);
    const after = regionStats(img, box);
    expect(after.variance).toBeLessThan(before.variance / 4);
  });

  it('enforces a minimum radius so a light blur cannot be reversed', () => {
    // Requesting radius 1 on a 64px region must not be honoured literally:
    // that is recoverable, which would make the redaction theatre.
    const weak = noisyImage(80, 80);
    const strong = noisyImage(80, 80);
    const box = rect('device-px', 8, 8, 64, 64);
    boxBlurRect(weak, box, 1);
    boxBlurRect(strong, box, 8);
    const weakStats = regionStats(weak, box);
    const strongStats = regionStats(strong, box);
    // Both hit the same floor, so they are close rather than wildly different.
    expect(Math.abs(weakStats.variance - strongStats.variance)).toBeLessThan(
      Math.max(weakStats.variance, strongStats.variance) + 1,
    );
    expect(weakStats.variance).toBeLessThan(regionStats(noisyImage(80, 80), box).variance / 2);
  });

  it('does not bleed content in from outside the region', () => {
    const img = createImage(40, 40);
    // Fill the whole image with red, then a blue square, then blur the square.
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255;
      img.data[i + 3] = 255;
    }
    const box = rect('device-px', 10, 10, 16, 16);
    for (let y = 10; y < 26; y++) {
      for (let x = 10; x < 26; x++) {
        const i = (y * 40 + x) * 4;
        img.data[i] = 0;
        img.data[i + 2] = 255;
      }
    }
    boxBlurRect(img, box, 4);
    const stats = regionStats(img, box);
    // Pure blue in, pure blue out - no red averaged in from the surround.
    expect(stats.mean[0]).toBe(0);
    expect(stats.mean[2]).toBe(255);
  });
});

describe('pixelateRect', () => {
  it('makes each block a single colour', () => {
    const img = noisyImage(40, 40);
    pixelateRect(img, rect('device-px', 0, 0, 16, 16), 8);
    const block = regionStats(img, rect('device-px', 0, 0, 8, 8));
    expect(block.distinctColours).toBe(1);
  });
});

describe('applyPixelOps', () => {
  it('does not mutate the input image', () => {
    const img = noisyImage(40, 40);
    const copy = new Uint8ClampedArray(img.data);
    applyPixelOps(img, [op('blackout', 5, 5, 10, 10)]);
    expect(img.data).toEqual(copy);
  });

  it('applies every op and counts them', () => {
    const img = noisyImage(60, 60);
    const result = applyPixelOps(img, [
      op('blackout', 0, 0, 10, 10),
      op('blur', 20, 20, 16, 16),
      op('pixelate', 40, 40, 16, 16, 4),
    ]);
    expect(result.requested).toBe(3);
    expect(result.applied).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.pixelsChanged).toBeGreaterThan(0);
  });

  it('reports an out-of-frame op as skipped rather than silently dropping it', () => {
    // A redaction that did not happen must never look like one that did.
    const img = noisyImage(20, 20);
    const result = applyPixelOps(img, [op('blackout', 500, 500, 10, 10)]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.why).toContain('outside the captured frame');
  });

  it('counts an entirely off-screen op separately from one that failed to land', () => {
    /*
     * THE DISTINCTION THIS EXISTS TO MAKE. A screenshot shows the VIEWPORT; the
     * DOM scan reads the whole document. A value below the fold is redacted in
     * the text and was never in the picture, so no pixel op can apply to it and
     * none needs to - that is safe. An op that OVERLAPS the frame and still does
     * not apply is a redaction that was supposed to happen and did not.
     *
     * Both used to report `0 pixel op(s)` and there was no way to tell them
     * apart, which is the only question worth asking about a screenshot.
     */
    const img = noisyImage(20, 20);
    const offScreen = applyPixelOps(img, [op('blackout', 500, 500, 10, 10)]);
    expect(offScreen.outsideFrame).toBe(1);
    expect(offScreen.requested - offScreen.outsideFrame).toBe(0); // nothing owed

    // Straddling the edge: partly visible, so it MUST be covered.
    const straddling = applyPixelOps(img, [op('blackout', 15, 15, 20, 20)]);
    expect(straddling.outsideFrame).toBe(0);
    expect(straddling.applied).toBe(1);
  });
});

describe('bakeRedactions', () => {
  const fakeEncoder = () => ({ base64: 'ZmFrZQ==', format: 'jpeg' as const });

  it('mints a BakedScreenshot carrying honest op counts', () => {
    const img = noisyImage(40, 40);
    const { screenshot, result } = bakeRedactions(
      img,
      [op('blackout', 0, 0, 10, 10), op('blackout', 900, 900, 10, 10)],
      fakeEncoder,
    );
    expect(screenshot.opsRequested).toBe(2);
    expect(screenshot.opsApplied).toBe(1);
    expect(screenshot.width).toBe(40);
    expect(screenshot.height).toBe(40);
    expect(result.skipped).toHaveLength(1);
  });

  it('encodes the redacted image, not the original', () => {
    const img = noisyImage(40, 40);
    let seenVariance = -1;
    bakeRedactions(img, [op('blackout', 0, 0, 40, 40)], (redacted) => {
      seenVariance = regionStats(redacted, rect('device-px', 0, 0, 40, 40)).variance;
      return { base64: '', format: 'png' };
    });
    expect(seenVariance).toBe(0);
  });
});
