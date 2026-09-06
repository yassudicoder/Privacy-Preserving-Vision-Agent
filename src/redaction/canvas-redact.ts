import {
  type BakedScreenshot,
  type PixelRedactionOp,
  type Rect,
  type RgbaImage,
  clampToBounds,
  roundRect,
} from '@/contracts/index.ts';

/**
 * Pixel redaction.
 *
 * WHERE THIS RUNS: in the inference worker, inside the offscreen document
 * (Chrome) or the background event page (Firefox). Not in the content script -
 * the page must never be handed the unredacted frame - and not in the Chrome
 * service worker, which has no decoded frame. The worker already holds the
 * decoded bitmap for inference, so baking there avoids a second decode and a
 * second transfer of a large buffer.
 *
 * WHY IT IS SHAPED LIKE THIS: everything below operates on a plain RGBA buffer,
 * so it is pure and runs under vitest in Node with no canvas. Only `encode` is
 * environment-specific, and it is injected.
 */

/*
 * `RgbaImage` now lives in contracts/image.ts. The perception worker holds
 * decoded frames of exactly this shape and may not import redaction, so the
 * declaration had to move to the leaf both modules already depend on. It is
 * re-exported here because this is where every existing import expects it.
 */
export type { RgbaImage };

export function createImage(width: number, height: number, fill = 0): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

function idx(img: RgbaImage, x: number, y: number): number {
  return (y * img.width + x) * 4;
}

/** Clamp to the image and snap outward to whole pixels - never leave a sliver uncovered. */
function normaliseRect(img: RgbaImage, r: Rect<'device-px'>): Rect<'device-px'> {
  return clampToBounds(roundRect(r), img.width, img.height);
}

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------

export function blackoutRect(img: RgbaImage, r: Rect<'device-px'>): number {
  const b = normaliseRect(img, r);
  let changed = 0;
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      const i = idx(img, x, y);
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = 255;
      changed++;
    }
  }
  return changed;
}

/**
 * Box blur confined to the region.
 *
 * Sampling is clamped to the region rather than the whole image so surrounding
 * content cannot bleed in and so the redaction is self-contained.
 *
 * The radius floor matters: a light blur over a small region is recoverable by
 * anyone who cares, which would make this redaction theatre. The effective
 * radius is never less than an eighth of the shorter side.
 */
export function boxBlurRect(img: RgbaImage, r: Rect<'device-px'>, radius: number): number {
  const b = normaliseRect(img, r);
  if (b.width <= 0 || b.height <= 0) return 0;

  const floor = Math.ceil(Math.min(b.width, b.height) / 8);
  const rad = Math.max(1, Math.max(Math.floor(radius), floor));

  const src = new Uint8ClampedArray(b.width * b.height * 4);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const from = idx(img, b.x + x, b.y + y);
      const to = (y * b.width + x) * 4;
      src[to] = img.data[from] ?? 0;
      src[to + 1] = img.data[from + 1] ?? 0;
      src[to + 2] = img.data[from + 2] ?? 0;
      src[to + 3] = img.data[from + 3] ?? 255;
    }
  }

  let changed = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      const y0 = Math.max(0, y - rad);
      const y1 = Math.min(b.height - 1, y + rad);
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(b.width - 1, x + rad);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = (yy * b.width + xx) * 4;
          sr += src[i] ?? 0;
          sg += src[i + 1] ?? 0;
          sb += src[i + 2] ?? 0;
          n++;
        }
      }
      const out = idx(img, b.x + x, b.y + y);
      img.data[out] = Math.round(sr / n);
      img.data[out + 1] = Math.round(sg / n);
      img.data[out + 2] = Math.round(sb / n);
      img.data[out + 3] = 255;
      changed++;
    }
  }
  return changed;
}

