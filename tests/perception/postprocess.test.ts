import { describe, expect, it } from 'vitest';
import {
  type ViewportInfo,
  type VisionDetection,
  detectionId,
  iou,
  rect,
} from '@/contracts/index.ts';
import {
  centreToRect,
  decodeDetections,
  labelToPiiKind,
  letterboxParams,
  nonMaxSuppression,
  normalisedToRect,
  undoLetterbox,
} from '@/perception/index.ts';

const viewport: ViewportInfo = {
  cssWidth: 1280,
  cssHeight: 800,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
};

function box(x: number, y: number, w: number, h: number, confidence = 0.9, kind = 'face'): VisionDetection {
  return {
    id: detectionId(`v-${String(x)}-${String(y)}`),
    kind: kind as VisionDetection['kind'],
    source: 'vision',
    confidence,
    rect: rect('css-viewport', x, y, w, h),
    label: kind,
    evidence: { rule: 'test', valueLength: 0, valueHash: '0' },
  };
}

describe('letterbox arithmetic', () => {
  it('computes a scale that fits the longest edge', () => {
    const { scale, pad } = letterboxParams({ width: 1280, height: 800 }, 640);
    expect(scale).toBeCloseTo(0.5, 5);
    expect(pad.left).toBeCloseTo(0, 5);
    expect(pad.top).toBeCloseTo(120, 5);
  });

  it('round-trips a box through letterboxing', () => {
    // Getting this wrong shifts every redaction box by the padding amount, which
    // is exactly the kind of bug that looks like a slightly inaccurate model.
    const natural = { width: 1280, height: 800 };
    const { scale, pad } = letterboxParams(natural, 640);
    const original = rect('device-px', 100, 200, 300, 150);
    const inModelSpace = rect(
      'device-px',
      original.x * scale + pad.left,
      original.y * scale + pad.top,
      original.width * scale,
      original.height * scale,
    );
    const back = undoLetterbox(inModelSpace, pad, scale);
    expect(back.x).toBeCloseTo(original.x, 5);
    expect(back.y).toBeCloseTo(original.y, 5);
    expect(back.width).toBeCloseTo(original.width, 5);
    expect(back.height).toBeCloseTo(original.height, 5);
  });

  it('leaves the rect alone for a nonsensical scale rather than dividing by zero', () => {
    const r = rect('device-px', 1, 2, 3, 4);
    expect(undoLetterbox(r, { top: 0, left: 0 }, 0)).toEqual(r);
  });
});

describe('box format conversions', () => {
  it('converts centre form to a rect', () => {
    expect(centreToRect(100, 100, 40, 20)).toEqual(rect('device-px', 80, 90, 40, 20));
  });

  it('converts normalised coordinates to absolute pixels', () => {
    const r = normalisedToRect([0.1, 0.2, 0.5, 0.6], 1000, 500);
    expect(r.space).toBe('device-px');
    expect(r.x).toBeCloseTo(100, 6);
    expect(r.y).toBeCloseTo(100, 6);
    expect(r.width).toBeCloseTo(400, 6);
    expect(r.height).toBeCloseTo(200, 6);
  });
});

describe('nonMaxSuppression', () => {
  it('keeps the highest-confidence box among overlaps', () => {
    const kept = nonMaxSuppression([box(0, 0, 100, 100, 0.7), box(5, 5, 100, 100, 0.95)], 0.5);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.confidence).toBe(0.95);
  });

  it('keeps boxes that do not overlap', () => {
    expect(nonMaxSuppression([box(0, 0, 50, 50), box(500, 500, 50, 50)], 0.5)).toHaveLength(2);
  });

  it('suppresses per class, not across classes', () => {
    // A face and an ID document legitimately occupy the same pixels. Cross-class
    // suppression would drop one of them and leave real PII on screen.
    const kept = nonMaxSuppression(
      [box(0, 0, 100, 100, 0.9, 'face'), box(0, 0, 100, 100, 0.8, 'id-document')],
      0.5,
    );
    expect(kept).toHaveLength(2);
  });

  it('handles an empty input', () => {
    expect(nonMaxSuppression([], 0.5)).toEqual([]);
  });
});

describe('labelToPiiKind', () => {
  it('maps detector labels onto redaction kinds', () => {
    expect(labelToPiiKind('person')).toBe('face');
    expect(labelToPiiKind('Signature')).toBe('signature');
    expect(labelToPiiKind('passport')).toBe('id-document');
  });

  it('returns null for labels with no privacy meaning', () => {
    // Mapping unknown labels to 'unknown-sensitive' would black out every
    // detected chair and destroy redaction precision.
    expect(labelToPiiKind('chair')).toBeNull();
    expect(labelToPiiKind('potted plant')).toBeNull();
  });
});

describe('decodeDetections', () => {
  const opts = { viewport, scoreThreshold: 0.5, nmsIou: 0.5, salt: 's' };

  it('converts device pixels to CSS viewport space using the dpr', () => {
    const [out] = decodeDetections(
      [{ label: 'person', score: 0.9, rect: rect('device-px', 200, 400, 100, 100) }],
      opts,
    );
    expect(out?.rect.space).toBe('css-viewport');
    // dpr is 2, so device (200,400) is CSS (100,200).
    expect(out?.rect.x).toBe(100);
    expect(out?.rect.y).toBe(200);
  });

  it('drops boxes below the score threshold', () => {
    const out = decodeDetections(
      [{ label: 'person', score: 0.2, rect: rect('device-px', 0, 0, 10, 10) }],
      opts,
    );
    expect(out).toEqual([]);
  });

  it('drops labels with no privacy meaning', () => {
    const out = decodeDetections(
      [{ label: 'chair', score: 0.99, rect: rect('device-px', 0, 0, 10, 10) }],
      opts,
    );
    expect(out).toEqual([]);
  });

  it('applies NMS to the decoded output', () => {
    const out = decodeDetections(
      [
        { label: 'person', score: 0.9, rect: rect('device-px', 0, 0, 100, 100) },
        { label: 'person', score: 0.8, rect: rect('device-px', 4, 4, 100, 100) },
      ],
      opts,
    );
    expect(out).toHaveLength(1);
  });

  it('never carries a raw value into vision evidence', () => {
    const [out] = decodeDetections(
      [{ label: 'person', score: 0.9, rect: rect('device-px', 0, 0, 10, 10) }],
      opts,
    );
    expect(out?.evidence.valueLength).toBe(0);
  });
});

describe('geometry guards', () => {
  it('computes IoU symmetrically', () => {
    const a = rect('css-viewport', 0, 0, 100, 100);
    const b = rect('css-viewport', 50, 50, 100, 100);
    expect(iou(a, b)).toBeCloseTo(iou(b, a), 10);
  });

  it('is zero for disjoint rects', () => {
    expect(iou(rect('css-viewport', 0, 0, 10, 10), rect('css-viewport', 50, 50, 10, 10))).toBe(0);
  });
});
