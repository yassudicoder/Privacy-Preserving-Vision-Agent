import { describe, expect, it } from 'vitest';
import {
  type CapturedFrame,
  type EngineConfig,
  type PixelRedactionOp,
  type RgbaImage,
  type ViewportInfo,
  detectionId,
  rect,
} from '@/contracts/index.ts';
import {
  type BakeFn,
  type FrameCodec,
  type InferenceBackend,
  type ModelInput,
  type RawBox,
  LocalWorkerRuntime,
} from '@/perception/index.ts';

/**
 * The worker runtime, tested with no model and no browser.
 *
 * Everything expensive is injected: the model behind `InferenceBackend`, image
 * decoding behind `FrameCodec`, pixel baking behind `BakeFn`. What is left is
 * the part that is easy to get wrong and impossible to see going wrong -
 * ordering, coordinate-space conversion, and whether the decoded frame is
 * retained between the two round trips instead of being decoded twice.
 *
 * `bake` is injected rather than imported because the module DAG forbids
 * perception -> redaction. This is the same move `perception/bench.ts` already
 * makes with its scorers.
 */

// ---------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------

function solidImage(width: number, height: number, value = 128): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(value);
  return { width, height, data };
}

class FakeCodec implements FrameCodec {
  readonly decoded: string[] = [];
  #image: RgbaImage;
  #fail: Error | null = null;

  constructor(image: RgbaImage) {
    this.#image = image;
  }

  failWith(err: Error): void {
    this.#fail = err;
  }

  decode(dataUrl: string): Promise<RgbaImage> {
    this.decoded.push(dataUrl);
    if (this.#fail !== null) return Promise.reject(this.#fail);
    // A fresh buffer each time, like a real decode.
    const { width, height, data } = this.#image;
    return Promise.resolve({ width, height, data: new Uint8ClampedArray(data) });
  }
}

class FakeBackend implements InferenceBackend {
  readonly backend = 'wasm' as const;
  readonly modelId = 'fake-model';
  readonly weightBytes = 1234;
  readonly inputSize: number;
  readonly inferred: ModelInput[] = [];
  disposed = false;
  #boxes: readonly RawBox[];
  #fail: Error | null = null;

  constructor(opts: { boxes?: readonly RawBox[]; inputSize?: number } = {}) {
    this.#boxes = opts.boxes ?? [];
    this.inputSize = opts.inputSize ?? 100;
  }

  failWith(err: Error): void {
    this.#fail = err;
  }

