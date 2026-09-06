import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_CONFIG, type EngineConfig, type RgbaImage } from '@/contracts/index.ts';
import {
  type DetectionOutput,
  type ObjectDetector,
  type TransformersApi,
  createTransformersBackend,
  detectWasmSimd,
  devicePlan,
} from '@/perception/worker/transformers-backend.ts';

/**
 * The model backend, exercised without a model.
 *
 * Everything here is the part that is NOT "call transformers.js": device
 * fallback, reporting what actually loaded, coordinate space, and refusing to
 * emit boxes the caller cannot trust. Those are the parts that go wrong quietly.
 */

const SIZE = 640;

function image(w = SIZE, h = SIZE): RgbaImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

function input(size = SIZE) {
  return { rgba: image(size, size), inputSize: size, scale: 1, pad: { top: 0, left: 0 } };
}

function det(
  label: string,
  score: number,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): DetectionOutput {
  return { label, score, box: { xmin, ymin, xmax, ymax } };
}

/** A transformers.js stand-in whose behaviour each test dictates. */
function fakeApi(opts: {
  detections?: readonly DetectionOutput[];
  failOn?: readonly string[];
  hang?: boolean;
} = {}) {
  const calls: { device: string; modelId: string }[] = [];
  const detectorCalls: { image: unknown; threshold: number }[] = [];
  const disposed: ObjectDetector[] = [];

  const detector: ObjectDetector = async (img, o) => {
    detectorCalls.push({ image: img, threshold: o.threshold });
    if (opts.hang === true) return new Promise<readonly DetectionOutput[]>(() => {});
    return opts.detections ?? [];
  };

  const api: TransformersApi = {
    pipeline: async (modelId, o) => {
      calls.push({ device: o.device, modelId });
      if (opts.failOn?.includes(o.device) === true) {
        throw new Error(`${o.device} unavailable`);
      }
      return detector;
    },
    toImage: (rgba) => ({ tag: 'raw-image', w: rgba.width, h: rgba.height }),
    dispose: async (d) => {
      disposed.push(d);
    },
  };

  return { api, calls, detectorCalls, disposed, detector };
}

const CONFIG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  modelId: 'Xenova/yolos-tiny',
  preferredBackend: 'webgpu',
  maxEdgePx: SIZE,
  scoreThreshold: 0.4,
  timeoutMs: 5000,
  inferTimeoutMs: 5000,
};

function make(deps: {
  api: TransformersApi;
  bytes?: number | null;
  simd?: boolean;
}) {
  return createTransformersBackend({
    api: deps.api,
    measureWeightBytes: () => Promise.resolve(deps.bytes === undefined ? 26_227_993 : deps.bytes),
    hasSimd: () => deps.simd ?? true,
  });
}

describe('devicePlan', () => {
  it('tries webgpu first and keeps wasm as the fallback', () => {
    expect(devicePlan('webgpu')).toEqual(['webgpu', 'wasm']);
  });

  it('does not try webgpu when it was not asked for', () => {
    // Asking for wasm and silently getting webgpu would make the resource
    // metric describe a run nobody requested.
    expect(devicePlan('wasm')).toEqual(['wasm']);
    expect(devicePlan('wasm-simd')).toEqual(['wasm']);
  });
});

