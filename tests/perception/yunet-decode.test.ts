import { describe, expect, it } from 'vitest';
import {
  YUNET_LABEL,
  YUNET_STRIDES,
  decodeYunet,
  rgbaToBgrChw,
  type YunetOutputs,
} from '@/perception/index.ts';

/**
 * The YuNet head, decoded by hand and therefore tested by hand.
 *
 * transformers.js cannot load this model - it dispatches object-detection to
 * seven architectures and YuNet is none of them, and it ships neither
 * config.json nor preprocessor_config.json. So the decode is ours, and every
 * piece of arithmetic here is a place a plausible-looking wrong box can come
 * from.
 *
 * Values are chosen so the expected answer is computable on paper.
 */

/** Empty tensors for every stride, so a test can fill in only what it cares about. */
function empty(): { cls: Float32Array[]; obj: Float32Array[]; bbox: Float32Array[] } {
  const counts = YUNET_STRIDES.map((s) => (640 / s) ** 2);
  return {
    cls: counts.map((n) => new Float32Array(n)),
    obj: counts.map((n) => new Float32Array(n)),
    bbox: counts.map((n) => new Float32Array(n * 4)),
  };
}

/** Put one detection at anchor `i` of stride index `s`. */
function place(
  o: ReturnType<typeof empty>,
  s: number,
  i: number,
  v: { cls: number; obj: number; dx: number; dy: number; logW: number; logH: number },
): YunetOutputs {
  o.cls[s]![i] = v.cls;
  o.obj[s]![i] = v.obj;
  o.bbox[s]![i * 4] = v.dx;
  o.bbox[s]![i * 4 + 1] = v.dy;
  o.bbox[s]![i * 4 + 2] = v.logW;
  o.bbox[s]![i * 4 + 3] = v.logH;
  return o;
}

describe('decodeYunet arithmetic', () => {
  it('places a box from cell offsets and log sizes', () => {
    // Stride 8, anchor 0 => col 0, row 0. dx/dy 0.5 => centre at (4, 4).
    // logW = 0 => w = exp(0) * 8 = 8. Same for h.
    const out = decodeYunet(
      place(empty(), 0, 0, { cls: 1, obj: 1, dx: 0.5, dy: 0.5, logW: 0, logH: 0 }),
      640,
    );
    expect(out).toHaveLength(1);
    const r = out[0]!.rect;
    expect(r.x).toBeCloseTo(0, 5); // 4 - 8/2
    expect(r.y).toBeCloseTo(0, 5);
    expect(r.width).toBeCloseTo(8, 5);
    expect(r.height).toBeCloseTo(8, 5);
  });

  it('derives the grid column from the FEATURE MAP width, not the input width', () => {
    /*
     * The single easiest thing to get wrong here. Stride 8 on a 640 input gives
     * an 80x80 map, so anchor 81 is col 1 row 1 - not col 81. Using the input
     * width would put every box in the first row, far off to the right: boxes
     * that decode, look plausible, and land nowhere near the face.
     */
    const out = decodeYunet(
      place(empty(), 0, 81, { cls: 1, obj: 1, dx: 0, dy: 0, logW: 0, logH: 0 }),
      640,
    );
    const r = out[0]!.rect;
    // centre = (col + 0) * 8 = 8, (row + 0) * 8 = 8
    expect(r.x + r.width / 2).toBeCloseTo(8, 5);
    expect(r.y + r.height / 2).toBeCloseTo(8, 5);
  });

  it('uses the geometric mean of cls and obj, not the product', () => {
    // OpenCV takes sqrt(cls * obj). Dropping the root does not fail loudly - it
    // just shifts every score down, so a threshold tuned on one convention
    // silently rejects most faces under the other. 0.25 * 0.64 -> sqrt = 0.4.
    const out = decodeYunet(
      place(empty(), 0, 0, { cls: 0.25, obj: 0.64, dx: 0, dy: 0, logW: 0, logH: 0 }),
      640,
    );
    expect(out[0]!.score).toBeCloseTo(0.4, 6);
  });

  it('clamps cls and obj into [0,1] before combining', () => {
    // A negative would make the product negative and sqrt would give NaN, which
    // then survives every comparison as `false` and silently drops the box.
    const out = decodeYunet(
      place(empty(), 0, 0, { cls: -3, obj: 5, dx: 0, dy: 0, logW: 0, logH: 0 }),
      640,
    );
    expect(out).toHaveLength(0); // score 0, below the floor
    const high = decodeYunet(
      place(empty(), 0, 0, { cls: 5, obj: 5, dx: 0, dy: 0, logW: 0, logH: 0 }),
      640,
    );
    expect(high[0]!.score).toBe(1);
    expect(Number.isNaN(high[0]!.score)).toBe(false);
  });

  it('scales by each stride, so the three heads agree on one coordinate space', () => {
    for (let s = 0; s < YUNET_STRIDES.length; s += 1) {
      const stride = YUNET_STRIDES[s]!;
      const out = decodeYunet(
        place(empty(), s, 0, { cls: 1, obj: 1, dx: 0.5, dy: 0.5, logW: 0, logH: 0 }),
        640,
      );
      expect(out[0]!.rect.width).toBeCloseTo(stride, 5);
    }
  });

  it('labels every box so labelToPiiKind maps it with no edit', () => {
    const out = decodeYunet(
      place(empty(), 1, 5, { cls: 1, obj: 1, dx: 0, dy: 0, logW: 0, logH: 0 }),
      640,
    );
    expect(out[0]!.label).toBe(YUNET_LABEL);
    expect(YUNET_LABEL).toBe('face');
  });

  it('drops near-zero anchors rather than returning all 8400', () => {
    // A memory guard, not the policy threshold - decodeDetections applies the
    // engine's real scoreThreshold and NMS downstream.
    const out = decodeYunet(empty(), 640);
    expect(out).toHaveLength(0);
  });

  it('honours an explicit floor', () => {
    const o = place(empty(), 0, 0, { cls: 0.5, obj: 0.5, dx: 0, dy: 0, logW: 0, logH: 0 });
    expect(decodeYunet(o, 640, { floor: 0.4 })).toHaveLength(1); // score 0.5
    expect(decodeYunet(o, 640, { floor: 0.6 })).toHaveLength(0);
  });

  it('survives short or mismatched tensors instead of reading undefined', () => {
    const short: YunetOutputs = {
      cls: [new Float32Array([1])],
      obj: [new Float32Array([1])],
      bbox: [new Float32Array([0, 0, 0, 0])],
    };
    expect(() => decodeYunet(short, 640)).not.toThrow();
    expect(decodeYunet(short, 640)).toHaveLength(1);
  });
});