  infer(input: ModelInput): Promise<readonly RawBox[]> {
    this.inferred.push(input);
    if (this.#fail !== null) return Promise.reject(this.#fail);
    return Promise.resolve(this.#boxes);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

/** Records what it was asked to bake and returns a recognisable payload. */
function makeBake(): { fn: BakeFn; calls: { ops: number; quality: number; w: number; h: number }[] } {
  const calls: { ops: number; quality: number; w: number; h: number }[] = [];
  const fn: BakeFn = (img, ops, quality) => {
    calls.push({ ops: ops.length, quality, w: img.width, h: img.height });
    return {
      base64: `baked:${String(img.width)}x${String(img.height)}:q${String(quality)}`,
      format: 'jpeg',
      width: img.width,
      height: img.height,
      opsApplied: ops.length,
      opsRequested: ops.length,
    };
  };
  return { fn, calls };
}

/** Advances by a fixed step on every read, so durations are deterministic. */
function fakeClock(stepMs = 5): () => number {
  let t = 1000;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

const VIEWPORT: ViewportInfo = {
  cssWidth: 100,
  cssHeight: 50,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
};

function frame(id: string): CapturedFrame {
  return {
    frameId: id,
    dataUrl: `data:image/jpeg;base64,${id}`,
    encodedBytes: 100,
    natural: { width: 200, height: 100 },
    viewport: VIEWPORT,
    capturedAt: 0,
  };
}

const CONFIG: EngineConfig = {
  modelId: 'fake-model',
  preferredBackend: 'wasm',
  maxEdgePx: 1280,
  scoreThreshold: 0.5,
  nmsIou: 0.5,
  timeoutMs: 5000,
  inferTimeoutMs: 4_000,
};

function op(): PixelRedactionOp {
  return {
    detectionId: detectionId('d1'),
    kind: 'face',
    strategy: 'blackout',
    rect: rect('device-px', 0, 0, 10, 10),
    intensity: 1,
  };
}

function build(
  opts: { backend?: FakeBackend; codec?: FakeCodec; maxRetainedFrames?: number } = {},
): {
  runtime: LocalWorkerRuntime;
  backend: FakeBackend;
  codec: FakeCodec;
  bake: ReturnType<typeof makeBake>;
} {
  const backend = opts.backend ?? new FakeBackend();
  const codec = opts.codec ?? new FakeCodec(solidImage(200, 100));
  const bake = makeBake();
  const runtime = new LocalWorkerRuntime({
    codec,
    createBackend: () => Promise.resolve(backend),
    bake: bake.fn,
    now: fakeClock(),
    ...(opts.maxRetainedFrames !== undefined ? { maxRetainedFrames: opts.maxRetainedFrames } : {}),
    salt: 'test-salt',
  });
  return { runtime, backend, codec, bake };
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe('only the call that needs a model requires one', () => {
  it('rejects detect() before init()', async () => {
    // The one call that genuinely reads `#backend`.
    const { runtime } = build();
    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/init/i);
  });

  it('retains and bakes with NO model loaded', async () => {
    /*
     * THIS ASSERTION IS A REVERSAL, and deliberately so.
     *
     * It used to read `rejects bake() before init()`. That contract was
     * circular: `retain` demanded an initialised runtime "because bake requires
     * one", and `bake` demanded one for no reason at all - it looks up a
     * retained frame and hands it to `#bakeFn`, which is pure canvas work.
     * Neither function reads `#backend` or `#config`.
     *
     * The cost was the product's entire first run. Vision is off by default from
     * measurement, so the default configuration loads no model - and every step
     * still refused until the user pressed "Load model" and waited for weights
     * and a WebGPU adapter that then went unused.
     */
    const { runtime, bake } = build();
    await runtime.retain(frame('f1'));
    expect(runtime.retainedCount).toBe(1);

    const baked = await runtime.bake('f1', [], 80);
    // The fake bake echoes the frame it was handed, so this also proves the
    // FULL frame reached it rather than a letterboxed square.
    expect(baked.base64).toBe('baked:200x100:q80');
    expect(bake.calls).toHaveLength(1);
  });

  it('still says which frame is missing rather than blaming init', async () => {
    // The error a caller gets for an unretained frame must name the real cause.
    // Before, `#ready()` fired first and reported "init must be awaited" for
    // what was actually an evicted frame.
    const { runtime } = build();
    await expect(runtime.bake('never-retained', [], 80)).rejects.toThrow(/no retained frame/i);
  });

  it('reports the backend that actually won, not the one requested', async () => {
    // The config asks for webgpu; the backend that loaded says wasm. The
    // resource metric consumes this, so a guessed value is a wrong score.
    const { runtime, backend } = build();
    const result = await runtime.init({ ...CONFIG, preferredBackend: 'webgpu' });
    expect(result.backend).toBe('wasm');
    expect(result.backend).toBe(backend.backend);
    expect(result.weightBytes).toBe(1234);
    expect(result.loadMs).toBeGreaterThan(0);
  });

  it('is idempotent: a second init does not build a second backend', async () => {
    let built = 0;
    const backend = new FakeBackend();
    const bake = makeBake();
    const runtime = new LocalWorkerRuntime({
      codec: new FakeCodec(solidImage(200, 100)),
      createBackend: () => {
        built += 1;
        return Promise.resolve(backend);
      },
      bake: bake.fn,
      now: fakeClock(),
    });
    await runtime.init(CONFIG);
    await runtime.init(CONFIG);
    expect(built).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe('detect runs the frame through the model exactly once', () => {
  it('decodes the frame once and letterboxes to the backend input size', async () => {
    const { runtime, backend, codec } = build();
    await runtime.init(CONFIG);
    await runtime.detect(frame('f1'));

    expect(codec.decoded).toHaveLength(1);
    expect(backend.inferred).toHaveLength(1);

    const input = backend.inferred[0];
    expect(input?.inputSize).toBe(100);
    expect(input?.rgba.width).toBe(100);
    expect(input?.rgba.height).toBe(100);
    // 200x100 into a 100 square: half scale, 25px of vertical padding.
    expect(input?.scale).toBeCloseTo(0.5, 10);
    expect(input?.pad.top).toBeCloseTo(25, 10);
    expect(input?.pad.left).toBeCloseTo(0, 10);
  });

  it('maps a model-space box back to CSS viewport coordinates', async () => {
    /*
     * The whole point of the runtime. Worked by hand:
     *   model space      (10, 35, 20, 10)
     *   undo letterbox   scale 0.5, pad.top 25  -> device (20, 20, 40, 20)
     *   device -> css    dpr 2                  -> css    (10, 10, 20, 10)
     * If either step is skipped or applied in the wrong order the numbers
     * differ, so this pins the sequence and not just the arithmetic.
     */
    const backend = new FakeBackend({
      boxes: [{ label: 'face', score: 0.9, rect: rect('device-px', 10, 35, 20, 10) }],
    });
    const { runtime } = build({ backend });
    await runtime.init(CONFIG);
    const result = await runtime.detect(frame('f1'));

    expect(result.detections).toHaveLength(1);
    const d = result.detections[0];
    expect(d?.rect.x).toBeCloseTo(10, 6);
    expect(d?.rect.y).toBeCloseTo(10, 6);
    expect(d?.rect.width).toBeCloseTo(20, 6);
    expect(d?.rect.height).toBeCloseTo(10, 6);
    expect(d?.rect.space).toBe('css-viewport');
    expect(d?.kind).toBe('face');
    expect(d?.source).toBe('vision');
  });

  it('drops boxes below the score threshold', async () => {
    const backend = new FakeBackend({
      boxes: [
        { label: 'face', score: 0.9, rect: rect('device-px', 10, 35, 20, 10) },
        { label: 'face', score: 0.1, rect: rect('device-px', 60, 35, 20, 10) },
      ],
    });
    const { runtime } = build({ backend });
    await runtime.init(CONFIG);
    const result = await runtime.detect(frame('f1'));
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]?.confidence).toBeCloseTo(0.9, 6);
  });

  it('drops labels that map to no PII kind', async () => {
    // A COCO detector emits dozens of classes. Only the ones that mean PII are
    // detections; the rest must not become redactions.
    const backend = new FakeBackend({
      boxes: [
        { label: 'potted plant', score: 0.99, rect: rect('device-px', 10, 35, 20, 10) },
        { label: 'face', score: 0.8, rect: rect('device-px', 40, 35, 20, 10) },
      ],
    });
    const { runtime } = build({ backend });
    await runtime.init(CONFIG);
    const result = await runtime.detect(frame('f1'));
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]?.label).toBe('face');
  });

  it('reports the frame id, model id and non-negative timings', async () => {
    const { runtime } = build();
    await runtime.init(CONFIG);
    const result = await runtime.detect(frame('f7'));
    expect(result.frameId).toBe('f7');
    expect(result.modelId).toBe('fake-model');
    expect(result.backend).toBe('wasm');
    for (const key of ['decodeMs', 'preprocessMs', 'inferMs', 'postprocessMs'] as const) {
      expect(result.timings[key], key).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses a frame whose decoded size contradicts its declared natural size', async () => {
    /*
     * letterboxImage scales by the DECODED dimensions; deviceToCssViewport
     * divides by the viewport's dpr. Those two agree only while the decoded
     * frame really is the device-resolution capture that `natural` describes.
     *
     * If they diverge, every box still decodes, still looks like a plausible
     * box, and lands on the wrong pixels. There is no downstream check that
     * would notice, so the check belongs here.
     */
    const codec = new FakeCodec(solidImage(320, 240)); // claims 200x100
    const { runtime } = build({ codec });
    await runtime.init(CONFIG);
    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/natural|decoded/i);
  });

  it('propagates a backend failure instead of returning empty detections', async () => {
    // Silently returning [] would read downstream as "nothing sensitive on this
    // screen" - the most dangerous possible failure for this project.
    const backend = new FakeBackend();
    backend.failWith(new Error('webgpu device lost'));
    const { runtime } = build({ backend });
    await runtime.init(CONFIG);
    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/device lost/);
  });

  it('propagates a decode failure', async () => {
    const codec = new FakeCodec(solidImage(200, 100));
    codec.failWith(new Error('bad data url'));
    const { runtime } = build({ codec });
    await runtime.init(CONFIG);
    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/bad data url/);
  });
});

// ---------------------------------------------------------------------------
// bake - the reason detect and bake are two calls
// ---------------------------------------------------------------------------

describe('bake reuses the retained bitmap', () => {
  it('does not decode the frame a second time', async () => {
    // This is the entire justification for the two-round-trip design. If bake
    // decodes again, the design bought nothing and every agent step pays a
    // second multi-megabyte decode.
    const { runtime, codec, bake } = build();
    await runtime.init(CONFIG);
    await runtime.detect(frame('f1'));
    expect(codec.decoded).toHaveLength(1);

    const result = await runtime.bake('f1', [op(), op()], 70);
    expect(codec.decoded).toHaveLength(1); // still one
    expect(bake.calls).toHaveLength(1);
    expect(bake.calls[0]).toEqual({ ops: 2, quality: 70, w: 200, h: 100 });
    expect(result.opsApplied).toBe(2);
    expect(result.opsRequested).toBe(2);
    expect(result.base64).toBe('baked:200x100:q70');
  });

  it('bakes against the FULL frame, not the letterboxed model input', async () => {
    // The letterboxed square is the model's business. Redactions are applied in
    // the frame's own device pixels; baking the square would redact the wrong
    // region and ship a padded image to the server.
    const { runtime, bake } = build();
    await runtime.init(CONFIG);
    await runtime.detect(frame('f1'));
    await runtime.bake('f1', [op()], 80);
    expect(bake.calls[0]?.w).toBe(200);
    expect(bake.calls[0]?.h).toBe(100);
  });

  it('rejects an unknown frame id rather than baking nothing', async () => {
    const { runtime } = build();
    await runtime.init(CONFIG);
    await expect(runtime.bake('never-seen', [op()], 80)).rejects.toThrow(/frame/i);
  });

  it('rejects after the frame has been evicted', async () => {
    // A stale frameId must fail loudly. Baking against the wrong retained
    // bitmap would apply redactions computed for one screen to another.
    const { runtime } = build({ maxRetainedFrames: 2 });
    await runtime.init(CONFIG);
    await runtime.detect(frame('f1'));
    await runtime.detect(frame('f2'));
    await runtime.detect(frame('f3')); // evicts f1
    await expect(runtime.bake('f1', [op()], 80)).rejects.toThrow(/frame/i);
    await expect(runtime.bake('f3', [op()], 80)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// retention - 20% of the score is client resource use
// ---------------------------------------------------------------------------

describe('retained frames are bounded', () => {
  it('never holds more than maxRetainedFrames decoded bitmaps', async () => {
    const { runtime } = build({ maxRetainedFrames: 3 });
    await runtime.init(CONFIG);
    for (let i = 0; i < 10; i++) await runtime.detect(frame(`f${String(i)}`));
    expect(runtime.retainedCount).toBe(3);
  });

  it('re-detecting the same frame id does not grow retention', async () => {
    const { runtime } = build({ maxRetainedFrames: 3 });
    await runtime.init(CONFIG);
    await runtime.detect(frame('same'));
    await runtime.detect(frame('same'));
    await runtime.detect(frame('same'));
    expect(runtime.retainedCount).toBe(1);
  });

  it('defaults to a small bound rather than unbounded', async () => {
    const { runtime } = build();
    await runtime.init(CONFIG);
    for (let i = 0; i < 50; i++) await runtime.detect(frame(`f${String(i)}`));
    expect(runtime.retainedCount).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('dispose releases everything', () => {
  it('disposes the backend and drops retained frames', async () => {
    const { runtime, backend } = build();
    await runtime.init(CONFIG);
    await runtime.detect(frame('f1'));
    expect(runtime.retainedCount).toBe(1);

    await runtime.dispose();
    expect(backend.disposed).toBe(true);
    expect(runtime.retainedCount).toBe(0);
    await expect(runtime.bake('f1', [op()], 80)).rejects.toThrow();
  });

  it('is safe to call twice', async () => {
    const { runtime } = build();
    await runtime.init(CONFIG);
    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// a failed forward pass must not cost the screenshot
// ---------------------------------------------------------------------------

describe('a frame that failed inference is still bakeable', () => {
  /*
   * THE BUG THIS PINS. The frame used to be retained only after a successful
   * forward pass, with a comment arguing that "a frame that failed inference is
   * not a frame anyone should be able to bake against". That was written before
   * vision failure became survivable.
   *
   * It broke a real run: vision timed out, the step degraded and continued as
   * designed, and then bake failed with `no retained frame ... It was never
   * detected` - so the whole step failed, and the REDACTED screenshot was lost
   * at exactly the moment the fallback existed to keep things working.
   *
   * Baking applies pixel ops to a decoded image. The model has nothing to do
   * with it.
   */
  it('retains the frame even when the model throws', async () => {
    const backend = new FakeBackend();
    const { runtime, bake } = build({ backend });
    await runtime.init(CONFIG);
    backend.failWith(new Error('infer exceeded 4000ms'));

    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/infer/i);

    // The step degrades and still wants the redacted image.
    const result = await runtime.bake('f1', [op()], 80);
    expect(result.opsApplied).toBe(1);
    expect(bake.calls[0]).toEqual({ ops: 1, quality: 80, w: 200, h: 100 });
  });

  it('does not decode a second time on that path either', async () => {
    const backend = new FakeBackend();
    const { runtime, codec } = build({ backend });
    await runtime.init(CONFIG);
    backend.failWith(new Error('boom'));
    await expect(runtime.detect(frame('f1'))).rejects.toThrow();
    await runtime.bake('f1', [op()], 80);
    expect(codec.decoded).toHaveLength(1);
  });

  it('still refuses a frame whose decode failed, because there is nothing to bake', async () => {
    const codec = new FakeCodec(solidImage(200, 100));
    const { runtime } = build({ codec });
    await runtime.init(CONFIG);
    codec.failWith(new Error('decode failed'));
    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/decode/i);
    await expect(runtime.bake('f1', [op()], 80)).rejects.toThrow(/frame/i);
  });

  it('still refuses a frame whose decoded size disagreed with the capture', async () => {
    // The size check guards pixel ops exactly as it guards boxes: a frame that
    // decoded to the wrong dimensions would black out the wrong region.
    const codec = new FakeCodec(solidImage(640, 480));
    const { runtime } = build({ codec });
    await runtime.init(CONFIG);
    await expect(runtime.detect(frame('f1'))).rejects.toThrow(/natural size/i);
    await expect(runtime.bake('f1', [op()], 80)).rejects.toThrow(/frame/i);
  });
});

// ---------------------------------------------------------------------------
// the heap figure the resource metric rests on
// ---------------------------------------------------------------------------

describe('status reports the heap of the context the model runs in', () => {
  /*
   * The resource metric is 20% of the score and its heap half was a placeholder:
   * every step reported `0.0 MB (derived-from-model-bytes)` because nothing ever
   * supplied a sampler. It was labelled honestly - `MemorySource` exists for
   * exactly that - but a labelled placeholder is still a placeholder.
   *
   * Sampled HERE rather than in the background because this is where the model,
   * the decoded frames and the ORT arena live. A service worker's own heap says
   * nothing about any of them.
   */
  it('returns what the injected reader gives it', async () => {
    const bake = makeBake();
    const runtime = new LocalWorkerRuntime({
      codec: new FakeCodec(solidImage(200, 100)),
      createBackend: () => Promise.resolve(new FakeBackend()),
      bake: bake.fn,
      now: fakeClock(),
      salt: 's',
      readHeap: () => ({ mb: 42.5, source: 'performance-memory', jsHeapOnly: true }),
    });
    await runtime.init(CONFIG);
    const st = await runtime.status();
    expect(st.heap?.mb).toBe(42.5);
    expect(st.heap?.source).toBe('performance-memory');
    // The flag matters: performance.memory excludes the wasm arena and every GPU
    // buffer, so the figure UNDER-reports and must never read as a total.
    expect(st.heap?.jsHeapOnly).toBe(true);
  });

  it('reports null, not zero, when the environment cannot measure', async () => {
    /*
     * Firefox has no `performance.memory`. Null reads as "not measured"; zero
     * reads as "measured, and it was nothing" - which is the placeholder this
     * change exists to remove.
     */
    const { runtime } = build();
    await runtime.init(CONFIG);
    expect((await runtime.status()).heap).toBeNull();
  });

  it('samples at call time, not at construction', async () => {
    // A figure cached at startup would describe an empty runtime forever.
    let mb = 10;
    const bake = makeBake();
    const runtime = new LocalWorkerRuntime({
      codec: new FakeCodec(solidImage(200, 100)),
      createBackend: () => Promise.resolve(new FakeBackend()),
      bake: bake.fn,
      now: fakeClock(),
      salt: 's',
      readHeap: () => ({ mb, source: 'performance-memory', jsHeapOnly: true }),
    });
    await runtime.init(CONFIG);
    expect((await runtime.status()).heap?.mb).toBe(10);
    mb = 87;
    expect((await runtime.status()).heap?.mb).toBe(87);
  });
});
