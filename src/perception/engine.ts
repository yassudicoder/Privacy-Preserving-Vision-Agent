import {
  type CapturedFrame,
  type EngineConfig,
  type EngineStatus,
  type VisionDetection,
  type VisionResult,
  NotImplementedError,
  zeroTimings,
} from '@/contracts/index.ts';

/**
 * The vision engine contract.
 *
 * No model is loaded in this scaffold - the brief puts that out of scope for
 * this session. What exists is the interface the real ONNX/WebGPU engine will
 * implement, plus a fixture-replaying stub so the other four modules and the
 * whole harness can run end to end today.
 */

export interface InitResult {
  readonly backend: EngineConfig['preferredBackend'];
  readonly loadMs: number;
  /** Bytes of weights actually resident. Measured, not declared. */
  readonly weightBytes: number;
}

export interface PerceptionEngine {
  readonly status: EngineStatus;
  init(config: EngineConfig): Promise<InitResult>;
  detect(frame: CapturedFrame): Promise<VisionResult>;
  dispose(): Promise<void>;
}

/**
 * Replays recorded boxes instead of running a model.
 *
 * This is what makes the rest of the system testable in Node today: every
 * fixture ships a `*.vision.json` of boxes a real model would plausibly emit, so
 * merge, redaction, baking, sanitization and scoring all exercise the real code
 * paths with no WebGPU in sight.
 */
export class StubPerceptionEngine implements PerceptionEngine {
  #status: EngineStatus = 'idle';
  #config: EngineConfig | null = null;
  readonly #boxesFor: (frameId: string) => readonly VisionDetection[];
  readonly #simulatedLoadMs: number;
  readonly #simulatedWeightBytes: number;

  constructor(opts: {
    boxesFor: (frameId: string) => readonly VisionDetection[];
    simulatedLoadMs?: number;
    simulatedWeightBytes?: number;
  }) {
    this.#boxesFor = opts.boxesFor;
    this.#simulatedLoadMs = opts.simulatedLoadMs ?? 0;
    this.#simulatedWeightBytes = opts.simulatedWeightBytes ?? 0;
  }

  get status(): EngineStatus {
    return this.#status;
  }

  init(config: EngineConfig): Promise<InitResult> {
    this.#config = config;
    this.#status = 'ready';
    return Promise.resolve({
      backend: 'stub',
      loadMs: this.#simulatedLoadMs,
      weightBytes: this.#simulatedWeightBytes,
    });
  }

  detect(frame: CapturedFrame): Promise<VisionResult> {
    if (this.#status !== 'ready') {
      return Promise.reject(new Error('engine is not initialised'));
    }
    const threshold = this.#config?.scoreThreshold ?? 0;
    return Promise.resolve({
      frameId: frame.frameId,
      detections: this.#boxesFor(frame.frameId).filter((d) => d.confidence >= threshold),
      backend: 'stub',
      modelId: this.#config?.modelId ?? 'stub',
      timings: zeroTimings(),
    });
  }

  dispose(): Promise<void> {
    this.#status = 'disposed';
    return Promise.resolve();
  }
}

/** Placeholder for the real engine. Fails loudly rather than silently doing nothing. */
export class UnimplementedEngine implements PerceptionEngine {
  readonly status: EngineStatus = 'idle';

  init(): Promise<InitResult> {
    throw new NotImplementedError('PerceptionEngine.init');
  }

  detect(): Promise<VisionResult> {
    throw new NotImplementedError('PerceptionEngine.detect');
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
