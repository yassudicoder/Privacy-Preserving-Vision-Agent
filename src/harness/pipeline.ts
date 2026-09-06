import {
  type BakedScreenshot,
  type SanitizedContext,
  type ViewportInfo,
  type VisionDetection,
  redactionNonce,
  TEST_SALT,
  unsafeUnwrap,
  DEFAULT_BUDGET_POLICY,
  type ElementBudgetPolicy,
} from '@/contracts/index.ts';
import {
  type RedactResult,
  buildSanitizedContext,
  redact,
  resetDetectionIds,
} from '@/redaction/index.ts';
import { loadFixture, resolveBenign, resolveTruth } from './load.ts';
import type { Fixture, ResolvedGroundTruthItem } from './types.ts';

/**
 * One fixture, run through the whole client-side pipeline.
 *
 * Every test that needs "the state of the world after redaction" goes through
 * here, so the tests exercise the same composition the extension does rather
 * than each assembling its own slightly different version.
 */

export interface PipelineOptions {
  readonly goal?: string;
  readonly url?: string;
  readonly nonce?: string;
  readonly minConfidence?: number;
  readonly screenshot?: BakedScreenshot | null;
  readonly now?: number;
  /** Cover DOM-handled detections in pixels too. See RedactOptions. */
  readonly pixelCoverAll?: boolean;
  /**
   * Vision boxes to merge, INSTEAD of the fixture's recorded `*.vision.json`.
   *
   * The benchmark needs this. Without it every candidate model is scored against
   * the same recorded boxes, so two models produce identical metric 1/2/3
   * numbers and the ranking is decided by latency and heap alone - which means
   * the benchmark cannot answer the question it exists to answer.
   *
   * Defaults to the recorded boxes so every existing caller is unchanged.
   */
  readonly visionBoxes?: readonly VisionDetection[];
  /**
   * The element budget. Defaults to `DEFAULT_BUDGET_POLICY`.
   *
   * Needed to exercise the ESCALATION - drop names, drop geometry, drop the
   * screenshot, drop elements - which only fires when the budget is genuinely
   * too small for the page. Without a way to set it, the levers past the first
   * one were unreachable from a fixture-driven test.
   */
  readonly budget?: ElementBudgetPolicy;
}

export interface PipelineOutput {
  readonly fixture: Fixture;
  readonly viewport: ViewportInfo;
  /** The confidence threshold redaction actually ran at. The scorer's operating point. */
  readonly minConfidence: number;
  readonly result: RedactResult;
  readonly context: SanitizedContext;
  readonly resolvedTruth: readonly ResolvedGroundTruthItem[];
  readonly benignPaths: readonly string[];
}

export function runPipeline(fixtureId: string, opts: PipelineOptions = {}): PipelineOutput {
  const fixture = loadFixture(fixtureId);
  const viewport = fixture.truth.viewport;

  // Deterministic ids make failure output diffable between runs.
  resetDetectionIds();

  const minConfidence = opts.minConfidence ?? 0.5;
  const result = redact(fixture.html, opts.visionBoxes ?? fixture.visionBoxes, {
    viewport,
    salt: TEST_SALT,
    nonce: redactionNonce(opts.nonce ?? 'a1b2c3d4'),
    minConfidence,
    frameId: `${fixtureId}-frame-0`,
    url: opts.url ?? `https://fixtures.invalid/${fixtureId}?session=should-be-stripped`,
    now: opts.now ?? 1_700_000_000_000,
    ...(opts.pixelCoverAll === true ? { pixelCoverAll: true } : {}),
  });

  const context = buildSanitizedContext({
    doc: result.doc,
    log: result.log,
    detections: result.detections,
    viewport,
    url: opts.url ?? `https://fixtures.invalid/${fixtureId}?session=should-be-stripped`,
    taskId: `task-${fixtureId}`,
    step: 0,
    goal: opts.goal ?? 'complete the form',
    screenshot: opts.screenshot ?? null,
    budget: opts.budget ?? DEFAULT_BUDGET_POLICY,
  });

  // Truth is resolved against the ORIGINAL document, not the redacted one:
  // redaction can remove nodes, and a selector that no longer matches would
  // silently drop a ground-truth item and inflate recall.
  const pristine = new DOMParser().parseFromString(
    unsafeUnwrap(fixture.html, 'test-fixture'),
    'text/html',
  );

  return {
    fixture,
    viewport,
    minConfidence,
    result,
    context,
    resolvedTruth: resolveTruth(pristine, fixture.truth),
    benignPaths: resolveBenign(pristine, fixture.truth),
  };
}
