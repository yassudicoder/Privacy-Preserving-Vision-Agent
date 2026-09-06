import type { Backend } from '@/contracts/index.ts';

/**
 * Candidate model registry.
 *
 * Every number in here that is not marked `measured` is a claim, not a fact.
 * The whole point of the benchmark is to replace these with measurements taken
 * on the same fixtures under the same harness. Treat `declaredWeightsBytes` as a
 * planning figure and nothing more until `measured` flips.
 *
 * The spike already produced one hard number that applies to every row:
 * ONNX Runtime Web itself is ~21 MB of wasm plus ~0.9 MB of JS, paid before any
 * of these weights load. Model size is not the whole client cost.
 */

export type ModelFamily = 'vit-detector' | 'cnn-detector' | 'vit-classifier' | 'vlm' | 'ocr';

export type VisionTask =
  | 'ui-element-detection'
  | 'face-detection'
  | 'document-detection'
  | 'ocr'
  | 'captioning'
  | 'classification';

export interface RuntimeSupport {
  readonly backend: Backend;
  readonly browsers: readonly ('chrome' | 'firefox')[];
  /** 'verified' only after the benchmark has actually run it. Nothing starts verified. */
  readonly status: 'verified' | 'expected' | 'unsupported';
  readonly note: string;
}

export interface ModelCandidate {
  readonly id: string;
  readonly family: ModelFamily;
  readonly task: VisionTask;
  readonly source: { readonly hub: 'hf' | 'local'; readonly repo: string };
  readonly quantization: 'fp32' | 'fp16' | 'int8' | 'q4';
  /** Null until measured. Do not report an estimate as a result. */
  readonly declaredWeightsBytes: number | null;
  readonly measured: boolean;
  readonly inputSize: { readonly width: number; readonly height: number };
  readonly runtimes: readonly RuntimeSupport[];
  readonly license: string;
  readonly notes: string;
}

const BOTH: readonly ('chrome' | 'firefox')[] = ['chrome', 'firefox'];

/**
 * Starting shortlist. Chosen to span the tradeoff space rather than to be
 * exhaustive: a small ViT detector, a heavier CNN detector for an accuracy
 * ceiling, an OCR model for text-in-pixels, and a small VLM for the case where
 * one model does both detection and description.
 */
