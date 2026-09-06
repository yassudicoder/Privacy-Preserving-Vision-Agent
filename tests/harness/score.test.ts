// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type Detection, detectionId, domPath, rect } from '@/contracts/index.ts';
import type { ResolvedGroundTruthItem } from '@/harness/index.ts';
import {
  allFixtureIds,
  runPipeline,
  scoreDetections,
  scoreRedaction,
} from '@/harness/index.ts';

function det(over: Partial<Detection> = {}): Detection {
  return {
    id: detectionId('d1'),
    kind: 'email',
    source: 'regex',
    confidence: 0.9,
    rect: null,
    domPath: domPath('html>body>p:nth-of-type(1)'),
    attr: null,
    nodeIndex: 0,
    textSpan: null,
    evidence: { rule: 'email-rfc-lite', valueLength: 10, valueHash: 'abc' },
    ...over,
  };
}

function truth(over: Partial<ResolvedGroundTruthItem> = {}): ResolvedGroundTruthItem {
  return {
    id: 't1',
    kind: 'email',
    mustRedact: true,
    locator: { selector: 'p' },
    domPath: domPath('html>body>p:nth-of-type(1)'),
    ...over,
  };
}

describe('scoreDetections', () => {
  it('scores a perfect match', () => {
    const s = scoreDetections([det()], [truth()]);
    expect(s.tp).toBe(1);
    expect(s.fp).toBe(0);
    expect(s.fn).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });

  it('counts a miss', () => {
    const s = scoreDetections([], [truth()]);
    expect(s.fn).toBe(1);
    expect(s.recall).toBe(0);
    expect(s.unmatchedTruth).toEqual(['t1']);
  });

  it('counts a false positive', () => {
    const s = scoreDetections([det({ domPath: domPath('html>body>div:nth-of-type(9)') })], []);
    expect(s.fp).toBe(1);
    expect(s.precision).toBe(0);
    expect(s.unmatchedFound).toHaveLength(1);
  });

  it('requires the kind to match', () => {
    const s = scoreDetections([det({ kind: 'phone' })], [truth({ kind: 'email' })]);
    expect(s.tp).toBe(0);
    expect(s.fp).toBe(1);
    expect(s.fn).toBe(1);
  });

  it('is one-to-one: two detections on one truth item do not both score', () => {
    // Without this, firing five overlapping rules at one email would read as
    // excellent recall instead of as noise.
    const s = scoreDetections([det({ id: detectionId('a') }), det({ id: detectionId('b') })], [truth()]);
    expect(s.tp).toBe(1);
    expect(s.duplicates).toBe(1);
    expect(s.precision).toBeLessThan(1);
  });

  it('matches on geometry when there is no DOM anchor', () => {
    const s = scoreDetections(
      [
        det({
          kind: 'face',
          domPath: null,
          rect: rect('css-viewport', 80, 100, 120, 120),
        }),
      ],
      [truth({ kind: 'face', domPath: null, rect: { x: 84, y: 104, width: 116, height: 114 } })],
    );
    expect(s.tp).toBe(1);
  });

  it('does not match geometry below the IoU threshold', () => {
    const s = scoreDetections(
      [det({ kind: 'face', domPath: null, rect: rect('css-viewport', 0, 0, 20, 20) })],
      [truth({ kind: 'face', domPath: null, rect: { x: 500, y: 500, width: 20, height: 20 } })],
    );
    expect(s.tp).toBe(0);
  });

  it('excludes out-of-scope truth from both recall and precision', () => {
    // A documented gap must not inflate recall by being counted as missed, and
    // must not be punished as a false positive if some rule happens to find it.
    const withGap = [truth(), truth({ id: 't2', kind: 'person-name', mustRedact: false })];
    const s = scoreDetections([det(), det({ id: detectionId('d2'), kind: 'person-name' })], withGap);
    expect(s.tp).toBe(1);
    expect(s.fn).toBe(0);
    expect(s.outOfScope).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
  });

  describe('operating point', () => {
    it('grades everything by default', () => {
      const weak = det({ id: detectionId('weak'), confidence: 0.3, domPath: domPath('nowhere') });
      const s = scoreDetections([weak], []);
      expect(s.atConfidence).toBe(0);
      expect(s.belowThreshold).toBe(0);
      expect(s.fp).toBe(1);
    });

    it('excludes sub-threshold detections and reports the count', () => {
      // A detection the system never acts on is not a claim the system makes.
      // But it must be visible, not silently discarded.
      const weak = det({ id: detectionId('weak'), confidence: 0.3, domPath: domPath('nowhere') });
      const s = scoreDetections([weak], [], { minConfidence: 0.5 });
      expect(s.fp).toBe(0);
      expect(s.precision).toBe(1);
      expect(s.belowThreshold).toBe(1);
      expect(s.atConfidence).toBe(0.5);
    });

    it('does not let the threshold rescue a genuine miss', () => {
      // Raising the bar must never improve recall.
      const s = scoreDetections([det({ confidence: 0.3 })], [truth()], { minConfidence: 0.5 });
      expect(s.recall).toBe(0);
      expect(s.fn).toBe(1);
    });
  });

  it('treats an empty problem as perfect rather than as division by zero', () => {
    const s = scoreDetections([], []);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
  });

  it('reports per-kind breakdowns', () => {
    const s = scoreDetections([det()], [truth()]);
    expect(s.byKind.email).toEqual({ precision: 1, recall: 1 });
  });
});

