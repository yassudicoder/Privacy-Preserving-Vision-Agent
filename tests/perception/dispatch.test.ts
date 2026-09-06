import { describe, expect, it } from 'vitest';
import type { CapturedFrame, EngineConfig } from '@/contracts/index.ts';
import { type WorkerRuntime, RUNTIME_COMMANDS, createRuntimeDispatch } from '@/perception/index.ts';

/**
 * The host <-> runtime protocol.
 *
 * On Chrome these payloads have crossed a JSON boundary, so by the time they
 * arrive every guarantee the type system offered is gone. This is the layer that
 * has to notice, and the tests are mostly about what it does with input that is
 * wrong rather than input that is right.
 */

function recorder(): { runtime: WorkerRuntime; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const runtime: WorkerRuntime = {
    retain: (frame) => {
      calls.push(['retain', [frame]]);
      return Promise.resolve();
    },
    release: (frameId) => {
      calls.push(['release', [frameId]]);
      return Promise.resolve();
    },
    status: () => {
      calls.push(['status', []]);
      return Promise.resolve({
        loaded: true,
        result: { backend: 'wasm', loadMs: 1, weightBytes: 2 },
        modelId: 'fake/model',
        retainedFrames: 0,
        heap: null,
      });
    },
    init: (config) => {
      calls.push(['init', [config]]);
      return Promise.resolve({ backend: 'wasm', loadMs: 1, weightBytes: 2 });
    },
    detect: (frame) => {
      calls.push(['detect', [frame]]);
      return Promise.resolve({
        frameId: frame.frameId,
        detections: [],
        backend: 'wasm',
        modelId: 'm',
        timings: { decodeMs: 0, preprocessMs: 0, inferMs: 0, postprocessMs: 0 },
      });
    },
    bake: (frameId, ops, quality) => {
      calls.push(['bake', [frameId, ops, quality]]);
      return Promise.resolve({
        base64: 'x',
        format: 'jpeg',
        width: 1,
        height: 1,
        opsApplied: ops.length,
        opsRequested: ops.length,
      });
    },
    dispose: () => {
      calls.push(['dispose', []]);
      return Promise.resolve();
    },
  };
  return { runtime, calls };
}

const CONFIG: EngineConfig = {
  modelId: 'm',
  preferredBackend: 'wasm',
  maxEdgePx: 1280,
  scoreThreshold: 0.5,
  nmsIou: 0.5,
  timeoutMs: 1000,
  inferTimeoutMs: 4_000,
};

