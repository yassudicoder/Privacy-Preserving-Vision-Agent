import type { RgbaImage } from '@/contracts/index.ts';
import type { BackendFactory } from './backend.ts';
import { createTransformersBackend, detectWasmSimd } from './transformers-backend.ts';
import type {
  DetectionOutput,
  ObjectDetector,
  PipelineOptions,
  TransformersApi,
} from './transformers-backend.ts';

/**
 * The real transformers.js binding.
 *
 * The library arrives as a PARAMETER, not an import, so this file costs nothing
 * to load and is covered by `npm test` like anything else. Only the entrypoint
 * that writes `import * as transformers` pays for ONNX Runtime Web (~21 MB of
 * wasm), and that is the one place where it is unavoidable.
 *
 * That matters more than it looks. `createTransformersApi` MUTATES global
 * library config, and the settings it writes decide whether weights are read off
 * disk or quietly fetched over the network. Config with that consequence should
 * be assertable, and here it is.
 *
 * The interesting decision here is WHERE THE WEIGHTS COME FROM.
 *
 * `spike/` measured a cold load of 116-202 s against the HuggingFace hub for a
 * 25 MB model. That is network latency and hub redirects, not compute - so the
 * weights are served from the extension package instead, which turns a
 * multi-minute first run into a local read. `allowRemoteModels` is false to make
 * that structural rather than a preference: if the files are missing, loading
 * fails with a clear error instead of silently reaching across the network from
 * a privacy extension, which is precisely the behaviour this project exists to
 * avoid.
 */

/** Where the model files live, relative to the extension root. */
export const MODEL_DIR = 'models/';
/** Where ORT's wasm binaries live. Same package, same reasoning. */
export const WASM_DIR = 'wasm/';

interface TransformersEnv {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  backends: { onnx: { wasm: { wasmPaths: string; numThreads?: number } } };
}

export interface TransformersModule {
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
  RawImage: new (
    data: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    channels: 1 | 2 | 3 | 4,
  ) => { rgb(): unknown };
  env: TransformersEnv;
}

/** Resolves a packaged path. Injected so this file needs no `chrome` global. */
export type UrlResolver = (path: string) => string;

/**
 * Points transformers.js at the extension package and returns the API the
 * backend needs.
 *
 * `numThreads = 1` deliberately: ORT's threaded wasm needs
 * `SharedArrayBuffer`, which needs cross-origin isolation, which an offscreen
 * document does not have. Leaving it at the default makes ORT try, fail, and
 * fall back with a console error on every load - the spike's
 * `crossOriginIsolated: false` is the same constraint showing up from the other
 * side.
 */
export function createTransformersApi(mod: TransformersModule, url: UrlResolver): TransformersApi {
  mod.env.allowRemoteModels = false;
  mod.env.allowLocalModels = true;
  mod.env.localModelPath = url(MODEL_DIR);
  mod.env.backends.onnx.wasm.wasmPaths = url(WASM_DIR);
  mod.env.backends.onnx.wasm.numThreads = 1;

  return {
    pipeline: async (modelId: string, opts: PipelineOptions): Promise<ObjectDetector> => {
      const pipe = await mod.pipeline('object-detection', modelId, {
        device: opts.device,
        dtype: opts.dtype,
      });
      const call = pipe as (
        image: unknown,
        o: { threshold: number; percentage: boolean },
      ) => Promise<unknown>;
      const detector: ObjectDetector = async (image, o) => {
        // `percentage: false` keeps boxes in the pixels of the image we passed,
        // which is the model square. Normalised output would need a second
        // conversion here and `undoLetterbox` would receive fractions.
        const out = await call(image, { threshold: o.threshold, percentage: false });
        // A single-image call returns an array. Anything else means the library
        // changed shape underneath us, and an empty result is a safer read than
        // an assertion that a non-array is a list of boxes.
        return Array.isArray(out) ? (out as DetectionOutput[]) : [];
      };
      return detector;
    },

    toImage: (rgba: RgbaImage): unknown =>
      // 4 channels in, RGB out. No canvas: `RawImage` takes the buffer directly,
      // which matters because a worker may not have one.
      new mod.RawImage(rgba.data, rgba.width, rgba.height, 4).rgb(),

    dispose: async (detector: ObjectDetector): Promise<void> => {
      const d = detector as unknown as { dispose?: () => Promise<void> };
      if (typeof d.dispose === 'function') await d.dispose();
    },
  };
}

