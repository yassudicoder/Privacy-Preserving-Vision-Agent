// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SIH_WEIGHTS } from '@/contracts/index.ts';
import {
  type BenchRun,
  CANDIDATES,
  DEFAULT_BUDGETS,
  compatibilityMatrix,
  decideScreenshotPolicy,
  normaliseCost,
  rankCandidates,
  resolveSessionPolicy,
  scoreRun,
} from '@/perception/index.ts';
import { runFixtureBenchmark } from '@/harness/index.ts';

function run(over: Partial<BenchRun> = {}): BenchRun {
  return {
    candidateId: 'm1',
    backend: 'webgpu',
    fixtureId: 'login-form',
    screenshotToServer: false,
    ok: true,
    error: null,
    scores: { visualContext: 0.8, piiF1: 0.9, redactionPrecision: 0.9 },
    measurements: {
      loadMs: 500,
      p50Ms: 100,
      p95Ms: 150,
      peakHeapMb: 100,
      weightsMb: 20,
      requestBytes: 5000,
    },
    ...over,
  };
}

describe('normaliseCost', () => {
  it('is 1 at or below target and 0 at or above the limit', () => {
    const budget = { target: 100, limit: 200 };
    expect(normaliseCost(50, budget)).toBe(1);
    expect(normaliseCost(100, budget)).toBe(1);
    expect(normaliseCost(200, budget)).toBe(0);
    expect(normaliseCost(500, budget)).toBe(0);
  });

  it('interpolates between them', () => {
    expect(normaliseCost(150, { target: 100, limit: 200 })).toBeCloseTo(0.5, 5);
  });

  it('treats a non-finite cost as the worst case', () => {
    // A failed run reports Infinity. It must score zero, not NaN.
    expect(normaliseCost(Number.POSITIVE_INFINITY, { target: 1, limit: 2 })).toBe(0);
  });
});

describe('scoreRun', () => {
  it('weights components by the SIH rubric', () => {
    const b = scoreRun(run({ measurements: { ...run().measurements, p50Ms: 1, peakHeapMb: 1, weightsMb: 1 } }));
    const expected =
      0.8 * SIH_WEIGHTS.visualContext +
      0.9 * SIH_WEIGHTS.piiDetection +
      0.9 * SIH_WEIGHTS.redactionPrecision +
      1 * SIH_WEIGHTS.clientResource +
      1 * SIH_WEIGHTS.latency;
    expect(b.total).toBeCloseTo(expected, 5);
  });

  it('scores a failed run as zero across the board', () => {
    const b = scoreRun(run({ ok: false, error: 'engine died' }));
    expect(b.total).toBe(0);
    expect(b.visualContext).toBe(0);
  });

  it('penalises a slow model even when it is accurate', () => {
    const fast = scoreRun(run());
    const slow = scoreRun(run({ measurements: { ...run().measurements, p50Ms: 3000 } }));
    expect(slow.total).toBeLessThan(fast.total);
    expect(slow.latency).toBe(0);
  });

  it('penalises a heavy model even when it is accurate', () => {
    const light = scoreRun(run());
    const heavy = scoreRun(run({ measurements: { ...run().measurements, weightsMb: 400, peakHeapMb: 900 } }));
    expect(heavy.clientResource).toBe(0);
    expect(heavy.total).toBeLessThan(light.total);
  });
});

describe('rankCandidates', () => {
  it('orders candidates by mean rubric score', () => {
    const ranked = rankCandidates([
      run({ candidateId: 'good' }),
      run({ candidateId: 'bad', scores: { visualContext: 0.1, piiF1: 0.1, redactionPrecision: 0.1 } }),
    ]);
    expect(ranked[0]?.candidateId).toBe('good');
  });

  it('groups by candidate AND backend', () => {
    const ranked = rankCandidates([
      run({ candidateId: 'm1', backend: 'webgpu' }),
      run({ candidateId: 'm1', backend: 'wasm' }),
    ]);
    expect(ranked).toHaveLength(2);
  });

  it('averages failures in as zeros rather than dropping them', () => {
    // A model that works on two of three fixtures is worse than one that works
    // on all three. Excluding its failures would hide exactly that.
    const partial = rankCandidates([
      run({ fixtureId: 'a' }),
      run({ fixtureId: 'b' }),
      run({ fixtureId: 'c', ok: false, error: 'crash' }),
    ]);
    const complete = rankCandidates([run({ fixtureId: 'a' }), run({ fixtureId: 'b' })]);
    expect(partial[0]?.rubricScore).toBeLessThan(complete[0]?.rubricScore ?? 0);
    expect(partial[0]?.failures).toBe(1);
  });
});