const FRAME: CapturedFrame = {
  frameId: 'f1',
  dataUrl: 'data:,',
  encodedBytes: 0,
  natural: { width: 10, height: 10 },
  viewport: { cssWidth: 10, cssHeight: 10, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  capturedAt: 0,
};

describe('createRuntimeDispatch routes every command', () => {
  it('routes init', async () => {
    const { runtime, calls } = recorder();
    const dispatch = createRuntimeDispatch(runtime);
    const out = await dispatch('init', CONFIG);
    expect(calls[0]?.[0]).toBe('init');
    expect(out).toEqual({ backend: 'wasm', loadMs: 1, weightBytes: 2 });
  });

  it('routes detect', async () => {
    const { runtime, calls } = recorder();
    const out = (await createRuntimeDispatch(runtime)('detect', FRAME)) as { frameId: string };
    expect(calls[0]?.[0]).toBe('detect');
    expect(out.frameId).toBe('f1');
  });

  it('routes bake with its three arguments in order', async () => {
    const { runtime, calls } = recorder();
    await createRuntimeDispatch(runtime)('bake', { frameId: 'f9', ops: [], quality: 65 });
    expect(calls[0]).toEqual(['bake', ['f9', [], 65]]);
  });

  it('routes dispose and acknowledges it', async () => {
    const { runtime, calls } = recorder();
    const out = await createRuntimeDispatch(runtime)('dispose', null);
    expect(calls[0]?.[0]).toBe('dispose');
    expect(out).toEqual({ ok: true });
  });

  it('lists the commands it accepts', () => {
    // Pinned deliberately: 'status' was added so the background can ASK the
    // worker whether a model is loaded instead of trusting module state that
    // a Chrome service-worker teardown silently discards.
    expect([...RUNTIME_COMMANDS]).toEqual([
      'init',
      'status',
      'detect',
      // Added deliberately: retention used to happen ONLY inside detect, so when
      // the orchestrator's vision breaker skipped detect the frame never reached
      // the worker and the following bake failed with "no retained frame ... It
      // was never detected" - killing a step on the path that existed to keep it
      // alive. 'retain' is how the step says "hold this, I am not inferring".
      'retain',
      'bake',
      // Added deliberately: retained frames are decoded and UNREDACTED, and the
      // step that captured one is what knows when it is finished with it.
      'release',
      'dispose',
    ]);
  });
});

describe('createRuntimeDispatch refuses malformed input by name', () => {
  it('names an unknown command instead of ignoring it', async () => {
    // A silently ignored command reads as a hung pipeline, not a typo.
    const { runtime } = recorder();
    await expect(createRuntimeDispatch(runtime)('detetc', {})).rejects.toThrow(/unknown command "detetc"/);
  });

  it('rejects a non-object payload for init and detect', async () => {
    const { runtime } = recorder();
    const dispatch = createRuntimeDispatch(runtime);
    await expect(dispatch('init', 'nope')).rejects.toThrow(/"init" expects an object/);
    await expect(dispatch('detect', null)).rejects.toThrow(/"detect" expects an object/);
  });

  it('rejects a bake payload missing its frameId', async () => {
    const { runtime, calls } = recorder();
    await expect(
      createRuntimeDispatch(runtime)('bake', { ops: [], quality: 80 }),
    ).rejects.toThrow(/non-empty frameId/);
    // And nothing reached the runtime.
    expect(calls).toEqual([]);
  });

  it('rejects an empty frameId, which would otherwise look valid', async () => {
    const { runtime } = recorder();
    await expect(
      createRuntimeDispatch(runtime)('bake', { frameId: '', ops: [], quality: 80 }),
    ).rejects.toThrow(/non-empty frameId/);
  });

  it('rejects a bake payload whose ops are not an array', async () => {
    const { runtime } = recorder();
    await expect(
      createRuntimeDispatch(runtime)('bake', { frameId: 'f', ops: 'all', quality: 80 }),
    ).rejects.toThrow(/ops array/);
  });

  it('rejects a non-numeric quality', async () => {
    const { runtime } = recorder();
    const dispatch = createRuntimeDispatch(runtime);
    await expect(dispatch('bake', { frameId: 'f', ops: [], quality: '80' })).rejects.toThrow(/numeric quality/);
    await expect(dispatch('bake', { frameId: 'f', ops: [], quality: NaN })).rejects.toThrow(/numeric quality/);
  });

  it('lets a runtime failure through unchanged', async () => {
    // The dispatch layer must not turn a real failure into a protocol error.
    const runtime: WorkerRuntime = {
      release: () => Promise.resolve(),
      status: () =>
        Promise.resolve({ loaded: false, result: null, modelId: null, retainedFrames: 0, heap: null }),
      init: () => Promise.reject(new Error('no model bundled')),
      retain: () => Promise.reject(new Error('unused')),
      detect: () => Promise.reject(new Error('unused')),
      bake: () => Promise.reject(new Error('unused')),
      dispose: () => Promise.resolve(),
    };
    await expect(createRuntimeDispatch(runtime)('init', CONFIG)).rejects.toThrow(/no model bundled/);
  });
});

describe('the status command', () => {
  it('is routed to the runtime', async () => {
    /*
     * The worker is the only context that KNOWS whether a model is loaded. On
     * Chrome the offscreen document outlives the MV3 service worker, so after
     * the worker is torn down for idleness the background has forgotten
     * everything while the weights are still resident here. Without this command
     * the background offers to load 26 MB that are already in memory.
     */
    const { runtime, calls } = recorder();
    const out = await createRuntimeDispatch(runtime)('status', undefined);
    expect(calls.map((c) => c[0])).toEqual(['status']);
    expect(out).toMatchObject({ loaded: true, modelId: 'fake/model' });
  });

  it('takes no payload, so a stray one cannot change what it reports', async () => {
    const { runtime } = recorder();
    await expect(createRuntimeDispatch(runtime)('status', { loaded: false })).resolves.toMatchObject(
      { loaded: true },
    );
  });
});
