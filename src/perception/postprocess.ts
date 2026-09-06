import {
  type DetectionId,
  type PiiKind,
  type Rect,
  type ViewportInfo,
  type VisionDetection,
  deviceToCssViewport,
  detectionId,
  iou,
  rect,
  saltedHash,
} from '@/contracts/index.ts';

/**
 * Everything that happens to model output after the forward pass.
 *
 * All pure, all runs in Node. This is where the vision module is testable today:
 * the model itself is out of scope for this session, but box decoding, NMS and
 * the letterbox inversion are exactly the code that silently shifts every
 * redaction by a few pixels if it is wrong.
 */

export interface Padding {
  readonly top: number;
  readonly left: number;
}

/**
 * Undo letterboxing. Preprocessing scales the frame to fit the model's square
 * input and pads the remainder; boxes come back in padded space and have to be
 * mapped back or every redaction lands in the wrong place.
 */
export function undoLetterbox(
  r: Rect<'device-px'>,
  pad: Padding,
  scale: number,
): Rect<'device-px'> {
  if (scale <= 0) return r;
  return rect(
    'device-px',
    (r.x - pad.left) / scale,
    (r.y - pad.top) / scale,
    r.width / scale,
    r.height / scale,
  );
}

/** Scale and padding for fitting `natural` into a square `target`, preserving aspect. */
export function letterboxParams(
  natural: { width: number; height: number },
  target: number,
): { scale: number; pad: Padding } {
  const scale = Math.min(target / natural.width, target / natural.height);
  const scaledW = natural.width * scale;
  const scaledH = natural.height * scale;
  return {
    scale,
    pad: { left: (target - scaledW) / 2, top: (target - scaledH) / 2 },
  };
}

/** Centre-form (cx, cy, w, h) as most detection heads emit it. */
export function centreToRect(
  cx: number,
  cy: number,
  w: number,
  h: number,
): Rect<'device-px'> {
  return rect('device-px', cx - w / 2, cy - h / 2, w, h);
}

/** Normalised [0,1] box to absolute device pixels. */
export function normalisedToRect(
  box: readonly [number, number, number, number],
  width: number,
  height: number,
): Rect<'device-px'> {
  const [x0, y0, x1, y1] = box;
  return rect('device-px', x0 * width, y0 * height, (x1 - x0) * width, (y1 - y0) * height);
}

/**
 * Greedy non-maximum suppression, per class.
 *
 * Per class matters: a face box and an id-document box legitimately overlap
 * almost entirely, and suppressing across classes would drop one of them.
 */
export function nonMaxSuppression(
  detections: readonly VisionDetection[],
  iouThreshold: number,
): VisionDetection[] {
  const byKind = new Map<PiiKind, VisionDetection[]>();
  for (const d of detections) {
    const list = byKind.get(d.kind);
    if (list === undefined) byKind.set(d.kind, [d]);
    else list.push(d);
  }

  const kept: VisionDetection[] = [];
  for (const list of byKind.values()) {
    const sorted = [...list].sort((a, b) => b.confidence - a.confidence);
    const survivors: VisionDetection[] = [];
    for (const candidate of sorted) {
      if (survivors.some((s) => iou(s.rect, candidate.rect) >= iouThreshold)) continue;
      survivors.push(candidate);
    }
    kept.push(...survivors);
  }
  return kept.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Model labels to PII kinds.
 *
 * A COCO detector says "person"; what redaction needs to know is "there is a
 * face here". This mapping is deliberately conservative - an unmapped label
 * becomes null and is dropped rather than becoming 'unknown-sensitive', because
 * blacking out every detected chair would wreck redaction precision.
 */
const LABEL_MAP: Readonly<Record<string, PiiKind>> = {
  person: 'face',
  face: 'face',
  head: 'face',
  signature: 'signature',
  'id-card': 'id-document',
  'id_document': 'id-document',
  passport: 'id-document',
  'driving-licence': 'id-document',
  'credit-card': 'credit-card',
  'card': 'credit-card',
};

export function labelToPiiKind(label: string): PiiKind | null {
  return LABEL_MAP[label.toLowerCase().trim()] ?? null;
}

export interface RawBox {
  readonly label: string;
  readonly score: number;
  readonly rect: Rect<'device-px'>;
}

export interface DecodeOptions {
  readonly viewport: ViewportInfo;
  readonly scoreThreshold: number;
  readonly nmsIou: number;
  readonly salt: string;
  readonly idPrefix?: string;
}

/**
 * Raw boxes to VisionDetections in CSS viewport space, thresholded and NMS'd.
 * The space conversion happens exactly here so nothing downstream has to guess.
 */
export function decodeDetections(
  boxes: readonly RawBox[],
  opts: DecodeOptions,
): VisionDetection[] {
  const prefix = opts.idPrefix ?? 'v';
  const mapped: VisionDetection[] = [];

  boxes.forEach((box, i) => {
    if (box.score < opts.scoreThreshold) return;
    const kind = labelToPiiKind(box.label);
    if (kind === null) return;
    mapped.push({
      id: detectionId(`${prefix}-${String(i)}`) as DetectionId,
      kind,
      source: 'vision',
      confidence: box.score,
      rect: deviceToCssViewport(box.rect, opts.viewport),
      label: box.label,
      evidence: {
        rule: `vision-${box.label}`,
        valueLength: 0,
        valueHash: saltedHash(`${box.label}:${String(i)}`, opts.salt),
      },
    });
  });

  return nonMaxSuppression(mapped, opts.nmsIou);
}
