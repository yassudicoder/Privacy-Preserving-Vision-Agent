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
import { bakeRedactions, createImage, regionStats } from '@/redaction/index.ts';
import {
  type BakeFn,
  type FrameCodec,
  type InferenceBackend,
  type ModelInput,
  type RawBox,
  BrowserCaptureAdapter,
  DEFAULT_CAPTURE,
  LocalWorkerRuntime,
} from '@/perception/index.ts';

/**
 * The runtime wired to the REAL redaction code, not a double.
 *
 * worker-runtime.test.ts proves the ordering and retention logic with every
 * dependency faked. That is necessary and not sufficient: a fake `BakeFn` proves
 * the runtime calls something with the right arguments, not that the real
 * `bakeRedactions` accepts them or that pixels actually change. Those are
 * exactly the two things a signature change would silently break.
 *
 * So this composes `LocalWorkerRuntime` with the genuine `bakeRedactions`,
 * `applyPixelOps` and `letterboxImage`, and asserts on the resulting PIXELS.
 * The only fake left is the model itself.
 */

const VIEWPORT: ViewportInfo = {
  cssWidth: 100,
  cssHeight: 50,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
};

const CONFIG: EngineConfig = {
  modelId: 'integration',
  preferredBackend: 'wasm',
  maxEdgePx: 1280,
  scoreThreshold: 0.5,
  nmsIou: 0.5,
  timeoutMs: 5000,
  inferTimeoutMs: 4_000,
};

/** A recognisable frame: every pixel mid-grey, fully opaque. */
function greyFrame(width: number, height: number): RgbaImage {
  const img = createImage(width, height);
  img.data.fill(128);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return img;
}

class OneShotCodec implements FrameCodec {
  calls = 0;
  readonly #img: RgbaImage;
  constructor(img: RgbaImage) {
    this.#img = img;
  }
  decode(): Promise<RgbaImage> {
    this.calls += 1;
    const { width, height, data } = this.#img;
    return Promise.resolve({ width, height, data: new Uint8ClampedArray(data) });
  }
}