describe('rgbaToBgrChw', () => {
  it('writes BGR planes, not RGB', () => {
    /*
     * THE FOOTGUN, PINNED. YuNet is fed by OpenCV's blobFromImage with all
     * defaults: no scaling, no mean subtraction, and BGR because that is
     * OpenCV's native order.
     *
     * Measured on a real image through this exact code: BGR found 66 faces,
     * RGB found 11 - an 83% recall loss - and the top score moved only from
     * 0.918 to 0.907. Nothing throws, nothing logs, and the output still looks
     * healthy. There is no symptom to notice, which is why it is a test.
     */
    const one = new Uint8ClampedArray([10, 20, 30, 255]); // r=10 g=20 b=30
    const out = rgbaToBgrChw(one, 1, 1);
    expect([...out]).toEqual([30, 20, 10]); // B, G, R
  });

  it('keeps values raw 0-255, with no normalisation', () => {
    const one = new Uint8ClampedArray([255, 128, 0, 255]);
    const out = rgbaToBgrChw(one, 1, 1);
    expect(out[0]).toBe(0); // B
    expect(out[1]).toBe(128); // G
    expect(out[2]).toBe(255); // R
  });

  it('lays out planar CHW, not interleaved', () => {
    // 2x1 image: two pixels. Planar means [B0,B1, G0,G1, R0,R1].
    const two = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
    const out = rgbaToBgrChw(two, 2, 1);
    expect([...out]).toEqual([3, 6, 2, 5, 1, 4]);
  });

  it('skips the alpha channel entirely', () => {
    const a = rgbaToBgrChw(new Uint8ClampedArray([9, 9, 9, 0]), 1, 1);
    const b = rgbaToBgrChw(new Uint8ClampedArray([9, 9, 9, 255]), 1, 1);
    expect([...a]).toEqual([...b]);
  });
});
