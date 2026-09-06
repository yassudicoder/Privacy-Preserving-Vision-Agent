import type { Backend, RgbaImage } from '@/contracts/index.ts';
import type { RawBox } from '../postprocess.ts';
import type { BackendFactory, InferenceBackend, ModelInput } from './backend.ts';

/**
 * `InferenceBackend` on top of transformers.js.
 *
 * The library is INJECTED rather than imported. Two reasons, and the second is
 * the one that matters:
 *
 *  - transformers.js pulls ONNX Runtime Web with it (~21 MB of wasm), so
 *    importing it here would put that in the dependency graph of every test that
 *    touches perception.
 *  - The interesting logic is not "call the library". It is device fallback,
 *    reporting the backend that actually won rather than the one requested,
 *    coordinate space, and refusing to emit boxes the caller cannot trust. All
 *    of that is testable in milliseconds against a fake, and none of it is
 *    testable at all if the model is a hard import.
 *
 * COORDINATE SPACE. `ModelInput.rgba` is already letterboxed into the model's
 * square by `LocalWorkerRuntime`, and the detector returns boxes in the
 * coordinates of the image it was given. So output is in model space, which is
 * exactly what `InferenceBackend` promises and what `undoLetterbox` expects.
 * This backend never sees a viewport and must never try to correct for one.
 *
 * Note that transformers.js resizes internally to whatever the processor wants,
 * so the letterboxed square gets scaled a second time. That costs a little
 * quality and no correctness - `post_process_object_detection` maps boxes back
 * to the size of the image we passed in, not to the processor's internal size.
 */

/** One detection as transformers.js reports it, in input-image pixels. */
export interface DetectionOutput {
  readonly label: string;
  readonly score: number;
  readonly box: {
    readonly xmin: number;
    readonly ymin: number;
    readonly xmax: number;
    readonly ymax: number;
  };
}

export type ObjectDetector = (
  image: unknown,
  options: { readonly threshold: number },
) => Promise<readonly DetectionOutput[]>;

/** The device strings transformers.js accepts, narrowed to the ones we use. */
export type TransformersDevice = 'webgpu' | 'wasm';

export interface PipelineOptions {
  readonly device: TransformersDevice;
  readonly dtype: 'fp32' | 'fp16' | 'q8';
}

/**
 * The slice of transformers.js this file uses. Deliberately tiny - it is the
 * whole contract a fake has to satisfy, and the whole surface a library upgrade
 * can break.
 */
export interface TransformersApi {
  /** `pipeline('object-detection', modelId, opts)`. */
  pipeline(modelId: string, opts: PipelineOptions): Promise<ObjectDetector>;
  /** `new RawImage(rgba.data, w, h, 4).rgb()`. Never touches a canvas. */
  toImage(rgba: RgbaImage): unknown;
  /** Releases the session. transformers.js exposes this on the pipeline. */
  dispose(detector: ObjectDetector): Promise<void>;
}

export interface TransformersBackendDeps {
  readonly api: TransformersApi;
  /**
   * Bytes of weights actually resident, measured after load.
   *
   * MEASURED, NOT DECLARED - the interface says so and the project has already
   * been burned once by a byte figure that counted retries. The browser wiring
   * reads Resource Timing `decodedBodySize`, which run 3 of the spike confirmed
   * agrees exactly with an independent stream count.
   *
   * Returns null when it cannot tell. Null is reported as 0 with the caller
   * able to see it was unmeasurable, which is better than a plausible guess.
   */
  readonly measureWeightBytes: (modelId: string) => Promise<number | null>;
  /**
   * Whether wasm SIMD is available. Distinguishes 'wasm-simd' from 'wasm', which
   * is otherwise unknowable from JS - ORT picks internally and does not say.
   */
  readonly hasSimd: () => boolean;
  readonly now?: () => number;
}