describe('loading', () => {
  it('reports the device that loaded, not the one requested', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    expect(backend.backend).toBe('webgpu');
    expect(f.calls.map((c) => c.device)).toEqual(['webgpu']);
  });

  it('falls back to wasm when webgpu throws, and says so', async () => {
    const f = fakeApi({ failOn: ['webgpu'] });
    const backend = await make({ api: f.api })(CONFIG);
    // THE POINT: preferredBackend was webgpu. Reporting webgpu here would put a
    // number into the resource metric describing hardware that never ran.
    expect(backend.backend).toBe('wasm-simd');
    expect(f.calls.map((c) => c.device)).toEqual(['webgpu', 'wasm']);
  });

  it('distinguishes wasm-simd from wasm by probing, not by assuming', async () => {
    const f = fakeApi({ failOn: ['webgpu'] });
    const backend = await make({ api: f.api, simd: false })(CONFIG);
    expect(backend.backend).toBe('wasm');
  });

  it('names every failed attempt when nothing loads', async () => {
    const f = fakeApi({ failOn: ['webgpu', 'wasm'] });
    await expect(make({ api: f.api })(CONFIG)).rejects.toThrow(
      /webgpu: webgpu unavailable.*wasm: wasm unavailable/s,
    );
  });

  it('reports measured weight bytes', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api, bytes: 26_227_993 })(CONFIG);
    expect(backend.weightBytes).toBe(26_227_993);
  });

  it('reports 0 rather than a guess when bytes are unmeasurable', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api, bytes: null })(CONFIG);
    expect(backend.weightBytes).toBe(0);
  });

  it('gives up on a load that exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const api: TransformersApi = {
        pipeline: () => new Promise<ObjectDetector>(() => {}),
        toImage: () => ({}),
        dispose: async () => {},
      };
      const p = make({ api })({ ...CONFIG, timeoutMs: 100 });
      const assertion = expect(p).rejects.toThrow(/load on webgpu exceeded 100 ms/);
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('infer', () => {
  it('returns boxes in model space, untouched', async () => {
    const f = fakeApi({ detections: [det('button', 0.9, 10, 20, 110, 70)] });
    const backend = await make({ api: f.api })(CONFIG);
    const boxes = await backend.infer(input());
    expect(boxes).toEqual([
      {
        label: 'button',
        score: 0.9,
        rect: { x: 10, y: 20, width: 100, height: 50, space: 'device-px' },
      },
    ]);
  });

  it('passes the configured score threshold through', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    await backend.infer(input());
    expect(f.detectorCalls[0]?.threshold).toBe(0.4);
  });

  it('hands the detector an image built from the letterboxed pixels', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    await backend.infer(input());
    expect(f.detectorCalls[0]?.image).toEqual({ tag: 'raw-image', w: SIZE, h: SIZE });
  });

  it('clamps boxes that spill outside the model square', async () => {
    const f = fakeApi({ detections: [det('x', 0.8, -30, -10, SIZE + 90, SIZE + 5)] });
    const backend = await make({ api: f.api })(CONFIG);
    const boxes = await backend.infer(input());
    expect(boxes[0]?.rect).toEqual({ x: 0, y: 0, width: SIZE, height: SIZE, space: 'device-px' });
  });

  it('drops degenerate and non-finite boxes instead of passing them on', async () => {
    const f = fakeApi({
      detections: [
        det('zero-width', 0.9, 40, 40, 40, 90),
        det('inverted', 0.9, 90, 90, 40, 40),
        det('nan-score', Number.NaN, 10, 10, 50, 50),
        det('good', 0.7, 1, 2, 3, 4),
      ],
    });
    const backend = await make({ api: f.api })(CONFIG);
    const boxes = await backend.infer(input());
    expect(boxes.map((b) => b.label)).toEqual(['good']);
  });

  it('refuses input letterboxed to a different square', async () => {
    // The scale/pad travelling with these pixels were computed for 320, so
    // undoLetterbox would mis-map every box and nothing would look wrong.
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    await expect(backend.infer(input(320))).rejects.toThrow(
      /letterboxed to 320 but the model wants 640/,
    );
  });

  it('gives up on inference that exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeApi({ hang: true });
      const backend = await make({ api: f.api })({ ...CONFIG, inferTimeoutMs: 50 });
      const assertion = expect(backend.infer(input())).rejects.toThrow(/infer exceeded 50 ms/);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dispose', () => {
  it('releases the session', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    await backend.dispose();
    expect(f.disposed).toEqual([f.detector]);
  });

  it('is idempotent', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    await backend.dispose();
    await backend.dispose();
    expect(f.disposed).toHaveLength(1);
  });

  it('refuses to infer afterwards rather than using a torn-down session', async () => {
    const f = fakeApi();
    const backend = await make({ api: f.api })(CONFIG);
    await backend.dispose();
    await expect(backend.infer(input())).rejects.toThrow(/disposed/);
  });
});

describe('detectWasmSimd', () => {
  it('validates a real SIMD module rather than sniffing', () => {
    // Node 18+ has SIMD, so this is true here. The value of the test is that
    // the byte sequence is a module the engine accepts or rejects on its own
    // terms - if it were malformed this would be false everywhere and the
    // backend would under-report forever.
    expect(detectWasmSimd()).toBe(true);
  });
});

describe('maxEdgePx drives the model square', () => {
  it('letterboxes to the configured edge', async () => {
    // Documented in EngineConfig as "the main latency dial" and read by nothing
    // until now. Binding it to the model square is what gives it that effect.
    const f = fakeApi();
    const backend = await make({ api: f.api })({ ...CONFIG, maxEdgePx: 320 });
    expect(backend.inputSize).toBe(320);
  });

  it('refuses an edge too small to be a real input', async () => {
    const f = fakeApi();
    await expect(make({ api: f.api })({ ...CONFIG, maxEdgePx: 8 })).rejects.toThrow(
      /at least 32 px/,
    );
  });
});

describe('load and inference have separate budgets', () => {
  it('does not spend the LOAD budget on a stalled inference', async () => {
    /*
     * They shared one number, and that is why a browser step took 15 seconds
     * while the server answered in 551 ms. A packaged load is ~400 ms and a
     * forward pass ~950 ms; a single budget can suit one or the other.
     *
     * It stalled for real: with a local LLM holding 3.5 GB of a 6 GB GPU this
     * model went from ~950 ms to over 15 s, and every step paid the whole load
     * budget before giving up.
     */
    vi.useFakeTimers();
    try {
      const f = fakeApi({ hang: true });
      const backend = await make({ api: f.api })({
        ...CONFIG,
        timeoutMs: 60_000,
        inferTimeoutMs: 50,
      });
      const assertion = expect(backend.infer(input())).rejects.toThrow(/infer exceeded 50 ms/);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

