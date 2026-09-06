import type { Backend, EngineConfig } from '@/contracts/index.ts';
import type { BackendFactory, InferenceBackend, ModelInput } from './backend.ts';
import type { RawBox } from '../postprocess.ts';
import { YUNET_STRIDES, decodeYunet, rgbaToBgrChw } from './yunet-decode.ts';

/**
 * OpenCV YuNet, driven through onnxruntime-web directly.
 *
 * WHY NOT transformers.js. That library dispatches `object-detection` to seven
 * architectures - detr, rt_detr, rt_detr_v2, rf_detr, d_fine, table-transformer,
 * yolos - and YuNet is none of them. It also ships neither `config.json` nor
 * `preprocessor_config.json`, both of which the library requires. So this model
 * cannot load through `TransformersBackend` at all; it needs the session driven
 * by hand.
 *
 * WHY IT IS WORTH THAT. Measured in this runtime (onnxruntime-web, wasm EP,
 * numThreads=1, 640x640):
 *
 *   yolos-tiny  1765.8 ms   26,227,993 bytes   COCO `person`
 *   YuNet         30.3 ms      232,589 bytes   `face`
 *
 * yolos-tiny is over `DEFAULT_BUDGETS.inferMs` (1500 ms), so it scores zero on
 * the latency metric as the project's own benchmark is written. And a COCO
 * `person` box covers a whole body, so redacting it blacks out roughly 2.5x more
 * of the frame than a face box does - straight against the redaction-precision
 * metric.
 *
 * At 30 ms this needs no WebGPU, which retires rather than mitigates the
 * measured problem of the server VLM and the local model starving each other on
 * one 6 GB laptop GPU.
 *
 * The library is INJECTED rather than imported, exactly as `TransformersBackend`
 * takes its own. A static ORT import anywhere under `perception/` would be
 * pulled into Chrome's MV3 service worker through the module barrel, which is
 * the first hard constraint in CLAUDE.md and is asserted by two tests in
 * `tests/built/bundle.test.ts`.
 */

/** The slice of onnxruntime-web this backend uses. Structural, so tests can fake it. */
export interface OrtTensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?: () => Promise<void>;
}

export interface OrtApi {
  createSession(weights: Uint8Array, providers: readonly string[]): Promise<OrtSessionLike>;
  /** Builds the framework's own tensor type. Kept opaque here. */
  tensor(data: Float32Array, dims: readonly number[]): unknown;
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

function floatsOf(t: OrtTensorLike | undefined, name: string): Float32Array {
  if (t === undefined) throw new Error(`yunet: model produced no output named "${name}"`);
  const d = t.data;
  if (!(d instanceof Float32Array)) {
    throw new Error(`yunet: output "${name}" is ${typeof d}, expected Float32Array`);
  }
  return d;
}

export class YunetBackend implements InferenceBackend {
  readonly backend: Backend;
  readonly modelId: string;
  readonly weightBytes: number;
  readonly inputSize: number;

  #session: OrtSessionLike | null;
  readonly #api: OrtApi;
  readonly #inferTimeoutMs: number;

  constructor(args: {
    backend: Backend;
    modelId: string;
    weightBytes: number;
    inputSize: number;
    session: OrtSessionLike;
    api: OrtApi;
    inferTimeoutMs: number;
  }) {
    this.backend = args.backend;
    this.modelId = args.modelId;
    this.weightBytes = args.weightBytes;
    this.inputSize = args.inputSize;
    this.#session = args.session;
    this.#api = args.api;
    this.#inferTimeoutMs = args.inferTimeoutMs;
  }

