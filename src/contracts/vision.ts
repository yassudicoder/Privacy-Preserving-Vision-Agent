import type { VisionDetection } from './detection.ts';
import type { ViewportInfo } from './geometry.ts';
import type { Backend } from './metrics.ts';

/**
 * Cross-module vision types. The engine implementation lives in perception/,
 * but these shapes travel between the content script, the background worker,
 * the panel and the benchmark, so they belong to the shared contract.
 */

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'running' | 'failed' | 'disposed';

export interface EngineConfig {
  readonly modelId: string;
  readonly preferredBackend: Backend;
  /** Longest edge the frame is downscaled to before inference. The main latency dial. */
  readonly maxEdgePx: number;
  readonly scoreThreshold: number;
  readonly nmsIou: number;
  /** How long to wait for WEIGHTS TO LOAD. Seconds, legitimately. */
  readonly timeoutMs: number;
  /**
   * How long to wait for one FORWARD PASS. A different question entirely.
   *
   * These shared a single budget, and that is why a step took 15 seconds. A
   * packaged load is ~400 ms and a forward pass ~950 ms, so one number can suit
   * loading OR inference and not both: set short and the model never loads, set
   * long and a stalled inference blocks the whole step for the load budget.
   *
   * It stalls for real. With a local LLM holding 3.5 GB of a 6 GB GPU, this
   * model - competing for the same device - went from ~950 ms to over 15 s, and
   * every step paid the full 15 before degrading.
   *
   * Short on purpose: vision that cannot answer in a few seconds is not helping,
   * and `runAgentStep` degrades to an empty detection set rather than failing.
   */
  readonly inferTimeoutMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  /*
   * MUST name weights that are actually in the package.
   *
   * `transformers-env.ts` sets `allowRemoteModels = false` and
   * `localModelPath = <extension>/models/`, so this string is a PATH SEGMENT,
   * not a label: the loader resolves `models/<modelId>/config.json` and fails
   * if it is not there.
   *
   * This was `'stub'` - a placeholder that predated any real backend - and the
   * panel's Load model button sends no config, so it hit this default and asked
   * for `models/stub/config.json`. The reported error was
   * "could not load stub after 37 ms", which named the cause correctly and was
   * still missed, because nothing tied this value to the weights on disk.
   * `tests/contracts/vendored-model.test.ts` now does.
   */
  modelId: 'opencv/face_detection_yunet',
  preferredBackend: 'webgpu',
  maxEdgePx: 640,
  scoreThreshold: 0.35,
  nmsIou: 0.45,
  timeoutMs: 15_000,
  inferTimeoutMs: 4_000,
};

/**
 * A captured frame in transit.
 *
 * Carried as a data URL, not an ImageBitmap: chrome.runtime messaging is
 * JSON-serialised, so bitmaps and transferables do not survive the hop from the
 * background worker to the offscreen document.
 */
export interface CapturedFrame {
  readonly frameId: string;
  readonly dataUrl: string;
  readonly encodedBytes: number;
  readonly natural: { readonly width: number; readonly height: number };
  readonly viewport: ViewportInfo;
  readonly capturedAt: number;
}

export interface VisionTimings {
  readonly decodeMs: number;
  readonly preprocessMs: number;
  readonly inferMs: number;
  readonly postprocessMs: number;
}

export interface VisionResult {
  readonly frameId: string;
  readonly detections: readonly VisionDetection[];
  readonly backend: Backend;
  readonly modelId: string;
  readonly timings: VisionTimings;
}

export function zeroTimings(): VisionTimings {
  return { decodeMs: 0, preprocessMs: 0, inferMs: 0, postprocessMs: 0 };
}

export function totalVisionMs(t: VisionTimings): number {
  return t.decodeMs + t.preprocessMs + t.inferMs + t.postprocessMs;
}