class ScriptedBackend implements InferenceBackend {
  readonly backend = 'wasm' as const;
  readonly modelId = 'integration';
  readonly weightBytes = 0;
  readonly inputSize = 100;
  readonly seen: ModelInput[] = [];
  constructor(private readonly boxes: readonly RawBox[]) {}
  infer(input: ModelInput): Promise<readonly RawBox[]> {
    this.seen.push(input);
    return Promise.resolve(this.boxes);
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe('LocalWorkerRuntime composed with the real redaction pipeline', () => {
  it('detects, then blacks out real pixels in the retained frame', async () => {
    const source = greyFrame(200, 100);
    const codec = new OneShotCodec(source);

    // Model space (10, 35, 20, 10) -> device (20, 20, 40, 20) -> css (10,10,20,10).
    const backend = new ScriptedBackend([
      { label: 'face', score: 0.95, rect: rect('device-px', 10, 35, 20, 10) },
    ]);

    /*
     * The real adapter, written exactly as the entrypoint will write it: the
     * genuine bakeRedactions, with an encoder standing in for the canvas one.
     * If BakeFn and bakeRedactions ever disagree in shape, this stops compiling.
     */
    let encoded: RgbaImage | null = null;
    const bake: BakeFn = (img, ops, quality) => {
      const { screenshot } = bakeRedactions(img, ops, (out) => {
        encoded = out;
        return { base64: `q${String(quality)}:${String(out.width)}x${String(out.height)}`, format: 'jpeg' };
      });
      return {
        base64: screenshot.base64,
        format: screenshot.format,
        width: screenshot.width,
        height: screenshot.height,
        opsApplied: screenshot.opsApplied,
        opsRequested: screenshot.opsRequested,
      };
    };

    const runtime = new LocalWorkerRuntime({
      codec,
      createBackend: () => Promise.resolve(backend),
      bake,
      salt: 'integration',
    });

    await runtime.init(CONFIG);

    const frame: CapturedFrame = {
      frameId: 'integration-1',
      dataUrl: 'data:image/jpeg;base64,xx',
      encodedBytes: 10,
      natural: { width: 200, height: 100 },
      viewport: VIEWPORT,
      capturedAt: 0,
    };

    const vision = await runtime.detect(frame);

    // The model saw a real letterboxed square built by the real letterboxer.
    expect(backend.seen[0]?.rgba.width).toBe(100);
    expect(backend.seen[0]?.pad.top).toBeCloseTo(25, 10);

    // And the box came back in CSS viewport space.
    expect(vision.detections).toHaveLength(1);
    const d = vision.detections[0];
    expect(d?.rect.x).toBeCloseTo(10, 6);
    expect(d?.rect.y).toBeCloseTo(10, 6);
    expect(d?.kind).toBe('face');

    // Now bake a blackout over that detection, in DEVICE pixels.
    const ops: PixelRedactionOp[] = [
      {
        detectionId: detectionId('int-1'),
        kind: 'face',
        strategy: 'blackout',
        rect: rect('device-px', 20, 20, 40, 20),
        intensity: 1,
      },
    ];

    const baked = await runtime.bake(frame.frameId, ops, 70);

    expect(codec.calls, 'frame must be decoded exactly once across detect+bake').toBe(1);
    expect(baked.opsApplied).toBe(1);
    expect(baked.opsRequested).toBe(1);
    // Full frame dimensions, not the 100x100 letterboxed square.
    expect(baked.width).toBe(200);
    expect(baked.height).toBe(100);
    expect(baked.base64).toBe('q70:200x100');

    // The actual pixels changed. This is the assertion a fake BakeFn cannot make.
    expect(encoded).not.toBeNull();
    const out = encoded as unknown as RgbaImage;
    const inside = regionStats(out, rect('device-px', 20, 20, 40, 20));
    expect(inside.mean).toEqual([0, 0, 0]);
    // Variance collapsing to zero is what proves the region was flattened
    // rather than merely darkened.
    expect(inside.variance).toBe(0);
    expect(inside.distinctColours).toBe(1);

    // And only those pixels changed - a redactor that blacks the whole frame
    // would pass every assertion above.
    const outside = regionStats(out, rect('device-px', 120, 60, 40, 20));
    expect(outside.mean).toEqual([128, 128, 128]);
  });

  it('leaves the retained frame reusable for a second bake', async () => {
    // The orchestrator may bake more than once for one capture (e.g. a retry
    // after the merge produces different ops). Baking must not consume the frame.
    const codec = new OneShotCodec(greyFrame(60, 60));
    const backend = new ScriptedBackend([]);
    const bake: BakeFn = (img, ops) => {
      const { screenshot } = bakeRedactions(img, ops, (out) => ({
        base64: String(out.width),
        format: 'png',
      }));
      return {
        base64: screenshot.base64,
        format: screenshot.format,
        width: screenshot.width,
        height: screenshot.height,
        opsApplied: screenshot.opsApplied,
        opsRequested: screenshot.opsRequested,
      };
    };

    const runtime = new LocalWorkerRuntime({
      codec,
      createBackend: () => Promise.resolve(backend),
      bake,
    });
    await runtime.init(CONFIG);
    await runtime.detect({
      frameId: 'twice',
      dataUrl: 'data:,',
      encodedBytes: 0,
      natural: { width: 60, height: 60 },
      viewport: VIEWPORT,
      capturedAt: 0,
    });

    await expect(runtime.bake('twice', [], 80)).resolves.toBeDefined();
    await expect(runtime.bake('twice', [], 80)).resolves.toBeDefined();
    expect(codec.calls).toBe(1);
  });
});

describe('the capture adapter and the runtime agree about frame size', () => {
  it('feeds a real captured frame straight into detect without tripping the guard', async () => {
    /*
     * The seam between Item 2 and Item 1.
     *
     * BrowserCaptureAdapter derives `natural` from viewport x dpr without ever
     * decoding the image. The runtime letterboxes by the DECODED dimensions and
     * refuses the frame if the two disagree. Nothing forces those two
     * computations to match - they live in different files and neither imports
     * the other - so this asserts they do, on a frame produced by the real
     * adapter rather than a literal.
     */
    const captured = await new BrowserCaptureAdapter({
      captureVisibleTab: () => Promise.resolve('data:image/jpeg;base64,QUJDRA=='),
      now: () => 5_000,
      sleep: () => Promise.resolve(),
      newFrameId: () => 'live-1',
    }).capture(42, VIEWPORT, DEFAULT_CAPTURE);

    // viewport 100x50 at dpr 2 -> a 200x100 device-resolution frame.
    expect(captured.natural).toEqual({ width: 200, height: 100 });

    // A codec that honours what the capture declared, as a real decode would.
    const codec: FrameCodec = {
      decode: () =>
        Promise.resolve(greyFrame(captured.natural.width, captured.natural.height)),
    };
    const backend = new ScriptedBackend([
      { label: 'credit-card', score: 0.8, rect: rect('device-px', 10, 35, 20, 10) },
    ]);
    const runtime = new LocalWorkerRuntime({
      codec,
      createBackend: () => Promise.resolve(backend),
      bake: (img, ops) => ({
        base64: '',
        format: 'jpeg',
        width: img.width,
        height: img.height,
        opsApplied: ops.length,
        opsRequested: ops.length,
      }),
    });

    await runtime.init(CONFIG);
    const vision = await runtime.detect(captured);

    expect(vision.frameId).toBe('live-1');
    expect(vision.detections).toHaveLength(1);
    expect(vision.detections[0]?.kind).toBe('credit-card');
    // Same conversion chain as before, so the capture path did not perturb it.
    expect(vision.detections[0]?.rect.x).toBeCloseTo(10, 6);
    expect(vision.detections[0]?.rect.y).toBeCloseTo(10, 6);
  });
});