describe('decideScreenshotPolicy', () => {
  it('recommends sending when paired runs show a real gain', () => {
    const decision = decideScreenshotPolicy([
      run({ screenshotToServer: false, scores: { visualContext: 0.5, piiF1: 0.9, redactionPrecision: 0.9 } }),
      run({ screenshotToServer: true, scores: { visualContext: 0.95, piiF1: 0.9, redactionPrecision: 0.9 } }),
    ]);
    expect(decision.sendScreenshot).toBe(true);
    expect(decision.pairedSamples).toBe(1);
    expect(decision.margin).toBeGreaterThan(0);
  });

  it('recommends against sending when the gain is inside the margin', () => {
    const decision = decideScreenshotPolicy([
      run({ screenshotToServer: false, scores: { visualContext: 0.80, piiF1: 0.9, redactionPrecision: 0.9 } }),
      run({ screenshotToServer: true, scores: { visualContext: 0.81, piiF1: 0.9, redactionPrecision: 0.9 } }),
    ]);
    expect(decision.sendScreenshot).toBe(false);
  });

  it('recommends against sending when pixels cost latency for no accuracy gain', () => {
    const decision = decideScreenshotPolicy([
      run({ screenshotToServer: false }),
      run({ screenshotToServer: true, measurements: { ...run().measurements, p50Ms: 1200 } }),
    ]);
    expect(decision.sendScreenshot).toBe(false);
  });

  it('ignores unpaired runs', () => {
    // Comparing screenshot-on for one model against screenshot-off for another
    // measures the models, not the policy.
    const decision = decideScreenshotPolicy([
      run({ candidateId: 'a', screenshotToServer: true }),
      run({ candidateId: 'b', screenshotToServer: false }),
    ]);
    expect(decision.pairedSamples).toBe(0);
    expect(decision.sendScreenshot).toBe(false);
  });

  it('defaults to off with no data, and says so', () => {
    const decision = decideScreenshotPolicy([]);
    expect(decision.sendScreenshot).toBe(false);
    expect(decision.rationale).toContain('no paired runs');
  });
});

describe('resolveSessionPolicy', () => {
  it('is off with no report, and labels itself a fallback', () => {
    const p = resolveSessionPolicy(null);
    expect(p.sendScreenshot).toBe(false);
    expect(p.source).toBe('fallback');
    expect(p.benchmarkId).toBeNull();
  });

  it('takes the answer from the benchmark when one exists', async () => {
    const report = await runFixtureBenchmark({ fixtureIds: ['login-form'], now: 1 });
    const p = resolveSessionPolicy(report);
    expect(p.source).toBe('benchmark');
    expect(p.benchmarkId).toBe(report.id);
    expect(p.sendScreenshot).toBe(report.screenshot.sendScreenshot);
  });

  it('lets an explicit user choice win', () => {
    const p = resolveSessionPolicy(null, true);
    expect(p.sendScreenshot).toBe(true);
    expect(p.source).toBe('user-override');
  });
});

describe('runBenchmark end to end', () => {
  it('produces runs, a ranking and a screenshot decision', async () => {
    const report = await runFixtureBenchmark({ fixtureIds: ['login-form', 'checkout'], now: 1 });
    expect(report.runs.length).toBeGreaterThan(0);
    expect(report.ranking.length).toBeGreaterThan(0);
    expect(report.screenshot.rationale).toBeTruthy();
    expect(report.createdAt).toBe(1);
  });

  it('measures both screenshot modes so the decision has paired data', async () => {
    const report = await runFixtureBenchmark({ fixtureIds: ['login-form'], now: 1 });
    expect(report.runs.some((r) => r.screenshotToServer)).toBe(true);
    expect(report.runs.some((r) => !r.screenshotToServer)).toBe(true);
    expect(report.screenshot.pairedSamples).toBeGreaterThan(0);
  });

  it('charges real bytes for sending a screenshot', async () => {
    const report = await runFixtureBenchmark({ fixtureIds: ['login-form'], now: 1 });
    const on = report.runs.find((r) => r.screenshotToServer);
    const off = report.runs.find((r) => !r.screenshotToServer);
    expect(on?.measurements.requestBytes ?? 0).toBeGreaterThan(off?.measurements.requestBytes ?? 0);
  });

  it('skips a backend a candidate does not claim to support', async () => {
    const report = await runFixtureBenchmark({
      fixtureIds: ['login-form'],
      backends: ['webgpu'],
      now: 1,
    });
    expect(report.notes.join(' ')).toContain('not claimed as supported');
  });
});

describe('compatibilityMatrix', () => {
  it('reports per-browser backend support for every candidate', () => {
    const matrix = compatibilityMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    for (const row of matrix) {
      expect(row.candidateId).toBeTruthy();
      expect(typeof row.chrome).toBe('string');
      expect(typeof row.firefox).toBe('string');
    }
  });

  it('only marks a candidate verified once it has been measured', () => {
    // 'verified' means the benchmark actually ran it on that backend, and the
    // weight figure is a measurement rather than a guess from parameter count.
    // yolos-tiny earned it: the spike measured 131,139,965 bytes against a
    // ~26 MB estimate. A registry that ships claims as facts is worse than no
    // registry, so the two flags have to move together.
    for (const c of CANDIDATES) {
      const claimsVerified = c.runtimes.some((r) => r.status === 'verified');
      if (!claimsVerified) continue;
      expect(c.measured, `${c.id} claims verified without being measured`).toBe(true);
      expect(c.declaredWeightsBytes, `${c.id} is verified but has no weight figure`).not.toBeNull();
    }
  });

  it('never reports a weight figure for an unmeasured candidate', () => {
    // The inverse: an estimate must stay null rather than masquerade as data.
    for (const c of CANDIDATES) {
      if (c.measured) continue;
      expect(c.declaredWeightsBytes, `${c.id} reports weights it never measured`).toBeNull();
    }
  });
});

describe('budgets', () => {
  it('has a latency target tighter than its limit', () => {
    expect(DEFAULT_BUDGETS.latencyMs.target).toBeLessThan(DEFAULT_BUDGETS.latencyMs.limit);
    expect(DEFAULT_BUDGETS.peakHeapMb.target).toBeLessThan(DEFAULT_BUDGETS.peakHeapMb.limit);
    expect(DEFAULT_BUDGETS.weightsMb.target).toBeLessThan(DEFAULT_BUDGETS.weightsMb.limit);
  });
});
