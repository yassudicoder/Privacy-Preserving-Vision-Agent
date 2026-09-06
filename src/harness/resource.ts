import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryReading } from '@/contracts/index.ts';

/**
 * SIH metric 4: client-side resource utilization.
 *
 * The design used to carry `peakHeapMb: number | null`, which is the same as not
 * measuring it - a null scores as nothing and nobody notices. Everything here is
 * measured, and where a platform genuinely cannot report a figure the reading
 * says which method produced it instead of going quiet.
 *
 * In Node this is `process.memoryUsage()` sampled during the run. In the browser
 * the equivalent lives in the offscreen document; the `MemorySource` union in
 * contracts/metrics.ts is what keeps the two honest about their differences.
 */

const BUDGET_PATH = join(dirname(fileURLToPath(import.meta.url)), 'budgets.json');

export interface ResourceMeasurement {
  readonly label: string;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly peakHeapMb: number;
  readonly deltaHeapMb: number;
  readonly baselineHeapMb: number;
  readonly rssMb: number;
  readonly samples: number;
}

export interface MeasureOptions {
  /** Sampling interval. Shorter catches sharper peaks and costs more overhead. */
  readonly sampleMs?: number;
  /** Repeat and take the best wall time. Damps scheduler noise on a busy machine. */
  readonly repeats?: number;
}

const MB = 1048576;

function heapMb(): number {
  return process.memoryUsage().heapUsed / MB;
}

function rssMb(): number {
  return process.memoryUsage().rss / MB;
}

/**
 * Run `fn`, sampling memory throughout.
 *
 * Peak is a sampled maximum, so it is a lower bound on the true peak - a spike
 * between two samples is invisible. Reported as such rather than as gospel.
 */
export async function measureResources<T>(
  label: string,
  fn: () => T | Promise<T>,
  opts: MeasureOptions = {},
): Promise<{ value: T; measurement: ResourceMeasurement }> {
  const sampleMs = opts.sampleMs ?? 5;
  const repeats = Math.max(1, opts.repeats ?? 1);

  // A GC before the baseline makes the delta mean something. Only available
  // under --expose-gc; absence is not fatal, it just widens the noise band.
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (maybeGc !== undefined) maybeGc();

  const baseline = heapMb();
  let peak = baseline;
  let samples = 0;

  const timer = setInterval(() => {
    samples += 1;
    const now = heapMb();
    if (now > peak) peak = now;
  }, sampleMs);
  // Do not let the sampler hold the process open.
  if (typeof timer.unref === 'function') timer.unref();

  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let value: T;
  let best = Number.POSITIVE_INFINITY;

  try {
    for (let i = 0; i < repeats; i++) {
      const iterStart = performance.now();
      value = await fn();
      best = Math.min(best, performance.now() - iterStart);
    }
  } finally {
    clearInterval(timer);
  }

  const wallMs = repeats > 1 ? best : performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const end = heapMb();
  if (end > peak) peak = end;

  return {
    // The loop above always runs at least once, so `value` is assigned.
    value: value!,
    measurement: {
      label,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      peakHeapMb: peak,
      deltaHeapMb: peak - baseline,
      baselineHeapMb: baseline,
      rssMb: rssMb(),
      samples,
    },
  };
}

/** The Node-side equivalent of what the panel shows, with its provenance attached. */
export function toMemoryReading(m: ResourceMeasurement): MemoryReading {
  return { mb: m.peakHeapMb, source: 'node-process', jsHeapOnly: true };
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

export interface Budget {
  readonly label: string;
  readonly maxWallMs: number;
  readonly maxDeltaHeapMb: number;
  readonly note: string;
}

export interface BudgetFile {
  readonly schemaVersion: 1;
  /**
   * Multiplier applied to every ceiling. CI machines and laptops differ by more
   * than a factor of two, and a resource test that fails on a busy machine gets
   * deleted rather than fixed - which loses the regression signal entirely.
   */
  readonly tolerance: number;
  readonly budgets: readonly Budget[];
}

export function loadBudgets(): BudgetFile {
  return JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as BudgetFile;
}

export interface BudgetResult {
  readonly label: string;
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly measurement: ResourceMeasurement;
  readonly headroom: { readonly wallMs: number; readonly deltaHeapMb: number };
}

export function checkBudget(
  measurement: ResourceMeasurement,
  budget: Budget,
  tolerance: number,
): BudgetResult {
  const wallCeiling = budget.maxWallMs * tolerance;
  const heapCeiling = budget.maxDeltaHeapMb * tolerance;
  const violations: string[] = [];

  if (measurement.wallMs > wallCeiling) {
    violations.push(
      `${budget.label}: ${measurement.wallMs.toFixed(1)} ms exceeds ceiling ${wallCeiling.toFixed(1)} ms`,
    );
  }
  if (measurement.deltaHeapMb > heapCeiling) {
    violations.push(
      `${budget.label}: heap grew ${measurement.deltaHeapMb.toFixed(1)} MB, ceiling ${heapCeiling.toFixed(1)} MB`,
    );
  }

  return {
    label: budget.label,
    ok: violations.length === 0,
    violations,
    measurement,
    headroom: {
      wallMs: wallCeiling - measurement.wallMs,
      deltaHeapMb: heapCeiling - measurement.deltaHeapMb,
    },
  };
}

export function budgetFor(file: BudgetFile, label: string): Budget | null {
  return file.budgets.find((b) => b.label === label) ?? null;
}

/**
 * Rewrite budgets.json from observed measurements.
 *
 * Deliberately NOT wired into the test run. Auto-updating a budget on failure
 * turns a regression detector into a rubber stamp - if the number moved, that is
 * a decision someone makes on purpose, with a line in DECISIONS.md.
 * Run with RESOURCE_BUDGET_UPDATE=1 via `npm run budgets:update`.
 */
export function writeBudgets(file: BudgetFile): void {
  writeFileSync(BUDGET_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