export const CANDIDATES: readonly ModelCandidate[] = [
  {
    id: 'yunet',
    family: 'cnn-detector',
    task: 'face-detection',
    source: { hub: 'hf', repo: 'opencv/face_detection_yunet' },
    quantization: 'fp32',
    /*
     * MEASURED: 232,589 bytes, SHA-256 8f2383e4dd3cfbb4553ea8718107fc0423210dc9
     * 64f9f4280604804ed2552fa4, confirmed against the file the hub actually
     * serves.
     *
     * THE SHIPPED MODEL, and the reason yolos-tiny below is now a reference row.
     * Both timed in this project's own runtime - onnxruntime-web, wasm EP,
     * numThreads=1, 640x640:
     *
     *   yolos-tiny  1765.8 ms   26,227,993 bytes
     *   yunet         30.3 ms      232,589 bytes
     *
     * 58x faster at 1/113th the weight. yolos-tiny is over
     * DEFAULT_BUDGETS.inferMs (1500 ms), so it scores ZERO on latency under this
     * project's own budget - it is not merely weak, it is disqualified.
     *
     * It also emits the literal label `face`, which LABEL_MAP already contains,
     * where yolos-tiny's usable COCO label is `person` - a whole-body box that
     * blacks out far more of the frame than the face needs, against the
     * redaction-precision metric.
     *
     * Not a transformers.js model: it ships neither config.json nor
     * preprocessor_config.json, and that library dispatches object-detection to
     * seven architectures it is not one of. `YunetBackend` drives the ONNX
     * session directly and decodes the stride-8/16/32 head by hand.
     */
    declaredWeightsBytes: 232_589,
    measured: true,
    inputSize: { width: 640, height: 640 },
    runtimes: [
      {
        backend: 'wasm',
        browsers: BOTH,
        status: 'expected',
        note: '30.3 ms p50 measured under Node with the shipped ORT build and wasm EP. NOT yet run in a real offscreen document, which is the measurement that would make this verified.',
      },
      {
        backend: 'webgpu',
        browsers: BOTH,
        status: 'expected',
        note: 'Available and unnecessary. At 30 ms on wasm there is nothing to recover, and needing no GPU is what removes the measured contention with the server VLM on a single 6 GB laptop card.',
      },
    ],
    license: 'MIT (OpenCV Zoo)',
    notes: 'Faces only. signature, id-document and credit-card stay unreachable through vision - as they were with yolos-tiny, since COCO contains none of them. Those are covered, where they are covered at all, by IMG_VISUAL_RULES in the DOM scan.',
  },
  {
    // REFERENCE ROW, no longer shipped. Kept because its numbers are the
    // baseline the replacement is measured against, and because deleting a
    // candidate deletes the evidence for the decision.
    id: 'yolos-tiny',
    family: 'vit-detector',
    task: 'face-detection',
    source: { hub: 'hf', repo: 'Xenova/yolos-tiny' },
    quantization: 'fp32',
    /*
     * MEASURED: 26,227,993 bytes, attributed to a single onnx/model.onnx.
     *
     * Corroborated independently: yolos-tiny is ~6.5M parameters, so fp32 is
     * ~26.0 MB. The measurement and the arithmetic land 0.9% apart. That matters
     * because the tally that produced this number has now been wrong twice, and
     * agreement with a figure derived a completely different way is the reason
     * this one is still here.
     *
     * Wrong the first time: a naive fetch tally summed content-length across
     * retries, and a flaky link fetched the same 25 MB file five times, reading
     * as a 131,139,965-byte model. The per-file breakdown caught it.
     *
     * Wrong the second time: the replacement still read the Content-Length
     * header, which chunked responses do not send at all -- transformers.js
     * warns about exactly this. Any such file counted as zero and disappeared
     * from the total without a trace. The spike now counts decoded bytes off the
     * response body and reports, per file, how each number was obtained.
     */
    declaredWeightsBytes: 26_227_993,
    measured: true,
    inputSize: { width: 640, height: 640 },
    runtimes: [
      {
        backend: 'webgpu',
        browsers: ['chrome'],
        status: 'verified',
        note: 'RTX 40-series / lovelace, webgpu/fp32. Two runs: forward pass p50 168 ms then 226.7 ms (p95 250.1, min 173.7) - same GPU, same dtype, ~35% apart, so treat 170-230 ms as the range and not either number as THE figure. Peak JS heap 74-100 MB. Firefox unverified.',
      },
      { backend: 'wasm-simd', browsers: BOTH, status: 'expected', note: 'fallback path, not yet run' },
    ],
    license: 'apache-2.0',
    notes: 'ViT backbone with a detection head. Detects COCO classes, so "person" is a proxy for face. 25 MB fp32; cold load is network-bound (116-205 s observed on a slow link) which argues for bundling the weights rather than fetching them. See DECISIONS.md.',
  },
  {
    id: 'detr-resnet-50',
    family: 'cnn-detector',
    task: 'face-detection',
    source: { hub: 'hf', repo: 'Xenova/detr-resnet-50' },
    quantization: 'fp32',
    declaredWeightsBytes: null,
    measured: false,
    inputSize: { width: 800, height: 800 },
    runtimes: [
      { backend: 'webgpu', browsers: BOTH, status: 'expected', note: 'heavier; measure before trusting' },
      { backend: 'wasm-simd', browsers: BOTH, status: 'expected', note: 'likely too slow for a loop' },
    ],
    license: 'apache-2.0',
    notes: 'Accuracy ceiling reference. Expected to fail the latency budget - it is here to show what we are giving up.',
  },
  {
    id: 'trocr-small-printed',
    family: 'ocr',
    task: 'ocr',
    source: { hub: 'hf', repo: 'Xenova/trocr-small-printed' },
    quantization: 'int8',
    declaredWeightsBytes: null,
    measured: false,
    inputSize: { width: 384, height: 384 },
    runtimes: [
      { backend: 'wasm-simd', browsers: BOTH, status: 'expected', note: 'encoder-decoder; autoregressive decode dominates' },
    ],
    license: 'mit',
    notes: 'Reads text the DOM cannot see - PII baked into images. Complements DOM scanning rather than replacing it.',
  },
  {
    id: 'clip-vit-base-patch16',
    family: 'vit-classifier',
    task: 'classification',
    source: { hub: 'hf', repo: 'Xenova/clip-vit-base-patch16' },
    quantization: 'int8',
    declaredWeightsBytes: null,
    measured: false,
    inputSize: { width: 224, height: 224 },
    runtimes: [
      { backend: 'webgpu', browsers: BOTH, status: 'expected', note: 'single forward pass, no decode loop' },
      { backend: 'wasm-simd', browsers: BOTH, status: 'expected', note: 'viable' },
    ],
    license: 'mit',
    notes: 'Zero-shot region classifier: crop a candidate box, ask "is this an ID card". No box output of its own.',
  },
  {
    id: 'florence-2-base',
    family: 'vlm',
    task: 'captioning',
    source: { hub: 'hf', repo: 'onnx-community/Florence-2-base-ft' },
    quantization: 'q4',
    declaredWeightsBytes: null,
    measured: false,
    inputSize: { width: 768, height: 768 },
    runtimes: [
      { backend: 'webgpu', browsers: ['chrome'], status: 'expected', note: 'Firefox support unverified; assume nothing' },
    ],
    license: 'mit',
    notes: 'Grounded captioning: one model for both detection and description. Largest client cost of the shortlist.',
  },
];

export function candidateById(id: string): ModelCandidate | null {
  return CANDIDATES.find((c) => c.id === id) ?? null;
}

/** Candidates claiming support for a backend on a browser. Claims, not proof. */
export function candidatesFor(backend: Backend, browser: 'chrome' | 'firefox'): ModelCandidate[] {
  return CANDIDATES.filter((c) =>
    c.runtimes.some(
      (r) => r.backend === backend && r.status !== 'unsupported' && r.browsers.includes(browser),
    ),
  );
}

/** Compatibility matrix for the report. Honest about what has not been run. */
export function compatibilityMatrix(): {
  candidateId: string;
  chrome: string;
  firefox: string;
  verified: boolean;
}[] {
  return CANDIDATES.map((c) => {
    const forBrowser = (b: 'chrome' | 'firefox'): string => {
      const supported = c.runtimes.filter((r) => r.browsers.includes(b) && r.status !== 'unsupported');
      return supported.length === 0 ? 'none' : supported.map((r) => r.backend).join('/');
    };
    return {
      candidateId: c.id,
      chrome: forBrowser('chrome'),
      firefox: forBrowser('firefox'),
      verified: c.runtimes.some((r) => r.status === 'verified'),
    };
  });
}
