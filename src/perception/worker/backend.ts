import type { Backend, EngineConfig, PixelRedactionOp, RgbaImage } from '@/contracts/index.ts';
import type { Padding, RawBox } from '../postprocess.ts';

/**
 * The seams the worker runtime is built on.
 *
 * Everything genuinely environment-bound is behind one of these three
 * interfaces: the model (`InferenceBackend`), image decoding (`FrameCodec`) and
 * pixel baking (`BakeFn`). What is left in `LocalWorkerRuntime` is ordering,
 * coordinate-space conversion and frame retention - the parts that are easy to
 * get wrong and give no sign when they are.
 *
 * The point is not abstraction for its own sake. It is that the pipeline can be
 * exercised in Node, in milliseconds, with no WebGPU, no canvas and no 46 MB of
 * weights. A design that can only be tested by loading a real model in a real
 * browser does not get tested.
 */

/**
 * A frame scaled and padded into the square the model wants, carrying the
 * transform needed to undo it.
 *
 * `scale` and `pad` travel WITH the pixels deliberately. The inverse mapping has
 * to use the exact numbers the forward mapping used; recomputing them from the
 * frame dimensions later is how boxes end up a few pixels off, which looks like
 * a bad model rather than a bad conversion.
 */
export interface ModelInput {
  readonly rgba: RgbaImage;
  readonly inputSize: number;
  readonly scale: number;
  readonly pad: Padding;
}

/**
 * The model.
 *
 * Boxes come back in MODEL SPACE - the letterboxed square, in its own pixels.
 * The backend does not undo the letterbox and does not know about viewports or
 * device pixel ratios. Keeping it that dumb means a new model is a new
 * implementation of `infer` and nothing else.
 */
export interface InferenceBackend {
  /** Which backend actually loaded. Never the one that was merely requested. */
  readonly backend: Backend;
  readonly modelId: string;
  /** Bytes of weights actually resident. Measured, not declared. */
  readonly weightBytes: number;
  /** Square edge of the model input, in pixels. */
  readonly inputSize: number;
  infer(input: ModelInput): Promise<readonly RawBox[]>;
  dispose(): Promise<void>;
}

/**
 * Builds a backend for a config. Async because loading weights is.
 *
 * A real factory tries WebGPU, falls back to wasm-simd, then wasm, and reports
 * whichever won through `InferenceBackend.backend`.
 */
export type BackendFactory = (config: EngineConfig) => Promise<InferenceBackend>;

/**
 * Turns a captured data URL into pixels.
 *
 * Separate from the backend because decoding is a browser capability
 * (`createImageBitmap` + `OffscreenCanvas`), not a model capability, and because
 * the tests need to supply pixels without either.
 */
export interface FrameCodec {
  decode(dataUrl: string): Promise<RgbaImage>;
}

/** What `bake` hands back. Everything `buildSanitizedContext` will need later. */
export interface BakeResult {
  readonly base64: string;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
  readonly opsApplied: number;
  readonly opsRequested: number;
}

/**
 * Applies pixel redactions and encodes the result.
 *
 * INJECTED, not imported: the real implementation is
 * `redaction/canvas-redact.bakeRedactions` composed with a canvas encoder, and
 * `perception` may not import `redaction`. `perception/bench.ts` already takes
 * its scorers the same way for the same reason - it is what keeps the DAG
 * acyclic instead of merely documented as acyclic.
 */
export type BakeFn = (
  img: RgbaImage,
  ops: readonly PixelRedactionOp[],
  quality: number,
) => BakeResult;