  async infer(input: ModelInput): Promise<readonly RawBox[]> {
    const session = this.#session;
    if (session === null) throw new Error('yunet: infer after dispose');

    const { width, height, data } = input.rgba;
    if (width !== this.inputSize || height !== this.inputSize) {
      // letterboxImage is supposed to have produced exactly this square. A
      // mismatch here would reshape the tensor and return boxes in a coordinate
      // space undoLetterbox cannot invert.
      throw new Error(
        `yunet: input is ${String(width)}x${String(height)} but the session wants ` +
          `${String(this.inputSize)}x${String(this.inputSize)}`,
      );
    }

    /*
     * BGR, CHW, RAW 0-255. See the comment on `rgbaToBgrChw` - RGB here loses
     * roughly 83% of detections silently, with the top score barely moving.
     */
    const chw = rgbaToBgrChw(data, width, height);
    const inputName = session.inputNames[0] ?? 'input';
    const feeds: Record<string, unknown> = {
      [inputName]: this.#api.tensor(chw, [1, 3, height, width]),
    };

    const out = await withTimeout(session.run(feeds), this.#inferTimeoutMs, 'infer');

    const pick = (prefix: string): Float32Array[] =>
      YUNET_STRIDES.map((s) => {
        const name = `${prefix}_${String(s)}`;
        return floatsOf(out[name], name);
      });

    // Boxes come back in the PADDED SQUARE's own pixels, which is what
    // InferenceBackend promises and what undoLetterbox inverts. The backend
    // stays ignorant of viewports and device pixel ratios.
    return decodeYunet(
      { cls: pick('cls'), obj: pick('obj'), bbox: pick('bbox') },
      this.inputSize,
    );
  }

  async dispose(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session?.release !== undefined) await session.release();
  }
}

/** Providers to try, in order. wasm alone is enough at 30 ms. */
export function yunetProviders(preferred: Backend): readonly string[] {
  return preferred === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
}

/**
 * Loads the weights and builds the backend.
 *
 * `fetchWeights` is injected so this is testable without a network or a file
 * system, and so `weightBytes` is MEASURED from the bytes actually loaded rather
 * than declared in a config that can drift.
 */
export async function createYunetBackend(args: {
  config: EngineConfig;
  api: OrtApi;
  fetchWeights: (modelId: string) => Promise<Uint8Array>;
}): Promise<InferenceBackend> {
  const { config, api, fetchWeights } = args;

  const weights = await withTimeout(
    fetchWeights(config.modelId),
    config.timeoutMs,
    `load ${config.modelId}`,
  );
  if (weights.byteLength === 0) {
    throw new Error(`yunet: fetched 0 bytes for "${config.modelId}"`);
  }

  const providers = yunetProviders(config.preferredBackend);
  const session = await withTimeout(
    api.createSession(weights, providers),
    config.timeoutMs,
    `create session for ${config.modelId}`,
  );

  /*
   * Which provider actually won is not knowable from onnxruntime-web's public
   * surface the way transformers.js reports it, so this records the one that was
   * REQUESTED FIRST and says so rather than inventing certainty. It matters less
   * here than it did: at 30 ms on wasm there is no meaningful gap to hide.
   */
  const backend: Backend = providers[0] === 'webgpu' ? 'webgpu' : 'wasm';

  return new YunetBackend({
    backend,
    modelId: config.modelId,
    weightBytes: weights.byteLength,
    inputSize: config.maxEdgePx,
    session,
    api,
    inferTimeoutMs: config.inferTimeoutMs,
  });
}

/**
 * The shape of onnxruntime-web this project uses, kept structural.
 *
 * Typed here rather than imported so `perception` never has a static dependency
 * on ORT. That is not stylistic: `background.ts` imports the perception barrel,
 * and a static ORT import anywhere under it would pull ~21 MB of wasm into
 * Chrome's MV3 service worker - the first hard constraint in CLAUDE.md, and
 * asserted by `tests/built/bundle.test.ts`.
 */
export interface OrtModule {
  InferenceSession: {
    create(
      weights: Uint8Array,
      options: { executionProviders: readonly string[] },
    ): Promise<OrtSessionLike>;
  };
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
  env: { wasm: { numThreads: number; wasmPaths?: string } };
}

export type UrlResolver = (path: string) => string;

/** Adapts the real library to the narrow surface the backend needs. */
export function ortApiFrom(mod: OrtModule): OrtApi {
  return {
    createSession: (weights, providers) =>
      mod.InferenceSession.create(weights, { executionProviders: [...providers] }),
    tensor: (data, dims) => new mod.Tensor('float32', data, dims),
  };
}

/**
 * Loads YuNet from the packaged weights, with no network.
 *
 * The weights ship inside the extension: `npm run vendor:model` puts them at
 * `models/<modelId>/onnx/model.onnx`, which is why the model id is a path and
 * why `tests/contracts/vendored-model.test.ts` pins the two together. A model id
 * that names no packaged file produced "could not load stub after 37 ms" once
 * already.
 */
export function createPackagedYunetFactory(mod: OrtModule, url: UrlResolver): BackendFactory {
  /*
   * Single-threaded deliberately, matching what `transformers-env.ts` pins.
   * Cross-origin isolation is not available to an extension page, so the
   * threaded build silently falls back anyway - and at ~30 ms there is nothing
   * to gain from pretending otherwise.
   */
  mod.env.wasm.numThreads = 1;
  mod.env.wasm.wasmPaths = url('wasm/');

  return async (config) =>
    createYunetBackend({
      config,
      api: ortApiFrom(mod),
      fetchWeights: async (modelId) => {
        const href = url(`models/${modelId}/onnx/model.onnx`);
        const res = await fetch(href);
        if (!res.ok) {
          throw new Error(`yunet: ${String(res.status)} fetching packaged weights at ${href}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      },
    });
}
