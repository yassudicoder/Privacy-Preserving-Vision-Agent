// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  type Detection,
  type VisionDetection,
  detectionId,
  domPath,
  rect,
} from '@/contracts/index.ts';
import { attachToElement, attributeRectProvider, mergeDetections, pixelOnly } from '@/redaction/index.ts';
import { runPipeline } from '@/harness/index.ts';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function domDet(over: Partial<Detection> = {}): Detection {
  return {
    id: detectionId('dom-1'),
    kind: 'face',
    source: 'dom-heuristic',
    confidence: 0.65,
    rect: rect('css-viewport', 80, 100, 120, 120),
    domPath: domPath('html>body>img:nth-of-type(1)'),
    attr: 'src',
    nodeIndex: null,
    textSpan: null,
    evidence: { rule: 'img-face', valueLength: 0, valueHash: '0' },
    ...over,
  };
}

function visionDet(over: Partial<VisionDetection> = {}): VisionDetection {
  return {
    id: detectionId('vis-1'),
    kind: 'face',
    source: 'vision',
    confidence: 0.9,
    rect: rect('css-viewport', 84, 104, 116, 114),
    label: 'person',
    evidence: { rule: 'vision-person', valueLength: 0, valueHash: '0' },
    ...over,
  };
}

describe('attachToElement', () => {
  const html = `<body>
    <div data-test-rect="0,0,1000,800">
      <img data-test-rect="80,100,120,120" src="/a.jpg" />
    </div>
  </body>`;

  it('attaches a vision box to the smallest element containing it', () => {
    // Smallest wins so a face lands on the <img>, not on the wrapping <div>.
    const el = attachToElement(domDet({ domPath: null }), doc(html), attributeRectProvider, 0.6);
    expect(el?.tagName).toBe('IMG');
  });

  it('returns null when nothing contains the box', () => {
    const el = attachToElement(
      domDet({ domPath: null, rect: rect('css-viewport', 5000, 5000, 10, 10) }),
      doc(html),
      attributeRectProvider,
      0.6,
    );
    expect(el).toBeNull();
  });

  it('returns null for a detection with no rect', () => {
    expect(
      attachToElement(domDet({ rect: null }), doc(html), attributeRectProvider, 0.6),
    ).toBeNull();
  });
});

describe('mergeDetections', () => {
  it('keeps independent detections separate', () => {
    const merged = mergeDetections([domDet()], [visionDet({ kind: 'signature', rect: rect('css-viewport', 500, 500, 50, 50) })]);
    expect(merged).toHaveLength(2);
  });

  it('collapses overlapping same-kind detections into one', () => {
    const merged = mergeDetections([domDet()], [visionDet()]);
    expect(merged).toHaveLength(1);
  });

  it('raises confidence when two independent channels agree', () => {
    // Corroboration from a genuinely different signal is evidence, not just a
    // duplicate. The merged detection should beat either input alone.
    const merged = mergeDetections([domDet({ confidence: 0.65 })], [visionDet({ confidence: 0.9 })]);
    expect(merged[0]?.confidence).toBeGreaterThan(0.9);
    expect(merged[0]?.evidence.rule).toContain('+');
  });

  it('does not raise confidence for two same-channel detections', () => {
    const merged = mergeDetections(
      [domDet({ id: detectionId('a'), confidence: 0.8 }), domDet({ id: detectionId('b'), confidence: 0.7 })],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.8);
  });

  it('never exceeds a confidence of 0.99', () => {
    const merged = mergeDetections([domDet({ confidence: 0.98 })], [visionDet({ confidence: 0.99 })]);
    expect(merged[0]?.confidence).toBeLessThanOrEqual(0.99);
  });

  it('gives a vision box a DOM path when it can be attached', () => {
    const d = doc(`<body><img data-test-rect="80,100,120,120" src="/a.jpg" /></body>`);
    const merged = mergeDetections([], [visionDet()], { doc: d });
    expect(merged[0]?.domPath).not.toBeNull();
  });

  it('leaves an unattachable vision box pixel-only', () => {
    const d = doc(`<body><p data-test-rect="0,0,10,10">hi</p></body>`);
    const merged = mergeDetections([], [visionDet()], { doc: d });
    expect(merged[0]?.domPath).toBeNull();
    expect(pixelOnly(merged)).toHaveLength(1);
  });

  it('returns detections sorted by descending confidence', () => {
    const merged = mergeDetections(
      [
        domDet({ id: detectionId('a'), confidence: 0.5, rect: rect('css-viewport', 0, 0, 10, 10), domPath: domPath('a') }),
        domDet({ id: detectionId('b'), confidence: 0.9, rect: rect('css-viewport', 900, 900, 10, 10), domPath: domPath('b') }),
      ],
      [],
    );
    expect(merged[0]?.confidence).toBe(0.9);
  });

  it('handles empty inputs', () => {
    expect(mergeDetections([], [])).toEqual([]);
  });
});

describe('merge against the profile fixture', () => {
  it('corroborates the avatar face across both channels', () => {
    const run = runPipeline('profile-pii');
    const face = run.result.detections.find((d) => d.kind === 'face');
    expect(face).toBeDefined();
    // The alt text says "Profile photo" and the vision box overlaps it, so the
    // merged confidence must exceed the DOM heuristic's 0.65 on its own.
    expect(face?.confidence ?? 0).toBeGreaterThan(0.65);
  });

  it('attaches the face detection to the img element', () => {
    const run = runPipeline('profile-pii');
    const face = run.result.detections.find((d) => d.kind === 'face');
    expect(face?.domPath).not.toBeNull();
  });
});
