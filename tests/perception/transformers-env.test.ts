import { describe, expect, it } from 'vitest';
import {
  MODEL_DIR,
  WASM_DIR,
  createTransformersApi,
  measurePackagedWeights,
  measureWeightBytesVia,
} from '@/perception/worker/transformers-env.ts';

/**
 * The library binding. Testable because the library is a parameter.
 *
 * The assertions that matter are the env ones: they are what stops a privacy
 * extension reaching across the network for its own weights.
 */

function fakeModule() {
  const env = {
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: '',
    backends: { onnx: { wasm: { wasmPaths: '', numThreads: 4 } } },
  };
  const pipelineCalls: { task: string; model: string; opts: Record<string, unknown> }[] = [];
  let detectorArgs: unknown[] = [];
  const mod = {
    env,
    pipeline: async (task: string, model: string, opts: Record<string, unknown>) => {
      pipelineCalls.push({ task, model, opts });
      return async (...args: unknown[]) => {
        detectorArgs = args;
        return [{ label: 'button', score: 0.9, box: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 } }];
      };
    },
    RawImage: class {
      constructor(
        public data: Uint8ClampedArray | Uint8Array,
        public width: number,
        public height: number,
        public channels: 1 | 2 | 3 | 4,
      ) {}
      rgb(): unknown {
        return { kind: 'rgb', w: this.width, h: this.height, from: this.channels };
      }
    },
  };
  return { mod, env, pipelineCalls, args: (): unknown[] => detectorArgs };
}

describe('createTransformersApi', () => {
  it('turns remote model fetching OFF', () => {
    const { mod, env } = fakeModule();
    createTransformersApi(mod, (p) => `chrome-extension://abc/${p}`);
    // The load path must be local or fail loudly. Silently fetching 25 MB of
    // weights from a third party is the exact behaviour this extension exists
    // to avoid, and it would look like a slow first run rather than a leak.
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
  });

  it('points the loader at the packaged model and wasm directories', () => {
    const { mod, env } = fakeModule();
    createTransformersApi(mod, (p) => `chrome-extension://abc/${p}`);
    expect(env.localModelPath).toBe(`chrome-extension://abc/${MODEL_DIR}`);
    expect(env.backends.onnx.wasm.wasmPaths).toBe(`chrome-extension://abc/${WASM_DIR}`);
  });

  it('pins wasm to a single thread', () => {
    // Threaded wasm needs SharedArrayBuffer, which needs cross-origin isolation,
    // which an offscreen document does not have. The spike measured
    // crossOriginIsolated: false - this is that constraint honoured up front
    // instead of discovered as a console error on every load.
    const { mod, env } = fakeModule();
    createTransformersApi(mod, (p) => p);
    expect(env.backends.onnx.wasm.numThreads).toBe(1);
  });

  it('requests the object-detection task with the given device and dtype', async () => {
    const { mod, pipelineCalls } = fakeModule();
    const api = createTransformersApi(mod, (p) => p);
    await api.pipeline('Xenova/yolos-tiny', { device: 'webgpu', dtype: 'fp32' });
    expect(pipelineCalls).toEqual([
      {
        task: 'object-detection',
        model: 'Xenova/yolos-tiny',
        opts: { device: 'webgpu', dtype: 'fp32' },
      },
    ]);
  });

  it('asks for pixel boxes, not percentages', async () => {
    // Normalised output would reach undoLetterbox as fractions and every box
    // would land in the top-left corner of the page.
    const { mod, args } = fakeModule();
    const api = createTransformersApi(mod, (p) => p);
    const detect = await api.pipeline('m', { device: 'wasm', dtype: 'fp32' });
    await detect({}, { threshold: 0.5 });
    expect(args()[1]).toEqual({ threshold: 0.5, percentage: false });
  });

  it('builds an image from the raw buffer with no canvas', () => {
    const { mod } = fakeModule();
    const api = createTransformersApi(mod, (p) => p);
    const img = api.toImage({ width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) });
    expect(img).toEqual({ kind: 'rgb', w: 8, h: 4, from: 4 });
  });
});

describe('measureWeightBytesVia', () => {
  const entry = (name: string, decodedBodySize: number): { name: string; decodedBodySize: number } => ({
    name,
    decodedBodySize,
  });

  it('sums the model weight files', () => {
    const measure = measureWeightBytesVia(() => [
      entry('https://x/models/Xenova/yolos-tiny/onnx/model.onnx', 26_227_993),
      entry('https://x/models/Xenova/yolos-tiny/config.json', 4145),
    ]);
    // Only weights count. config.json is real bytes but not weights, and this
    // number feeds the resource metric as "weights resident".
    expect(measure('Xenova/yolos-tiny')).toBe(26_227_993);
  });

  it('adds external data files alongside the graph', () => {
    const measure = measureWeightBytesVia(() => [
      entry('https://x/models/m/onnx/model.onnx', 1000),
      entry('https://x/models/m/onnx/model.onnx_data', 25_000),
    ]);
    expect(measure('m')).toBe(26_000);
  });

  it('reports unmeasurable rather than zero when the buffer is empty', () => {
    expect(measureWeightBytesVia(() => [])('m')).toBeNull();
  });

  it('reports unmeasurable when Timing-Allow-Origin zeroed the sizes', () => {
    // A cross-origin response without that header reports 0, which is
    // indistinguishable from "never loaded". Returning 0 here would put a
    // confident, wrong number into the resource metric.
    const measure = measureWeightBytesVia(() => [entry('https://cdn/models/m/model.onnx', 0)]);
    expect(measure('m')).toBeNull();
  });
});

describe('measurePackagedWeights', () => {
  /**
   * The fallback route. Firefox reports `decodedBodySize: 0` for
   * extension-internal reads, so Resource Timing correctly says "unmeasurable"
   * there - which left the resource metric with no weight figure at all on one
   * of the two supported browsers.
   */

  const res = (bytes: number) => ({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
  });

  it('reads the real byte length of the packaged graph', async () => {
    const seen: string[] = [];
    const out = await measurePackagedWeights(
      (p) => `moz-extension://abc/${p}`,
      'Xenova/yolos-tiny',
      (u) => {
        seen.push(u);
        return Promise.resolve(res(26_227_993));
      },
    );
    // Measured, not declared: the bytes are counted, not read out of
    // vendored.json, which only records what a build step intended to fetch.
    expect(out).toBe(26_227_993 * 2); // model.onnx + model.onnx_data both present
    expect(seen[0]).toContain('models/Xenova/yolos-tiny/onnx/model.onnx');
  });

  it('tolerates a single-file model with no external data', async () => {
    const out = await measurePackagedWeights(
      (p) => p,
      'm',
      (u) =>
        u.endsWith('.onnx_data')
          ? Promise.reject(new Error('404'))
          : Promise.resolve(res(1000)),
    );
    // model.onnx_data is absent for most models. Not an error, not a zero.
    expect(out).toBe(1000);
  });

  it('reports unmeasurable when nothing is readable', async () => {
    const out = await measurePackagedWeights(
      (p) => p,
      'm',
      () => Promise.reject(new Error('gone')),
    );
    // Null, never 0 - a confident zero would land in the resource metric as a
    // model that weighs nothing.
    expect(out).toBeNull();
  });

  it('ignores a non-ok response rather than counting it as empty', async () => {
    const out = await measurePackagedWeights((p) => p, 'm', () =>
      Promise.resolve({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
    );
    expect(out).toBeNull();
  });
});