describe('scoreDetections against the real pipeline', () => {
  it('finds every must-redact item in login-form', () => {
    const run = runPipeline('login-form');
    const s = scoreDetections(run.result.detections, run.resolvedTruth);
    expect(s.unmatchedTruth).toEqual([]);
    expect(s.recall).toBe(1);
  });

  it('produces no false positives on the benign fixture', () => {
    const run = runPipeline('benign-docs');
    const s = scoreDetections(run.result.detections, run.resolvedTruth);
    expect(s.unmatchedFound).toEqual([]);
    expect(s.fp).toBe(0);
  });

  it('does not double-count the email found by two independent rules', () => {
    const run = runPipeline('login-form');
    const s = scoreDetections(run.result.detections, run.resolvedTruth);
    expect(s.duplicates).toBe(0);
  });

  it('is clean on checkout at the threshold that actually drives redaction', () => {
    const run = runPipeline('checkout');
    const s = scoreDetections(run.result.detections, run.resolvedTruth, {
      minConfidence: run.minConfidence,
    });
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
  });

  it('keeps the weak account-number rule below the redaction threshold', () => {
    // The order reference in checkout.html is Luhn-invalid, so it is not a card.
    // The generic long-digits rule still fires on it at low confidence. That is
    // intended - it is a review signal, not a redaction trigger - and this test
    // pins it there so nobody quietly promotes the rule and starts redacting
    // every order number on the internet.
    const run = runPipeline('checkout');
    const weak = run.result.detections.filter(
      (d) => d.evidence.rule === 'account-long-digits',
    );
    expect(weak.length).toBeGreaterThan(0);
    for (const d of weak) {
      expect(d.confidence).toBeLessThan(run.minConfidence);
    }
    expect(String(run.result.html)).toContain('1234567890123456');
  });
});

describe('scoreRedaction', () => {
  it('reports zero leaks across every fixture', () => {
    for (const id of allFixtureIds()) {
      const run = runPipeline(id);
      const s = scoreRedaction(
        run.result.html,
        run.result.log,
        run.fixture.truth,
        run.resolvedTruth,
        run.benignPaths,
      );
      expect(s.leaks, `fixture ${id} leaked`).toEqual([]);
    }
  });

  it('detects a leak when one is present', () => {
    const run = runPipeline('login-form');
    const tampered = { ...run.fixture.truth };
    // Claim something that is definitely still in the document is sensitive.
    const s = scoreRedaction(
      run.result.html,
      run.result.log,
      {
        ...tampered,
        sensitive: [
          {
            id: 'fake',
            kind: 'email',
            mustRedact: true,
            locator: { selector: 'h1' },
            literal: 'Sign in to Acme',
          },
        ],
      },
      run.resolvedTruth,
      run.benignPaths,
    );
    expect(s.leaks).toEqual(['fake']);
  });

  it('reports no over-redaction on the benign fixture', () => {
    const run = runPipeline('benign-docs');
    const s = scoreRedaction(
      run.result.html,
      run.result.log,
      run.fixture.truth,
      run.resolvedTruth,
      run.benignPaths,
    );
    expect(s.overRedacted).toEqual([]);
    expect(s.applied).toBe(0);
  });
});
