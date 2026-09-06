import {
  type CapturedFrame,
  type EngineConfig,
  type PixelRedactionOp,
  type RgbaImage,
  type VisionResult,
  type MemoryReading,
  NotImplementedError,
} from '@/contracts/index.ts';
import type { InitResult } from '../engine.ts';
import { decodeDetections, undoLetterbox } from '../postprocess.ts';
import type {
  BakeFn,
  BakeResult,
  BackendFactory,
  FrameCodec,
  InferenceBackend,
} from './backend.ts';
import { letterboxImage } from './letterbox.ts';

/**
 * The inference worker.
 *
 * Lifecycle:
 *
 *   1. init(config)
 *        Load weights. Prefer WebGPU, fall back to wasm-simd, then wasm. Report
 *        the backend that actually won and the bytes actually resident - both
 *        are inputs to the resource metric and neither may be guessed.
 *
 *   2. detect(frame)
 *        Decode the data URL ONCE and keep the decoded bitmap keyed by frameId.
 *        Letterbox to the model's square input, run, undo the letterbox, and
 *        convert device-px to css-viewport.
 *
 *   3. bake(frameId, ops)
 *        Apply pixel redactions to the RETAINED bitmap from step 2 and encode.
 *
 * Why bake is a separate call rather than part of detect: the ops depend on
 * merging vision boxes with DOM detections, and the DOM lives in the content
 * script. So the flow is necessarily
 *
 *   detect -> (background merges with DOM detections) -> bake
 *
 * Two round trips, but the frame is decoded once and the large buffer never
 * crosses a context boundary. The alternative - shipping the frame back for
 * baking - pays a second decode and a second multi-megabyte serialisation on
 * every step of the agent loop.
 *
 * Pixel redaction itself is NOT reimplemented here. It is
 * `redaction/canvas-redact.ts`, injected as `BakeFn` because the module DAG
 * forbids perception -> redaction.
 */

/**
 * Whether the worker currently holds a loaded model.
 *
 * ASKED, NOT REMEMBERED. On Chrome the offscreen document outlives the MV3
 * service worker, so after the worker is torn down for idleness the background
 * has forgotten everything while the model is still resident over here. A
 * background that trusts its own module state reports "not loaded" and offers
 * to load 26 MB of weights that are already in memory.
 */
export interface RuntimeStatus {
  readonly loaded: boolean;
  /** The original init result, so the panel can show real figures after a restart. */
  readonly result: InitResult | null;
  readonly modelId: string | null;
  /** Decoded frames still retained. Useful for spotting a leak from outside. */
  readonly retainedFrames: number;
  /**
   * The heap of the context the MODEL runs in.
   *
   * Sampled here rather than in the background because that is where the model,
   * the decoded frames and the ORT arena actually live - a service worker's heap
   * says nothing about any of them. Null when the environment offers no way to
   * read it, which is honest: `MemorySource` exists precisely so a figure never
   * has to pretend to be something it is not.
   */
  readonly heap: MemoryReading | null;
}

