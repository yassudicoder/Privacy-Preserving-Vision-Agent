/**
 * Metrics. Two of the five SIH criteria are measured here rather than judged,
 * so nothing in this file is allowed to be null: an unmeasured number would
 * silently score as zero, or worse, as "fine".
 *
 * Where a platform cannot report a value directly, we say so in `source` and
 * report a derived figure instead. Honest and attributable beats absent.
 */

export type Backend = 'webgpu' | 'wasm-simd' | 'wasm' | 'stub';

/** How a memory figure was obtained. Never hidden from the panel or the report. */
export type MemorySource =
  /** performance.measureUserAgentSpecificMemory(). Authoritative, needs crossOriginIsolated. */
  | 'measure-user-agent-specific-memory'
  /** performance.memory.usedJSHeapSize. Chrome only, JS heap only, coarse. */
  | 'performance-memory'
  /** process.memoryUsage(). Node harness only. */
  | 'node-process'
  /** Sum of weight bytes actually loaded + runtime arena. Used where nothing else exists (Firefox). */
  | 'derived-from-model-bytes';

export interface MemoryReading {
  readonly mb: number;
  readonly source: MemorySource;
  /** True when the figure excludes wasm/GPU memory and therefore under-reports. */
  readonly jsHeapOnly: boolean;
}

export interface LatencyBreakdown {
  readonly captureMs: number;
  readonly visionMs: number;
  readonly redactMs: number;
  readonly bakeMs: number;
  readonly serializeMs: number;
  readonly serverMs: number;
  readonly executeMs: number;
  /** Wall clock for the whole step. Not the sum of the above - they overlap. */
  readonly e2eMs: number;
}

export interface ResourceReading {
  readonly peakHeap: MemoryReading;
  readonly modelMem: MemoryReading;
  readonly backend: Backend;
  /** Bytes of the frame actually sent to the server. Zero when screenshots are off. */
  readonly frameBytes: number;
  /** Bytes of model weights resident. */
  readonly weightBytes: number;
  /** Main-thread time consumed this step. The number that decides whether the page feels janky. */
  readonly mainThreadMs: number;
}

export interface MetricsSnapshot {
  readonly latency: LatencyBreakdown;
  readonly resource: ResourceReading;
  readonly counts: {
    readonly steps: number;
    readonly detections: number;
    readonly redactions: number;
    readonly forgeriesStripped: number;
    readonly errors: number;
  };
}

export function zeroLatency(): LatencyBreakdown {
  return {
    captureMs: 0,
    visionMs: 0,
    redactMs: 0,
    bakeMs: 0,
    serializeMs: 0,
    serverMs: 0,
    executeMs: 0,
    e2eMs: 0,
  };
}

export function unmeasuredMemory(source: MemorySource = 'derived-from-model-bytes'): MemoryReading {
  return { mb: 0, source, jsHeapOnly: true };
}

export function zeroMetrics(): MetricsSnapshot {
  return {
    latency: zeroLatency(),
    resource: {
      peakHeap: unmeasuredMemory(),
      modelMem: unmeasuredMemory(),
      backend: 'stub',
      frameBytes: 0,
      weightBytes: 0,
      mainThreadMs: 0,
    },
    counts: { steps: 0, detections: 0, redactions: 0, forgeriesStripped: 0, errors: 0 },
  };
}

// ---------------------------------------------------------------------------
// SIH rubric weights. Referenced by the benchmark ranker and the scorecard so
// the tradeoffs we make are the tradeoffs we are actually graded on.
// ---------------------------------------------------------------------------

export interface RubricWeights {
  readonly visualContext: number;
  readonly piiDetection: number;
  readonly redactionPrecision: number;
  readonly clientResource: number;
  readonly latency: number;
}

export const SIH_WEIGHTS: RubricWeights = {
  visualContext: 0.25,
  piiDetection: 0.2,
  redactionPrecision: 0.2,
  clientResource: 0.2,
  latency: 0.15,
};
