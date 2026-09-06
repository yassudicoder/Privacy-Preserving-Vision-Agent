import {
  type Backend,
  type CapturedFrame,
  type RubricWeights,
  type SessionPolicy,
  type VisionDetection,
  SIH_WEIGHTS,
} from '@/contracts/index.ts';
import { type ModelCandidate, CANDIDATES, compatibilityMatrix } from './candidates.ts';
import type { PerceptionEngine } from './engine.ts';

/**
 * Model benchmark.
 *
 * Compares candidates on the SAME fixtures across the five axes we are actually
 * graded on, and produces a ranking plus one decision as OUTPUT rather than as a
 * default: whether sending a screenshot to the server is worth what it costs.
 *
 * `scoreRun`, `rankCandidates` and `decideScreenshotPolicy` are pure and tested.
 * `runBenchmark` is the only part that needs a model, and every dependency it
 * has is injected - which is also what keeps perception/ from importing
 * harness/ and inverting the module DAG.
 */

export interface Budget {
  readonly target: number;
  readonly limit: number;
}

export interface BenchBudgets {
  /** Per-frame p50. At target you score 1, at limit you score 0. */
  readonly latencyMs: Budget;
  readonly peakHeapMb: Budget;
  readonly weightsMb: Budget;
}

export const DEFAULT_BUDGETS: BenchBudgets = {
  latencyMs: { target: 150, limit: 1500 },
  peakHeapMb: { target: 150, limit: 600 },
  weightsMb: { target: 25, limit: 250 },
};

/** Lower is better. 1 at or below target, 0 at or above limit, linear between. */
export function normaliseCost(value: number, budget: Budget): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= budget.target) return 1;
  if (value >= budget.limit) return 0;
  return 1 - (value - budget.target) / (budget.limit - budget.target);
}

export interface BenchScores {
  /** From scoreScreenContext. SIH metric 1. */
  readonly visualContext: number;
  /** F1 from scoreDetections. SIH metric 2. */
  readonly piiF1: number;
  /** From scoreRedaction. SIH metric 3. */
  readonly redactionPrecision: number;
}

export interface BenchMeasurements {
  readonly loadMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly peakHeapMb: number;
  readonly weightsMb: number;
  /** Bytes actually put on the wire for this configuration. */
  readonly requestBytes: number;
}

export interface BenchRun {
  readonly candidateId: string;
  readonly backend: Backend;
  readonly fixtureId: string;
  readonly screenshotToServer: boolean;
  readonly ok: boolean;
  readonly error: string | null;
  readonly scores: BenchScores;
  readonly measurements: BenchMeasurements;
}

export interface RubricBreakdown {
  readonly visualContext: number;
  readonly piiDetection: number;
  readonly redactionPrecision: number;
  readonly clientResource: number;
  readonly latency: number;
  readonly total: number;
}

/** One run scored against the SIH rubric. Pure. */
export function scoreRun(
  run: BenchRun,
  budgets: BenchBudgets = DEFAULT_BUDGETS,
  weights: RubricWeights = SIH_WEIGHTS,
): RubricBreakdown {
  if (!run.ok) {
    return {
      visualContext: 0,
      piiDetection: 0,
      redactionPrecision: 0,
      clientResource: 0,
      latency: 0,
      total: 0,
    };
  }

  const heap = normaliseCost(run.measurements.peakHeapMb, budgets.peakHeapMb);
  const weightsScore = normaliseCost(run.measurements.weightsMb, budgets.weightsMb);
  const clientResource = (heap + weightsScore) / 2;
  const latency = normaliseCost(run.measurements.p50Ms, budgets.latencyMs);

  const total =
    run.scores.visualContext * weights.visualContext +
    run.scores.piiF1 * weights.piiDetection +
    run.scores.redactionPrecision * weights.redactionPrecision +
    clientResource * weights.clientResource +
    latency * weights.latency;

  return {
    visualContext: run.scores.visualContext,
    piiDetection: run.scores.piiF1,
    redactionPrecision: run.scores.redactionPrecision,
    clientResource,
    latency,
    total,
  };
}