/**
 * Bytes actually fetched for a model, from the Resource Timing buffer.
 *
 * MEASURED, NOT DECLARED. Run 3 of the spike confirmed `decodedBodySize` here
 * agrees to the byte with an independent counting-stream tally (26,227,993 both
 * ways), which is why this is trusted rather than the `Content-Length` header
 * that started this whole thread - one of the model's own files came back
 * without that header and would have counted as zero.
 *
 * Returns null when the buffer holds nothing for this model. A cross-origin
 * response without `Timing-Allow-Origin` reports 0, which is indistinguishable
 * from "not loaded" - so anything summing to 0 is reported as unmeasurable
 * rather than as a real zero.
 */
export function measureWeightBytesVia(
  getEntries: () => readonly { name: string; decodedBodySize?: number }[],
): (modelId: string) => number | null {
  return (modelId) => {
    const needle = modelId.toLowerCase();
    let total = 0;
    let seen = false;
    for (const e of getEntries()) {
      const name = e.name.toLowerCase();
      if (!name.includes(needle) && !name.includes('/models/')) continue;
      if (!name.endsWith('.onnx') && !name.endsWith('.onnx_data')) continue;
      seen = true;
      total += e.decodedBodySize ?? 0;
    }
    if (!seen || total === 0) return null;
    return total;
  };
}

/**
 * Reads the packaged weight files and reports their real size.
 *
 * WHY THIS EXISTS. Resource Timing reports `decodedBodySize: 0` for
 * extension-internal reads on Firefox, so `measureWeightBytesVia` correctly
 * returned null and the panel showed "unmeasurable" - honest, but it left the
 * resource metric (20% of the score) with no weight figure at all on one of the
 * two supported browsers.
 *
 * The files are in the extension package, so this is a local read, not a
 * network fetch. It is done ONCE, after load, and the bytes are already in the
 * disk cache from the load itself.
 *
 * Still MEASURED rather than declared: it reads the actual bytes rather than
 * trusting `vendored.json`, which records what a build step intended to fetch.
 */
export async function measurePackagedWeights(
  url: UrlResolver,
  modelId: string,
  fetchFn: (u: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>,
): Promise<number | null> {
  // The layout transformers.js expects, and the only two files that hold weights.
  const candidates = [`${MODEL_DIR}${modelId}/onnx/model.onnx`, `${MODEL_DIR}${modelId}/onnx/model.onnx_data`];
  let total = 0;
  let found = false;
  for (const path of candidates) {
    try {
      const res = await fetchFn(url(path));
      if (!res.ok) continue;
      total += (await res.arrayBuffer()).byteLength;
      found = true;
    } catch {
      // model.onnx_data is absent for single-file models. Not an error.
    }
  }
  return found && total > 0 ? total : null;
}

/**
 * Reads the Resource Timing buffer, or nothing where there is none.
 *
 * Guarded rather than assumed: this runs in an offscreen document on Chrome and
 * a background event page on Firefox, and a missing `performance` here would
 * take down model loading over a metric nobody asked for.
 */
function readResourceEntries(): readonly { name: string; decodedBodySize?: number }[] {
  try {
    const perf = (globalThis as { performance?: { getEntriesByType?: (t: string) => unknown } })
      .performance;
    const entries = perf?.getEntriesByType?.('resource');
    return Array.isArray(entries)
      ? (entries as readonly { name: string; decodedBodySize?: number }[])
      : [];
  } catch {
    return [];
  }
}

/**
 * The whole model wiring, in one call.
 *
 * Both entrypoints use this and neither may diverge from it: Chrome runs it in
 * an offscreen document, Firefox in the background event page, and a difference
 * between the two would mean the two browsers load different weights with
 * different settings while both reporting success.
 */
export function createPackagedBackendFactory(
  mod: TransformersModule,
  url: UrlResolver,
  getEntries: () => readonly { name: string; decodedBodySize?: number }[] = readResourceEntries,
): BackendFactory {
  const fromTiming = measureWeightBytesVia(getEntries);
  return createTransformersBackend({
    api: createTransformersApi(mod, url),
    /*
     * Two routes, tried in order. Resource Timing is free when it works - it
     * describes the load that actually happened - but Firefox reports 0 for
     * extension-internal reads, which is indistinguishable from "not loaded" and
     * so is correctly reported as unmeasurable. The packaged read is the
     * fallback: a local read of the same bytes, still measured rather than
     * declared.
     */
    measureWeightBytes: async (modelId) =>
      fromTiming(modelId) ?? (await measurePackagedWeights(url, modelId, (u) => fetch(u))),
    hasSimd: detectWasmSimd,
  });
}