/** Average each block down to a single colour. */
export function pixelateRect(img: RgbaImage, r: Rect<'device-px'>, blockPx: number): number {
  const b = normaliseRect(img, r);
  if (b.width <= 0 || b.height <= 0) return 0;
  const block = Math.max(2, Math.floor(blockPx));
  let changed = 0;

  for (let by = b.y; by < b.y + b.height; by += block) {
    for (let bx = b.x; bx < b.x + b.width; bx += block) {
      const x1 = Math.min(bx + block, b.x + b.width);
      const y1 = Math.min(by + block, b.y + b.height);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const i = idx(img, x, y);
          sr += img.data[i] ?? 0;
          sg += img.data[i + 1] ?? 0;
          sb += img.data[i + 2] ?? 0;
          n++;
        }
      }
      if (n === 0) continue;
      const rr = Math.round(sr / n);
      const gg = Math.round(sg / n);
      const bb = Math.round(sb / n);
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const i = idx(img, x, y);
          img.data[i] = rr;
          img.data[i + 1] = gg;
          img.data[i + 2] = bb;
          img.data[i + 3] = 255;
          changed++;
        }
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// applying a batch
// ---------------------------------------------------------------------------

export interface ApplyResult {
  readonly image: RgbaImage;
  readonly requested: number;
  readonly applied: number;
  readonly skipped: readonly { readonly op: PixelRedactionOp; readonly why: string }[];
  /**
   * Ops whose rect lay entirely outside the captured frame.
   *
   * SEPARATED FROM `skipped` BECAUSE THE TWO MEAN OPPOSITE THINGS. A screenshot
   * shows the VIEWPORT; the DOM scan reads the whole document. A value below the
   * fold is redacted in the text and simply is not in the picture, so producing
   * no pixel op for it is correct and nothing is leaking. An op that DOES
   * overlap the frame and still fails to apply is a redaction that was supposed
   * to happen and did not.
   *
   * Without this split both cases report `0 pixel op(s)` and there is no way to
   * tell a safe screenshot from a broken one - which is the only question that
   * matters here.
   */
  readonly outsideFrame: number;
  readonly pixelsChanged: number;
}

/** Does this op's rect overlap the frame at all? */
function overlapsFrame(img: RgbaImage, op: PixelRedactionOp): boolean {
  const r = roundRect(op.rect);
  return r.x < img.width && r.y < img.height && r.x + r.width > 0 && r.y + r.height > 0;
}

/**
 * Apply every op to a copy of the image. Ops whose rect falls entirely outside
 * the frame are reported as skipped rather than silently dropped - a redaction
 * that did not happen must never look like one that did.
 */
export function applyPixelOps(img: RgbaImage, ops: readonly PixelRedactionOp[]): ApplyResult {
  const out = cloneImage(img);
  const skipped: { op: PixelRedactionOp; why: string }[] = [];
  let applied = 0;
  let outsideFrame = 0;
  let pixelsChanged = 0;

  for (const op of ops) {
    const b = normaliseRect(out, op.rect);
    if (b.width <= 0 || b.height <= 0) {
      if (!overlapsFrame(out, op)) {
        // Not in the picture at all. Counted, not treated as a failure.
        outsideFrame += 1;
        skipped.push({ op, why: 'rect lies entirely outside the captured frame' });
        continue;
      }
      skipped.push({ op, why: 'rect is empty after clamping to the frame' });
      continue;
    }
    let changed = 0;
    switch (op.strategy) {
      case 'blackout':
        changed = blackoutRect(out, op.rect);
        break;
      case 'blur':
        changed = boxBlurRect(out, op.rect, op.intensity);
        break;
      case 'pixelate':
        changed = pixelateRect(out, op.rect, op.intensity);
        break;
    }
    if (changed === 0) {
      skipped.push({ op, why: 'strategy changed no pixels' });
      continue;
    }
    applied++;
    pixelsChanged += changed;
  }

  return { image: out, requested: ops.length, applied, skipped, outsideFrame, pixelsChanged };
}

// ---------------------------------------------------------------------------
// minting a BakedScreenshot
// ---------------------------------------------------------------------------

/** Environment-specific step. Browser: canvas.toDataURL. Tests: a fake. */
export type ImageEncoder = (
  img: RgbaImage,
) => { readonly base64: string; readonly format: 'jpeg' | 'png' };

/**
 * The ONLY producer of BakedScreenshot.
 *
 * `buildSanitizedContext` takes a BakedScreenshot, not a base64 string, so it is
 * not possible to hand the sanitizer an un-redacted frame and assert that the
 * redactions were applied. That was a real hole in the original design.
 */