/** The order devices are tried in, given a preference. */
export function devicePlan(preferred: Backend): readonly TransformersDevice[] {
  // 'stub' is not a device. Anything asking for it wants the StubPerceptionEngine,
  // not this file, but falling through to wasm is kinder than throwing.
  return preferred === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} exceeded ${ms} ms`));
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class TransformersBackend implements InferenceBackend {
  readonly backend: Backend;
  readonly modelId: string;
  readonly weightBytes: number;
  readonly inputSize: number;

  #detector: ObjectDetector | null;
  readonly #api: TransformersApi;
  readonly #threshold: number;
  readonly #inferTimeoutMs: number;

  constructor(args: {
    backend: Backend;
    modelId: string;
    weightBytes: number;
    inputSize: number;
    detector: ObjectDetector;
    api: TransformersApi;
    threshold: number;
    inferTimeoutMs: number;
  }) {
    this.backend = args.backend;
    this.modelId = args.modelId;
    this.weightBytes = args.weightBytes;
    this.inputSize = args.inputSize;
    this.#detector = args.detector;
    this.#api = args.api;
    this.#threshold = args.threshold;
    this.#inferTimeoutMs = args.inferTimeoutMs;
  }

  async infer(input: ModelInput): Promise<readonly RawBox[]> {
    const detector = this.#detector;
    if (detector === null) throw new Error('infer: backend has been disposed');

    if (input.inputSize !== this.inputSize) {
      // The letterbox transform that produced these pixels was computed for a
      // different square, so undoLetterbox would silently mis-map every box.
      throw new Error(
        `infer: input was letterboxed to ${input.inputSize} but the model wants ${this.inputSize}`,
      );
    }

    const image = this.#api.toImage(input.rgba);
    const raw = await withTimeout(
      detector(image, { threshold: this.#threshold }),
      // The INFERENCE budget, not the load budget. See EngineConfig.
      this.#inferTimeoutMs,
      'infer',
    );

    const edge = this.inputSize;
    const boxes: RawBox[] = [];
    for (const d of raw) {
      // Clamp to the square. A model may report slightly outside its own input,
      // and a negative width downstream is a much harder bug to trace than a
      // box dropped here.
      const x0 = Math.max(0, Math.min(edge, d.box.xmin));
      const y0 = Math.max(0, Math.min(edge, d.box.ymin));
      const x1 = Math.max(0, Math.min(edge, d.box.xmax));
      const y1 = Math.max(0, Math.min(edge, d.box.ymax));
      const width = x1 - x0;
      const height = y1 - y0;
      if (!(width > 0 && height > 0)) continue;
      if (!Number.isFinite(d.score)) continue;
      boxes.push({
        label: String(d.label),
        score: d.score,
        rect: { x: x0, y: y0, width, height, space: 'device-px' },
      });
    }
    return boxes;
  }

  async dispose(): Promise<void> {
    const detector = this.#detector;
    // Cleared FIRST so a second dispose, or an infer racing one, cannot reach a
    // session that is being torn down.
    this.#detector = null;
    if (detector === null) return;
    await this.#api.dispose(detector);
  }
}

/**
 * Loads a model, trying devices in order and reporting the one that won.
 *
 * `preferredBackend` is a REQUEST. WebGPU is absent in workers on some
 * platforms, disabled by policy on others, and present but unable to allocate on
 * a third set - all of which surface as a throw from `pipeline()`. Reporting the
 * request rather than the result would put a wrong number straight into the
 * resource metric.
 */
export function createTransformersBackend(deps: TransformersBackendDeps): BackendFactory {
  return async (config) => {
    const now = deps.now ?? ((): number => Date.now());
    const started = now();
    const attempts: string[] = [];

    /*
     * The model's square comes from `maxEdgePx`, which the contract calls "the
     * main latency dial" and which nothing had been reading. Making it the
     * letterbox edge is what gives it that effect: it is the resolution the
     * model actually sees, so it trades accuracy (metric 1) against latency
     * (metric 5) exactly as described, instead of sitting in the config inert.
     */
    const inputSize = Math.floor(config.maxEdgePx);
    if (!Number.isFinite(inputSize) || inputSize < 32) {
      throw new Error(`maxEdgePx must be at least 32 px, got ${String(config.maxEdgePx)}`);
    }

    for (const device of devicePlan(config.preferredBackend)) {
      try {
        const detector = await withTimeout(
          deps.api.pipeline(config.modelId, { device, dtype: 'fp32' }),
          config.timeoutMs,
          `load on ${device}`,
        );
        const measured = await deps.measureWeightBytes(config.modelId);
        const resolved: Backend =
          device === 'webgpu' ? 'webgpu' : deps.hasSimd() ? 'wasm-simd' : 'wasm';
        return new TransformersBackend({
          backend: resolved,
          modelId: config.modelId,
          weightBytes: measured ?? 0,
          inputSize,
          detector,
          api: deps.api,
          threshold: config.scoreThreshold,
          inferTimeoutMs: config.inferTimeoutMs ?? config.timeoutMs,
        });
      } catch (err) {
        attempts.push(`${device}: ${errText(err)}`);
      }
    }

    // Every attempt is named. "Model failed to load" with no detail is the kind
    // of error that costs an afternoon.
    throw new Error(
      `could not load ${config.modelId} after ${now() - started} ms - ${attempts.join('; ')}`,
    );
  };
}

/**
 * Feature-detects wasm SIMD by validating a module that uses it.
 *
 * The bytes are a minimal module whose body contains `v128.const`, which only
 * validates on an engine with SIMD. Cheaper and more truthful than a UA sniff.
 */
export function detectWasmSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}