export interface RankedCandidate {
  readonly candidateId: string;
  readonly backend: Backend;
  readonly rubricScore: number;
  readonly breakdown: RubricBreakdown;
  readonly fixtures: number;
  readonly failures: number;
}

export interface RankOptions {
  readonly budgets?: BenchBudgets;
  readonly weights?: RubricWeights;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Rank by mean rubric score across fixtures, grouped by candidate+backend.
 *
 * Failed runs are averaged in as zeros rather than dropped. A model that only
 * works on three of five fixtures is worse than one that works on all five, and
 * silently excluding its failures would hide exactly that.
 */
export function rankCandidates(
  runs: readonly BenchRun[],
  opts: RankOptions = {},
): RankedCandidate[] {
  const budgets = opts.budgets ?? DEFAULT_BUDGETS;
  const weights = opts.weights ?? SIH_WEIGHTS;

  const groups = new Map<string, BenchRun[]>();
  for (const run of runs) {
    const key = `${run.candidateId}::${run.backend}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [run]);
    else list.push(run);
  }

  const ranked: RankedCandidate[] = [];
  for (const [key, list] of groups) {
    const [candidateId = '', backendRaw = 'stub'] = key.split('::');
    const breakdowns = list.map((r) => scoreRun(r, budgets, weights));
    ranked.push({
      candidateId,
      backend: backendRaw as Backend,
      rubricScore: mean(breakdowns.map((b) => b.total)),
      breakdown: {
        visualContext: mean(breakdowns.map((b) => b.visualContext)),
        piiDetection: mean(breakdowns.map((b) => b.piiDetection)),
        redactionPrecision: mean(breakdowns.map((b) => b.redactionPrecision)),
        clientResource: mean(breakdowns.map((b) => b.clientResource)),
        latency: mean(breakdowns.map((b) => b.latency)),
        total: mean(breakdowns.map((b) => b.total)),
      },
      fixtures: list.length,
      failures: list.filter((r) => !r.ok).length,
    });
  }

  return ranked.sort((a, b) => b.rubricScore - a.rubricScore);
}

// ---------------------------------------------------------------------------
// screenshot policy - an OUTPUT of the benchmark, not a default
// ---------------------------------------------------------------------------

export interface ScreenshotDecision {
  readonly sendScreenshot: boolean;
  readonly onScore: number;
  readonly offScore: number;
  readonly margin: number;
  readonly pairedSamples: number;
  readonly rationale: string;
}

export interface ScreenshotOptions extends RankOptions {
  /** How much better "on" has to be before the extra bytes and latency are justified. */
  readonly requiredMargin?: number;
}

/**
 * Decide whether pixels go to the server.
 *
 * Compares runs that differ ONLY in `screenshotToServer`, on the same candidate,
 * backend and fixture. Anything unpaired is ignored - comparing a screenshot-on
 * run of one model against a screenshot-off run of another measures the models,
 * not the policy.
 *
 * Ties go to OFF. Sending pixels is the choice that has to justify itself: it
 * costs latency, bandwidth, and it is the one path where a redaction bug leaks
 * something a human can read.
 */
export function decideScreenshotPolicy(
  runs: readonly BenchRun[],
  opts: ScreenshotOptions = {},
): ScreenshotDecision {
  const budgets = opts.budgets ?? DEFAULT_BUDGETS;
  const weights = opts.weights ?? SIH_WEIGHTS;
  const requiredMargin = opts.requiredMargin ?? 0.02;

  const byKey = new Map<string, { on?: BenchRun; off?: BenchRun }>();
  for (const run of runs) {
    const key = `${run.candidateId}::${run.backend}::${run.fixtureId}`;
    const slot = byKey.get(key) ?? {};
    if (run.screenshotToServer) slot.on = run;
    else slot.off = run;
    byKey.set(key, slot);
  }

  const onScores: number[] = [];
  const offScores: number[] = [];
  for (const slot of byKey.values()) {
    if (slot.on === undefined || slot.off === undefined) continue;
    onScores.push(scoreRun(slot.on, budgets, weights).total);
    offScores.push(scoreRun(slot.off, budgets, weights).total);
  }

  const onScore = mean(onScores);
  const offScore = mean(offScores);
  const margin = onScore - offScore;
  const pairedSamples = onScores.length;

  if (pairedSamples === 0) {
    return {
      sendScreenshot: false,
      onScore: 0,
      offScore: 0,
      margin: 0,
      pairedSamples: 0,
      rationale: 'no paired runs; defaulting to structure-only, which is the cheaper and safer side',
    };
  }

  const sendScreenshot = margin > requiredMargin;
  return {
    sendScreenshot,
    onScore,
    offScore,
    margin,
    pairedSamples,
    rationale: sendScreenshot
      ? `screenshot-on scored ${onScore.toFixed(3)} vs ${offScore.toFixed(3)} over ${String(pairedSamples)} paired runs, clearing the ${String(requiredMargin)} margin`
      : `screenshot-on scored ${onScore.toFixed(3)} vs ${offScore.toFixed(3)} over ${String(pairedSamples)} paired runs, short of the ${String(requiredMargin)} margin`,
  };
}

export interface BenchReport {
  readonly id: string;
  readonly createdAt: number;
  readonly runs: readonly BenchRun[];
  readonly ranking: readonly RankedCandidate[];
  readonly screenshot: ScreenshotDecision;
  readonly compatibility: ReturnType<typeof compatibilityMatrix>;
  readonly notes: readonly string[];
}

/**
 * The session's screenshot policy, derived from a benchmark report.
 *
 * With no report, the answer is "off" and it says so - a fallback that announces
 * itself is better than a default that looks like a decision.
 */
export function resolveSessionPolicy(
  report: BenchReport | null,
  override?: boolean,
): SessionPolicy {
  if (override !== undefined) {
    return {
      sendScreenshot: override,
      source: 'user-override',
      benchmarkId: report?.id ?? null,
      rationale: 'explicitly set by the user for this session',
    };
  }
  if (report === null) {
    return {
      sendScreenshot: false,
      source: 'fallback',
      benchmarkId: null,
      rationale: 'no benchmark report available; structure-only until one exists',
    };
  }
  return {
    sendScreenshot: report.screenshot.sendScreenshot,
    source: 'benchmark',
    benchmarkId: report.id,
    rationale: report.screenshot.rationale,
  };
}

// ---------------------------------------------------------------------------
// running it
// ---------------------------------------------------------------------------

export interface BenchFixture {
  readonly id: string;
  readonly frame: CapturedFrame;
}

export interface ResourceMeasurement {
  readonly wallMs: number;
  readonly peakHeapMb: number;
}

/**
 * Everything runBenchmark needs from outside perception/.
 * Injected rather than imported, so this module stays below harness/ in the DAG.
 */
export interface BenchDeps {
  readonly makeEngine: (candidate: ModelCandidate, backend: Backend) => PerceptionEngine;
  /** Scores one frame's detections against that fixture's ground truth. */
  readonly score: (
    fixtureId: string,
    detections: readonly VisionDetection[],
    screenshotToServer: boolean,
  ) => BenchScores;
  readonly measure: <T>(label: string, fn: () => Promise<T>) => Promise<{
    value: T;
    measurement: ResourceMeasurement;
  }>;
  readonly requestBytesFor: (fixtureId: string, screenshotToServer: boolean) => number;
}

export interface BenchPlan {
  readonly candidates?: readonly ModelCandidate[];
  readonly backends: readonly Backend[];
  readonly fixtures: readonly BenchFixture[];
  readonly repeats?: number;
  readonly warmup?: number;
  readonly screenshotModes?: readonly boolean[];
  readonly reportId?: string;
  readonly now?: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] ?? 0;
}

export async function runBenchmark(deps: BenchDeps, plan: BenchPlan): Promise<BenchReport> {
  const candidates = plan.candidates ?? CANDIDATES;
  const repeats = plan.repeats ?? 5;
  const warmup = plan.warmup ?? 1;
  const screenshotModes = plan.screenshotModes ?? [false, true];
  const runs: BenchRun[] = [];
  const notes: string[] = [];

  for (const candidate of candidates) {
    for (const backend of plan.backends) {
      const declared = candidate.runtimes.find((r) => r.backend === backend);
      if (declared === undefined || declared.status === 'unsupported') {
        notes.push(`skipped ${candidate.id} on ${backend}: not claimed as supported`);
        continue;
      }

      let engine: PerceptionEngine | null = null;
      let loadMs = 0;
      let weightsMb = 0;
      let initError: string | null = null;

      try {
        engine = deps.makeEngine(candidate, backend);
        const init = await deps.measure(`${candidate.id}:${backend}:init`, () =>
          engine!.init({
            modelId: candidate.source.repo,
            preferredBackend: backend,
            maxEdgePx: candidate.inputSize.width,
            scoreThreshold: 0.35,
            nmsIou: 0.45,
            timeoutMs: 30_000,
  inferTimeoutMs: 4_000,
          }),
        );
        loadMs = init.measurement.wallMs;
        weightsMb = init.value.weightBytes / 1048576;
      } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
      }

      for (const fixture of plan.fixtures) {
        for (const screenshotToServer of screenshotModes) {
          if (initError !== null || engine === null) {
            runs.push({
              candidateId: candidate.id,
              backend,
              fixtureId: fixture.id,
              screenshotToServer,
              ok: false,
              error: initError ?? 'engine was not created',
              scores: { visualContext: 0, piiF1: 0, redactionPrecision: 0 },
              measurements: {
                loadMs,
                p50Ms: Number.POSITIVE_INFINITY,
                p95Ms: Number.POSITIVE_INFINITY,
                peakHeapMb: Number.POSITIVE_INFINITY,
                weightsMb,
                requestBytes: 0,
              },
            });
            continue;
          }

          const samples: number[] = [];
          let peakHeapMb = 0;
          let lastDetections: readonly VisionDetection[] = [];
          let runError: string | null = null;

          try {
            for (let i = 0; i < warmup + repeats; i++) {
              const out = await deps.measure(`${candidate.id}:${backend}:${fixture.id}`, () =>
                engine!.detect(fixture.frame),
              );
              if (i >= warmup) {
                samples.push(out.measurement.wallMs);
                peakHeapMb = Math.max(peakHeapMb, out.measurement.peakHeapMb);
              }
              lastDetections = out.value.detections;
            }
          } catch (err) {
            runError = err instanceof Error ? err.message : String(err);
          }

          const sorted = [...samples].sort((a, b) => a - b);
          runs.push({
            candidateId: candidate.id,
            backend,
            fixtureId: fixture.id,
            screenshotToServer,
            ok: runError === null,
            error: runError,
            scores:
              runError === null
                ? deps.score(fixture.id, lastDetections, screenshotToServer)
                : { visualContext: 0, piiF1: 0, redactionPrecision: 0 },
            measurements: {
              loadMs,
              p50Ms: percentile(sorted, 50),
              p95Ms: percentile(sorted, 95),
              peakHeapMb,
              weightsMb,
              requestBytes: deps.requestBytesFor(fixture.id, screenshotToServer),
            },
          });
        }
      }

      if (engine !== null) {
        try {
          await engine.dispose();
        } catch {
          notes.push(`dispose failed for ${candidate.id} on ${backend}`);
        }
      }
    }
  }

  return {
    id: plan.reportId ?? 'bench-local',
    createdAt: plan.now ?? Date.now(),
    runs,
    ranking: rankCandidates(runs),
    screenshot: decideScreenshotPolicy(runs),
    compatibility: compatibilityMatrix(),
    notes,
  };
}