export function bakeRedactions(
  img: RgbaImage,
  ops: readonly PixelRedactionOp[],
  encode: ImageEncoder,
): { readonly screenshot: BakedScreenshot; readonly result: ApplyResult } {
  const result = applyPixelOps(img, ops);
  const encoded = encode(result.image);
  const screenshot = {
    base64: encoded.base64,
    format: encoded.format,
    width: result.image.width,
    height: result.image.height,
    opsApplied: result.applied,
    opsOutsideFrame: result.outsideFrame,
    opsRequested: result.requested,
  } as BakedScreenshot;
  return { screenshot, result };
}

// ---------------------------------------------------------------------------
// verification helpers - used by tests and by the residual-risk check
// ---------------------------------------------------------------------------

/**
 * Re-brands a BakedScreenshot that has crossed a transport boundary.
 *
 * `bakeRedactions` is the only place a BakedScreenshot is minted, and that is
 * the point: `buildSanitizedContext` cannot be handed a raw frame. But on Chrome
 * the bake happens in the offscreen document and the result is JSON-serialised
 * on its way back to the service worker, which strips the brand along with every
 * other non-enumerable thing.
 *
 * WHAT THIS DOES NOT GUARANTEE: that the payload really came from a bake. It
 * cannot - the brand does not survive `JSON.stringify`, so there is nothing left
 * to check. What still holds is that the only code that produces this shape is
 * `bakeRedactions`, running in a worker this extension started, reached over an
 * internal message channel that no page can address. That is a weaker guarantee
 * than the compile-time one, and it is weaker precisely at the boundary, so it
 * is written down here rather than left implicit at the call site.
 *
 * Kept in this file so the cast stays where `boundaries.test.ts` pins it.
 */
export function receiveBakedScreenshot(payload: {
  readonly base64: string;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
  readonly opsApplied: number;
  readonly opsRequested: number;
  readonly opsOutsideFrame: number;
}): BakedScreenshot {
  return { ...payload } as BakedScreenshot;
}

export interface RegionStats {
  readonly mean: readonly [number, number, number];
  readonly variance: number;
  readonly distinctColours: number;
}

/** Variance collapsing to ~0 is how a test proves a region really was flattened. */
export function regionStats(img: RgbaImage, r: Rect<'device-px'>): RegionStats {
  const b = normaliseRect(img, r);
  const seen = new Set<number>();
  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;

  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      const i = idx(img, x, y);
      const rr = img.data[i] ?? 0;
      const gg = img.data[i + 1] ?? 0;
      const bb = img.data[i + 2] ?? 0;
      sr += rr;
      sg += gg;
      sb += bb;
      seen.add((rr << 16) | (gg << 8) | bb);
      n++;
    }
  }
  if (n === 0) return { mean: [0, 0, 0], variance: 0, distinctColours: 0 };

  const mr = sr / n;
  const mg = sg / n;
  const mb = sb / n;
  let acc = 0;
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      const i = idx(img, x, y);
      acc +=
        ((img.data[i] ?? 0) - mr) ** 2 +
        ((img.data[i + 1] ?? 0) - mg) ** 2 +
        ((img.data[i + 2] ?? 0) - mb) ** 2;
    }
  }
  return { mean: [mr, mg, mb], variance: acc / (n * 3), distinctColours: seen.size };
}

/** True when every pixel outside `regions` is byte-identical. Proves no over-redaction. */
export function unchangedOutside(
  before: RgbaImage,
  after: RgbaImage,
  regions: readonly Rect<'device-px'>[],
): boolean {
  if (before.width !== after.width || before.height !== after.height) return false;
  const boxes = regions.map((r) => normaliseRect(before, r));
  const inside = (x: number, y: number): boolean =>
    boxes.some((b) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);

  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      if (inside(x, y)) continue;
      const i = idx(before, x, y);
      for (let c = 0; c < 4; c++) {
        if ((before.data[i + c] ?? 0) !== (after.data[i + c] ?? 0)) return false;
      }
    }
  }
  return true;
}
