/**
 * Latency instrumentation. SIH metric 5.
 *
 * Deliberately separate from resource.ts: timing is cheap and can wrap anything,
 * whereas memory sampling has real overhead and is only worth paying on the
 * paths that have a budget.
 */

export interface Timed<T> {
  readonly value: T;
  readonly ms: number;
  readonly label: string;
}

export async function timeIt<T>(label: string, fn: () => T | Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start, label };
}

export interface Distribution {
  readonly n: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) {
    return { n: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
  return {
    n: s.length,
    minMs: s[0] ?? 0,
    p50Ms: at(50),
    p95Ms: at(95),
    maxMs: s[s.length - 1] ?? 0,
    meanMs: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

/**
 * Repeat and report the distribution. p50 rather than mean is what gets quoted:
 * one scheduler hiccup should not become the headline latency number.
 */
export async function benchmarkFn(
  label: string,
  fn: () => unknown | Promise<unknown>,
  opts: { repeats?: number; warmup?: number } = {},
): Promise<{ label: string; distribution: Distribution }> {
  const repeats = opts.repeats ?? 10;
  const warmup = opts.warmup ?? 2;
  const samples: number[] = [];
  for (let i = 0; i < warmup + repeats; i++) {
    const t = await timeIt(label, fn);
    if (i >= warmup) samples.push(t.ms);
  }
  return { label, distribution: distribution(samples) };
}
