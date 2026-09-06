/**
 * Local vision: model hosting, capture, and everything that happens to model
 * output. Also owns the model benchmark, because "which model" is a perception
 * decision with whole-system consequences.
 */
export type { PerceptionEngine, InitResult } from './engine.ts';
export {
  YunetBackend,
  createYunetBackend,
  createPackagedYunetFactory,
  ortApiFrom,
  type OrtModule,
  type UrlResolver as YunetUrlResolver,
  yunetProviders,
  type OrtApi,
  type OrtSessionLike,
  type OrtTensorLike,
} from './worker/yunet-backend.ts';
export {
  decodeYunet,
  rgbaToBgrChw,
  YUNET_STRIDES,
  YUNET_LABEL,
  type YunetOutputs,
  type DecodeYunetOptions,
} from './worker/yunet-decode.ts';
export { StubPerceptionEngine, UnimplementedEngine } from './engine.ts';

export type { InferenceHost, HostKind, HostDispatch, HostSession, OffscreenApi, OffscreenCapableRuntime } from './host/host.ts';
export { UnimplementedHost, answerOffscreen, OFFSCREEN_PATH, OFFSCREEN_JUSTIFICATION } from './host/host.ts';
export type { OffscreenReply } from './host/host.ts';
export { ChromeOffscreenHost } from './host/chrome-offscreen.ts';
export { FirefoxBackgroundPageHost } from './host/firefox-bgpage.ts';

export type { CaptureAdapter, CaptureOptions } from './capture.ts';
export { DEFAULT_CAPTURE, CAPTURE_MIN_INTERVAL_MS, downscaleFactor, dataUrlBytes, BrowserCaptureAdapter, UnimplementedCaptureAdapter, FixtureCaptureAdapter } from './capture.ts';
export type { BrowserCaptureDeps } from './capture.ts';

export type { WorkerRuntime } from './worker/runtime.ts';
export { LocalWorkerRuntime, UnimplementedWorkerRuntime } from './worker/runtime.ts';
export type { RuntimeStatus } from './worker/runtime.ts';
export type { LocalWorkerRuntimeDeps } from './worker/runtime.ts';
export { letterboxImage } from './worker/letterbox.ts';
export { BrowserFrameCodec } from './worker/browser-codec.ts';
export { createRuntimeDispatch, RUNTIME_COMMANDS } from './worker/dispatch.ts';
export { createTransformersBackend, detectWasmSimd, devicePlan } from './worker/transformers-backend.ts';
export type {
  DetectionOutput,
  ObjectDetector,
  PipelineOptions,
  TransformersApi,
  TransformersBackendDeps,
  TransformersDevice,
} from './worker/transformers-backend.ts';
export {
  MODEL_DIR,
  WASM_DIR,
  createPackagedBackendFactory,
  createTransformersApi,
  measureWeightBytesVia,
} from './worker/transformers-env.ts';
export type { TransformersModule, UrlResolver } from './worker/transformers-env.ts';
export type { BakePayload } from './worker/dispatch.ts';
export type {
  BakeFn,
  BakeResult,
  BackendFactory,
  FrameCodec,
  InferenceBackend,
  ModelInput,
} from './worker/backend.ts';

export {
  undoLetterbox,
  letterboxParams,
  centreToRect,
  normalisedToRect,
  nonMaxSuppression,
  labelToPiiKind,
  decodeDetections,
} from './postprocess.ts';
export type { Padding, RawBox, DecodeOptions } from './postprocess.ts';

export { CANDIDATES, candidateById, candidatesFor, compatibilityMatrix } from './candidates.ts';
export type { ModelCandidate, RuntimeSupport, ModelFamily, VisionTask } from './candidates.ts';

export {
  runBenchmark,
  rankCandidates,
  scoreRun,
  decideScreenshotPolicy,
  resolveSessionPolicy,
  normaliseCost,
  DEFAULT_BUDGETS,
} from './bench.ts';
export type {
  BenchReport,
  BenchRun,
  BenchScores,
  BenchMeasurements,
  BenchBudgets,
  BenchDeps,
  BenchPlan,
  BenchFixture,
  Budget,
  RankedCandidate,
  RubricBreakdown,
  ScreenshotDecision,
  ResourceMeasurement,
} from './bench.ts';
