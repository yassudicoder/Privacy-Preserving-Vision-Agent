import {
  type Backend,
  type CapturedFrame,
  type VisionDetection,
  DEFAULT_ENGINE_CONFIG,
} from '@/contracts/index.ts';
import {
  type BenchDeps,
  type BenchFixture,
  type BenchReport,
  type BenchScores,
  StubPerceptionEngine,
  runBenchmark,
} from '@/perception/index.ts';
import { encodeRequest, PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { loadFixture } from './load.ts';
import { runPipeline } from './pipeline.ts';
import { measureResources } from './resource.ts';
import { scoreDetections, scoreRedaction } from './score.ts';
import { scoreScreenContext } from './score-screen.ts';

/**
 * Wires the model benchmark to the real scorers.
 *
 * This file is why perception/bench.ts takes its scorers as injected
 * dependencies: harness/ sits above every module and may import all of them,
 * while perception/ must not import harness/. Doing the wiring here keeps the
 * module DAG acyclic and lets the boundary test enforce it.
 */

export function frameFor(fixtureId: string): CapturedFrame {
  const fixture = loadFixture(fixtureId);
  const vp = fixture.truth.viewport;
  return {
    frameId: `${fixtureId}-frame-0`,
    // No real pixels in the scaffold. The stub engine never decodes this.
    dataUrl: 'data:image/jpeg;base64,',
    encodedBytes: 0,
    natural: {
      width: Math.round(vp.cssWidth * vp.devicePixelRatio),
      height: Math.round(vp.cssHeight * vp.devicePixelRatio),
    },
    viewport: vp,
    capturedAt: 1_700_000_000_000,
  };
}

export function benchFixtures(ids: readonly string[]): BenchFixture[] {
  return ids.map((id) => ({ id, frame: frameFor(id) }));
}

/** Score one fixture end to end and report it on the three quality axes. */
export function scoreFixture(
  fixtureId: string,
  visionDetections: readonly VisionDetection[],
  screenshotToServer: boolean,
): BenchScores {
  /*
   * THE CANDIDATE'S OWN BOXES, not the fixture's recorded ones.
   *
   * This used to read `void visionDetections` and score from
   * `*.vision.json`, so every candidate model produced identical metric 1/2/3
   * numbers and the ranking was decided purely by latency and heap. A benchmark
   * that cannot distinguish two models on quality cannot answer the question it
   * exists to answer.
   */
  const run = runPipeline(fixtureId, { visionBoxes: visionDetections });
  void screenshotToServer;

  const detection = scoreDetections(run.result.detections, run.resolvedTruth, {
    minConfidence: run.minConfidence,
  });
  const redaction = scoreRedaction(
    run.result.html,
    run.result.log,
    run.fixture.truth,
    run.resolvedTruth,
    run.benignPaths,
  );
  const screen = scoreScreenContext(run.context.elements, run.fixture.truth.expectedElements);

  return {
    visualContext: screen.score,
    piiF1: detection.f1,
    redactionPrecision: redaction.redactionPrecision,
  };
}

/** Bytes actually put on the wire for this configuration. */
export function requestBytesFor(fixtureId: string, screenshotToServer: boolean): number {
  const run = runPipeline(fixtureId);
  const body = encodeRequest({
    protocolVersion: PROTOCOL_VERSION,
    context: run.context,
    clientVersion: 'bench',
  });
  // A baked screenshot is a base64 JPEG of the viewport. Until the real encoder
  // exists, model it from the frame area at a conservative bytes-per-pixel so
  // the tradeoff is represented rather than assumed to be free.
  const vp = run.viewport;
  const estimatedScreenshotBytes = screenshotToServer
    ? Math.round(vp.cssWidth * vp.cssHeight * vp.devicePixelRatio * 0.12 * 1.37)
    : 0;
  return new TextEncoder().encode(body).length + estimatedScreenshotBytes;
}

export function makeBenchDeps(
  boxesFor: (frameId: string) => readonly VisionDetection[],
): BenchDeps {
  return {
    makeEngine: () => new StubPerceptionEngine({ boxesFor }),
    score: scoreFixture,
    measure: async (label, fn) => {
      const { value, measurement } = await measureResources(label, fn);
      return { value, measurement: { wallMs: measurement.wallMs, peakHeapMb: measurement.peakHeapMb } };
    },
    requestBytesFor,
  };
}

export interface RunBenchOptions {
  readonly fixtureIds?: readonly string[];
  readonly backends?: readonly Backend[];
  readonly repeats?: number;
  readonly now?: number;
}

export async function runFixtureBenchmark(opts: RunBenchOptions = {}): Promise<BenchReport> {
  const ids = opts.fixtureIds ?? ['login-form', 'checkout', 'profile-pii'];
  const boxes = new Map<string, readonly VisionDetection[]>();
  for (const id of ids) {
    boxes.set(`${id}-frame-0`, loadFixture(id).visionBoxes);
  }

  return runBenchmark(makeBenchDeps((frameId) => boxes.get(frameId) ?? []), {
    candidates: [
      {
        id: 'stub-replay',
        family: 'vit-detector',
        task: 'face-detection',
        source: { hub: 'local', repo: 'stub' },
        quantization: 'fp32',
        declaredWeightsBytes: 0,
        measured: true,
        inputSize: { width: DEFAULT_ENGINE_CONFIG.maxEdgePx, height: DEFAULT_ENGINE_CONFIG.maxEdgePx },
        runtimes: [
          {
            backend: 'stub',
            browsers: ['chrome', 'firefox'],
            status: 'verified',
            note: 'replays recorded boxes; measures the harness, not a model',
          },
        ],
        license: 'n/a',
        notes: 'Present so the benchmark pipeline itself is exercised by npm test with no model available.',
      },
    ],
    backends: opts.backends ?? ['stub'],
    fixtures: benchFixtures(ids),
    repeats: opts.repeats ?? 2,
    warmup: 1,
    screenshotModes: [false, true],
    reportId: 'bench-fixtures',
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
