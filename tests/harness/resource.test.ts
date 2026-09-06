// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectionId, rect, DEFAULT_BUDGET_POLICY } from '@/contracts/index.ts';
import { applyPixelOps, buildSanitizedContext, createImage, scanTextPatterns } from '@/redaction/index.ts';
import {
  allFixtureIds,
  budgetFor,
  checkBudget,
  loadBudgets,
  measureResources,
  runPipeline,
  toMemoryReading,
} from '@/harness/index.ts';

/**
 * SIH metric 4: client-side resource utilization.
 *
 * These are regression detectors, not benchmarks. Ceilings carry a tolerance
 * multiplier because a resource test that fails on a busy laptop gets deleted
 * rather than fixed, which loses the signal entirely. Headroom is asserted
 * separately so a change that eats most of the budget is visible before it
 * actually breaks the build.
 */

const budgets = loadBudgets();

async function underBudget(
  label: string,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const budget = budgetFor(budgets, label);
  expect(budget, `no budget defined for "${label}"`).not.toBeNull();
  if (budget === null) return;

  const { measurement } = await measureResources(label, fn, { repeats: 3 });
  const result = checkBudget(measurement, budget, budgets.tolerance);
  expect(result.violations).toEqual([]);
  expect(result.ok).toBe(true);
}

describe('measureResources', () => {
  it('returns the function result alongside the measurement', async () => {
    const { value, measurement } = await measureResources('t', () => 6 * 7);
    expect(value).toBe(42);
    expect(measurement.label).toBe('t');
    expect(measurement.wallMs).toBeGreaterThanOrEqual(0);
  });

  it('actually measures elapsed time', async () => {
    const { measurement } = await measureResources('sleep', async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(measurement.wallMs).toBeGreaterThan(15);
  });

  it('records a heap baseline and a peak that is never below it', async () => {
    const { measurement } = await measureResources('alloc', () => {
      const held: number[][] = [];
      for (let i = 0; i < 200; i++) held.push(new Array<number>(1000).fill(i));
      return held.length;
    });
    expect(measurement.peakHeapMb).toBeGreaterThanOrEqual(measurement.baselineHeapMb);
    expect(measurement.rssMb).toBeGreaterThan(0);
  });

  it('reports CPU time', async () => {
    // process.cpuUsage() has ~15 ms granularity on Windows, so the workload has
    // to be comfortably above that or the assertion is a coin flip.
    const { measurement } = await measureResources('cpu', () => {
      let acc = 0;
      for (let i = 0; i < 60_000_000; i++) acc += i % 7;
      return acc;
    });
    expect(Number.isFinite(measurement.cpuMs)).toBe(true);
    expect(measurement.cpuMs).toBeGreaterThan(0);
  });

  it('attributes the reading to a source rather than leaving it unexplained', () => {
    const reading = toMemoryReading({
      label: 'x',
      wallMs: 1,
      cpuMs: 1,
      peakHeapMb: 12,
      deltaHeapMb: 2,
      baselineHeapMb: 10,
      rssMb: 40,
      samples: 3,
    });
    expect(reading.mb).toBe(12);
    expect(reading.source).toBe('node-process');
    // Node's heapUsed excludes native allocations, and saying so is the point.
    expect(reading.jsHeapOnly).toBe(true);
  });
});

describe('checkBudget', () => {
  const budget = { label: 'x', maxWallMs: 100, maxDeltaHeapMb: 10, note: '' };
  const base = {
    label: 'x',
    wallMs: 50,
    cpuMs: 40,
    peakHeapMb: 20,
    deltaHeapMb: 5,
    baselineHeapMb: 15,
    rssMb: 60,
    samples: 10,
  };

  it('passes inside the budget', () => {
    expect(checkBudget(base, budget, 1).ok).toBe(true);
  });

  it('fails on a wall-time regression', () => {
    const r = checkBudget({ ...base, wallMs: 500 }, budget, 1);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toContain('exceeds ceiling');
  });

  it('fails on a heap regression', () => {
    const r = checkBudget({ ...base, deltaHeapMb: 50 }, budget, 1);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toContain('heap grew');
  });

  it('applies the tolerance multiplier', () => {
    expect(checkBudget({ ...base, wallMs: 150 }, budget, 1).ok).toBe(false);
    expect(checkBudget({ ...base, wallMs: 150 }, budget, 2).ok).toBe(true);
  });

  it('reports remaining headroom', () => {
    const r = checkBudget(base, budget, 1);
    expect(r.headroom.wallMs).toBeCloseTo(50, 5);
    expect(r.headroom.deltaHeapMb).toBeCloseTo(5, 5);
  });
});

describe('budget file', () => {
  it('defines every budget the tests below assert against', () => {
    const required = [
      'redact:all-fixtures',
      'redact:single-fixture',
      'scan:patterns-1000',
      'bake:1280x800-8ops',
      'sanitize:build-context',
    ];
    for (const label of required) {
      expect(budgetFor(budgets, label), label).not.toBeNull();
    }
  });

  it('carries a tolerance above 1 so the suite is not machine-fragile', () => {
    expect(budgets.tolerance).toBeGreaterThan(1);
  });
});

describe('the client hot path stays inside its budget', () => {
  it('redacts every fixture within budget', async () => {
    const ids = allFixtureIds();
    await underBudget('redact:all-fixtures', () => {
      for (const id of ids) runPipeline(id);
    });
  });

  it('redacts a single page within budget', async () => {
    await underBudget('redact:single-fixture', () => runPipeline('checkout'));
  });

  it('runs a thousand pattern scans within budget', async () => {
    // Guards against a catastrophically backtracking regex entering the bank.
    const text =
      'contact priya.sharma@example.com or 9876543210, card 4111111111111111, PAN ABCPD1234E';
    await underBudget('scan:patterns-1000', () => {
      for (let i = 0; i < 1000; i++) scanTextPatterns(text);
    });
  });

  it('bakes a full-viewport frame within budget', async () => {
    const img = createImage(1280, 800, 128);
    const ops = Array.from({ length: 8 }, (_, i) => ({
      detectionId: detectionId(`d${String(i)}`),
      kind: 'face' as const,
      strategy: (i % 2 === 0 ? 'blur' : 'blackout') as 'blur' | 'blackout',
      rect: rect('device-px', i * 100, i * 60, 120, 120),
      intensity: 8,
    }));
    await underBudget('bake:1280x800-8ops', () => applyPixelOps(img, ops));
  });

  it('builds the outgoing payload within budget', async () => {
    const run = runPipeline('profile-pii');
    await underBudget('sanitize:build-context', () =>
      buildSanitizedContext({
        doc: run.result.doc,
        log: run.result.log,
        detections: run.result.detections,
        budget: DEFAULT_BUDGET_POLICY,
        viewport: run.viewport,
        url: 'https://fixtures.invalid/profile',
        taskId: 't',
        step: 0,
        goal: 'read the profile',
        screenshot: null,
      }),
    );
  });
});