export interface WorkerRuntime {
  /**
   * `salt` is the SESSION salt for detection evidence hashes.
   *
   * It arrives here rather than at construction because the runtime is built at
   * module scope, before any session exists. Without it the vision detections
   * fell back to a hardcoded constant while the DOM detections in the SAME log
   * used a per-session value - so half the digests in one log were reproducible
   * across sessions and machines, and half were not.
   */
  init(config: EngineConfig, salt?: string): Promise<InitResult>;
  status(): Promise<RuntimeStatus>;
  detect(frame: CapturedFrame): Promise<VisionResult>;
  /**
   * Retain a decoded frame for a later `bake`, without running the model.
   *
   * The orchestrator calls this when it has SKIPPED `detect` - the vision
   * breaker has latched - but still intends to send a redacted screenshot.
   * Without it, retention and inference are the same operation, so declining to
   * infer silently declines to redact the image too.
   */
  retain(frame: CapturedFrame): Promise<void>;
  bake(frameId: string, ops: readonly PixelRedactionOp[], quality: number): Promise<BakeResult>;
  /**
   * Drops a retained frame.
   *
   * Retained frames are DECODED and UNREDACTED - the raw pixels of whatever was
   * on screen, before any blackout was applied. Eviction used to happen only on
   * a fifth `detect` or in `dispose()`, so after a step finished, up to four
   * such buffers (~3.5 MB each at 1280x720) sat in the offscreen document with
   * no owner, until something else happened to push them out.
   *
   * The step knows when it is done with a frame. This is how it says so.
   */
  release(frameId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface LocalWorkerRuntimeDeps {
  /**
   * Reads this context's heap. Injected, so it is testable and so the runtime
   * never has to know which browser API happens to exist here.
   */
  readonly readHeap?: () => MemoryReading | null;
  readonly codec: FrameCodec;
  readonly createBackend: BackendFactory;
  readonly bake: BakeFn;
  /** Injectable so timings are deterministic under test. */
  readonly now?: () => number;
  /**
   * How many decoded frames to hold at once.
   *
   * A 1280x720 RGBA buffer is 3.5 MB, so this is a direct multiplier on resident
   * memory - 20% of the score. The default holds enough for a detect/bake pair
   * to survive a couple of interleaved steps and no more.
   */
  readonly maxRetainedFrames?: number;
  /** Per-session salt for detection evidence hashes. */
  readonly salt?: string;
}

const DEFAULT_MAX_RETAINED = 4;

export class LocalWorkerRuntime implements WorkerRuntime {
  readonly #codec: FrameCodec;
  readonly #createBackend: BackendFactory;
  readonly #bakeFn: BakeFn;
  readonly #now: () => number;
  readonly #maxRetained: number;
  /** Set at construction as a placeholder, replaced by the session salt at init. */
  #salt: string;

  #backend: InferenceBackend | null = null;
  #config: EngineConfig | null = null;
  #initResult: InitResult | null = null;
  /** Insertion-ordered, so the oldest key is the first key. */
  readonly #frames = new Map<string, RgbaImage>();
  readonly #readHeap: (() => MemoryReading | null) | undefined;

  constructor(deps: LocalWorkerRuntimeDeps) {
    this.#codec = deps.codec;
    this.#createBackend = deps.createBackend;
    this.#bakeFn = deps.bake;
    this.#now = deps.now ?? ((): number => performance.now());
    this.#maxRetained = deps.maxRetainedFrames ?? DEFAULT_MAX_RETAINED;
    /*
     * A placeholder, and deliberately named as one. The real value arrives with
     * `init`. If a digest ever appears carrying this salt it means init was
     * called without one, which is a wiring bug rather than a session.
     */
    this.#salt = deps.salt ?? 'unsalted-no-session';
    this.#readHeap = deps.readHeap;
  }

  /** Decoded frames currently held. Exposed so retention can be asserted. */
  get retainedCount(): number {
    return this.#frames.size;
  }

  async init(config: EngineConfig, salt?: string): Promise<InitResult> {
    // Idempotent: the host calls ensureStarted() before every request, and
    // reloading weights because a caller was defensive would be a disaster.
    if (this.#initResult !== null) return this.#initResult;

    // Taken on the first init, which is the one that establishes the session.
    if (salt !== undefined && salt !== '') this.#salt = salt;

    const started = this.#now();
    const backend = await this.#createBackend(config);
    const loadMs = this.#now() - started;

    this.#backend = backend;
    this.#config = config;
    this.#initResult = {
      backend: backend.backend,
      loadMs,
      weightBytes: backend.weightBytes,
    };
    return this.#initResult;
  }

  /**
   * Decode, validate, retain. The ONE place a frame enters `#frames`.
   *
   * Shared by `detect` and `retain` so there is a single implementation of
   * "what it means to accept a frame". Two copies would drift, and the drift
   * would be a frame that one path considers valid and the other does not.
   */
  async #accept(frame: CapturedFrame): Promise<{ image: RgbaImage; decodeMs: number }> {
    const t0 = this.#now();
    const image = await this.#codec.decode(frame.dataUrl);
    const decodeMs = this.#now() - t0;

    /*
     * The frame must be what capture said it was.
     *
     * letterboxImage scales by the DECODED dimensions while deviceToCssViewport
     * divides by the viewport dpr, and those two only agree while the decoded
     * frame really is the device-resolution capture that `natural` describes. A
     * divergence produces boxes that still decode, still look plausible, and
     * land on the wrong pixels - with nothing downstream able to notice. One
     * pixel of tolerance for rounding in the capture path.
     *
     * It guards pixel ops for the same reason it guards boxes, which is why it
     * lives here rather than in `detect`.
     */
    if (
      Math.abs(image.width - frame.natural.width) > 1 ||
      Math.abs(image.height - frame.natural.height) > 1
    ) {
      throw new Error(
        `decoded frame is ${String(image.width)}x${String(image.height)} but the capture ` +
          `declared natural size ${String(frame.natural.width)}x${String(frame.natural.height)}. ` +
          `Boxes and pixel ops would convert against mismatched scales.`,
      );
    }

    this.#retain(frame.frameId, image);
    return { image, decodeMs };
  }

  /**
   * Retain a frame WITHOUT running the model.
   *
   * WHY THIS EXISTS. Retention used to happen only inside `detect`. When the
   * orchestrator's vision circuit breaker skipped `detect` after three
   * consecutive failures - working exactly as designed - the frame never reached
   * this worker at all, so the subsequent `bake` threw "no retained frame ... It
   * was never detected" and took the whole step with it. The degradation path
   * destroyed the thing it existed to protect.
   *
   * Retaining before inference fixed the case where `detect` RAN and failed. It
   * could not fix the case where `detect` is never called. This is that case.
   *
   * NO LONGER REQUIRES AN INITIALISED RUNTIME, and the reason it ever did was
   * circular. This called `#ready()` "because `bake` requires one" - and `bake`
   * called it for no reason at all: it looks up a retained frame and hands it to
   * `#bakeFn`, which is `createBrowserBake`, pure canvas work that never touches
   * the weights. Neither function reads `#backend` or `#config`.
   *
   * The cost of that circle was the whole product's first-run experience. Vision
   * is OFF by default from measurement, so the default configuration runs no
   * model at all - and yet every step refused until the user pressed "Load
   * model" and waited for 232 KB of weights and a WebGPU adapter that would then
   * go unused. `detect` still requires init, which is the one call that needs it.
   */
  async retain(frame: CapturedFrame): Promise<void> {
    await this.#accept(frame);
  }

  async detect(frame: CapturedFrame): Promise<VisionResult> {
    const { backend, config } = this.#ready();

    const { image, decodeMs } = await this.#accept(frame);
    const t1 = this.#now();

    const input = letterboxImage(image, backend.inputSize);
    const t2 = this.#now();

    const raw = await backend.infer(input);
    const t3 = this.#now();

    /*
     * Model space -> device px -> css viewport, in that order.
     *
     * undoLetterbox must use the scale and pad that produced THIS input, which
     * is why they travel on ModelInput rather than being recomputed here.
     * decodeDetections then does the device -> css conversion, thresholding and
     * NMS. Doing the conversion in one place is what stops the rest of the
     * system having to guess which space a rect is in.
     */
    const mapped = raw.map((box) => ({
      ...box,
      rect: undoLetterbox(box.rect, input.pad, input.scale),
    }));

    const detections = decodeDetections(mapped, {
      viewport: frame.viewport,
      scoreThreshold: config.scoreThreshold,
      nmsIou: config.nmsIou,
      salt: this.#salt,
      idPrefix: frame.frameId,
    });
    const t4 = this.#now();

    return {
      frameId: frame.frameId,
      detections,
      backend: backend.backend,
      modelId: backend.modelId,
      timings: {
        decodeMs,
        preprocessMs: t2 - t1,
        inferMs: t3 - t2,
        postprocessMs: t4 - t3,
      },
    };
  }

  /**
   * Redact pixels on a retained frame. NEEDS NO MODEL, and never did.
   *
   * `#bakeFn` is `createBrowserBake` - `applyPixelOps` over an RGBA buffer, then
   * a downscale and an encode. It reads neither `#backend` nor `#config`. The
   * `#ready()` call that used to be here was the sole reason `retain` demanded
   * an initialised runtime too, and between them they made the model a
   * prerequisite for the DEFAULT configuration, which does not run the model.
   *
   * `async` still matters: the missing-frame check below throws, and a
   * synchronous throw from a Promise-returning method escapes the caller's
   * `.catch()` instead of rejecting. Every other failure path here is a
   * rejection, so this must be too.
   */
  async bake(
    frameId: string,
    ops: readonly PixelRedactionOp[],
    quality: number,
  ): Promise<BakeResult> {
    const image = this.#frames.get(frameId);
    if (image === undefined) {
      /*
       * Loud on purpose. The alternative - baking against whatever frame happens
       * to be retained - would apply redactions computed for one screen to a
       * different screen, and the result would look entirely plausible.
       */
      throw new Error(
        `bake: no retained frame for frameId "${frameId}". ` +
          `It was never detected, or it has been evicted (retaining ${String(this.#maxRetained)}).`,
      );
    }

    // Baked against the FULL frame, never the letterboxed square: the ops are in
    // the frame's own device pixels, and the square carries padding the server
    // must never see.
    return this.#bakeFn(image, ops, quality);
  }

  release(frameId: string): Promise<void> {
    // Idempotent: releasing a frame that was already evicted, or never existed,
    // is not an error. A step that failed before capture still runs its cleanup.
    this.#frames.delete(frameId);
    return Promise.resolve();
  }

  status(): Promise<RuntimeStatus> {
    return Promise.resolve({
      loaded: this.#initResult !== null,
      result: this.#initResult,
      modelId: this.#config?.modelId ?? null,
      retainedFrames: this.#frames.size,
      heap: this.#readHeap?.() ?? null,
    });
  }

  async dispose(): Promise<void> {
    this.#frames.clear();
    const backend = this.#backend;
    this.#backend = null;
    this.#config = null;
    this.#initResult = null;
    if (backend !== null) await backend.dispose();
  }

  #ready(): { backend: InferenceBackend; config: EngineConfig } {
    if (this.#backend === null || this.#config === null) {
      throw new Error('WorkerRuntime: init(config) must be awaited before detect() or bake()');
    }
    return { backend: this.#backend, config: this.#config };
  }

  #retain(frameId: string, image: RgbaImage): void {
    // Delete-then-set refreshes recency, so a repeatedly re-detected frame does
    // not age out from under an in-flight bake.
    this.#frames.delete(frameId);
    this.#frames.set(frameId, image);
    while (this.#frames.size > this.#maxRetained) {
      const oldest = this.#frames.keys().next().value;
      if (oldest === undefined) break;
      this.#frames.delete(oldest);
    }
  }
}

/** Placeholder for contexts where no backend has been wired yet. */
export class UnimplementedWorkerRuntime implements WorkerRuntime {
  release(): Promise<void> {
    throw new NotImplementedError('WorkerRuntime.release');
  }

  status(): Promise<RuntimeStatus> {
    throw new NotImplementedError('WorkerRuntime.status');
  }

  init(): Promise<InitResult> {
    throw new NotImplementedError('WorkerRuntime.init (no inference backend is wired)');
  }

  detect(): Promise<VisionResult> {
    throw new NotImplementedError('WorkerRuntime.detect');
  }

  retain(): Promise<void> {
    throw new NotImplementedError('WorkerRuntime.retain');
  }

  bake(): Promise<BakeResult> {
    throw new NotImplementedError('WorkerRuntime.bake');
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
