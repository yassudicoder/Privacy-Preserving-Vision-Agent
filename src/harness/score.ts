import {
  type Detection,
  type PiiKind,
  type RedactedHtml,
  type RedactionLog,
  iou,
} from '@/contracts/index.ts';
import type { GroundTruth, ResolvedGroundTruthItem } from './types.ts';

/**
 * SIH metrics 2 and 3: PII detection precision/recall, and redaction precision.
 *
 * Matching is one-to-one and greedy by descending confidence. Without the
 * one-to-one constraint, firing five overlapping rules at one email would score
 * as five true positives and look like excellent recall.
 */

export interface DetectionScore {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Extra detections landing on an already-matched truth item. Should be zero if merge works. */
  readonly duplicates: number;
  /** Matched a truth item marked mustRedact:false. Neither credited nor penalised. */
  readonly outOfScope: number;
  /**
   * Detections excluded because they sit below the operating threshold.
   * Reported rather than hidden: they are real output of the detector, they are
   * just not acted on. See `minConfidence` in ScoreOptions.
   */
  readonly belowThreshold: number;
  /** The operating point these numbers were computed at. */
  readonly atConfidence: number;
  readonly byKind: Readonly<Partial<Record<PiiKind, { precision: number; recall: number }>>>;
  readonly unmatchedFound: readonly string[];
  readonly unmatchedTruth: readonly string[];
}

export interface ScoreOptions {
  /** IoU needed for a geometry-only match, used when there is no DOM anchor. */
  readonly iouThreshold?: number;
  /**
   * The operating point. Detections below this are excluded from precision and
   * recall and counted in `belowThreshold` instead.
   *
   * Precision and recall are only meaningful at a stated operating point, and
   * the honest one is the threshold that actually drives redaction: a detection
   * the system never acts on is not a claim the system is making. Defaults to 0
   * (grade everything) so a caller has to opt into the friendlier number, and
   * the count of what was excluded is always reported alongside it.
   */
  readonly minConfidence?: number;
}

function pathMatches(det: Detection, item: ResolvedGroundTruthItem): boolean {
  if (det.domPath === null || item.domPath === null) return false;
  if (String(det.domPath) !== String(item.domPath)) return false;

  // If truth names an attribute, the detection must be on that attribute
  // (or on the element as a whole, which subsumes it).
  if (item.locator.attr !== undefined && det.attr !== null && det.attr !== item.locator.attr) {
    return false;
  }
  return true;
}

function rectMatches(det: Detection, item: ResolvedGroundTruthItem, threshold: number): boolean {
  if (det.rect === null || item.rect === undefined) return false;
  return (
    iou(det.rect, {
      space: 'css-viewport',
      x: item.rect.x,
      y: item.rect.y,
      width: item.rect.width,
      height: item.rect.height,
    }) >= threshold
  );
}

function isMatch(det: Detection, item: ResolvedGroundTruthItem, threshold: number): boolean {
  if (det.kind !== item.kind) return false;
  return pathMatches(det, item) || rectMatches(det, item, threshold);
}

export function scoreDetections(
  found: readonly Detection[],
  groundTruth: readonly ResolvedGroundTruthItem[],
  opts: ScoreOptions = {},
): DetectionScore {
  const threshold = opts.iouThreshold ?? 0.5;
  const minConfidence = opts.minConfidence ?? 0;
  const inScope = groundTruth.filter((t) => t.mustRedact);
  const outOfScopeItems = groundTruth.filter((t) => !t.mustRedact);

  const graded = found.filter((d) => d.confidence >= minConfidence);
  const belowThreshold = found.length - graded.length;

  const ranked = [...graded].sort((a, b) => b.confidence - a.confidence);
  const claimed = new Map<string, Detection>();

  let tp = 0;
  let duplicates = 0;
  let outOfScope = 0;
  const falsePositives: Detection[] = [];

  for (const det of ranked) {
    const target = inScope.find((t) => isMatch(det, t, threshold));
    if (target !== undefined) {
      if (claimed.has(target.id)) {
        duplicates += 1;
      } else {
        claimed.set(target.id, det);
        tp += 1;
      }
      continue;
    }
    // Something we know is sensitive but do not claim to catch. Neither side.
    if (outOfScopeItems.some((t) => isMatch(det, t, threshold))) {
      outOfScope += 1;
      continue;
    }
    falsePositives.push(det);
  }

  // Duplicates are noise that would each produce their own log entry, so they
  // count against precision even though they are not wrong about anything.
  const fp = falsePositives.length + duplicates;
  const fn = inScope.length - tp;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = inScope.length === 0 ? 1 : tp / inScope.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const kinds = new Set<PiiKind>([...inScope.map((t) => t.kind), ...graded.map((d) => d.kind)]);
  const byKind: Partial<Record<PiiKind, { precision: number; recall: number }>> = {};
  for (const kind of kinds) {
    const kindTruth = inScope.filter((t) => t.kind === kind);
    const kindFound = graded.filter((d) => d.kind === kind);
    const kindTp = [...claimed.entries()].filter(([id]) =>
      kindTruth.some((t) => t.id === id),
    ).length;
    byKind[kind] = {
      precision: kindFound.length === 0 ? 1 : kindTp / kindFound.length,
      recall: kindTruth.length === 0 ? 1 : kindTp / kindTruth.length,
    };
  }

  return {
    precision,
    recall,
    f1,
    tp,
    fp,
    fn,
    duplicates,
    outOfScope,
    belowThreshold,
    atConfidence: minConfidence,
    byKind,
    unmatchedFound: falsePositives.map((d) => `${d.kind}:${String(d.id)}:${d.evidence.rule}`),
    unmatchedTruth: inScope.filter((t) => !claimed.has(t.id)).map((t) => t.id),
  };
}

// ---------------------------------------------------------------------------
// SIH metric 3: redaction precision
// ---------------------------------------------------------------------------

export interface RedactionScore {
  /** Truth literals still present in the output. Any entry here is a hard failure. */
  readonly leaks: readonly string[];
  /** Benign selectors that got redacted anyway. */
  readonly overRedacted: readonly string[];
  readonly redactionPrecision: number;
  readonly redactionRecall: number;
  readonly applied: number;
  readonly failed: number;
}

/**
 * Grade the redaction itself.
 *
 * Two independent failures, weighted differently in practice: a leak means PII
 * left the machine, and over-redaction means the agent went blind. Both are
 * reported; neither is averaged away into a single number here.
 */
export function scoreRedaction(
  redactedHtml: RedactedHtml,
  log: RedactionLog,
  truth: GroundTruth,
  resolved: readonly ResolvedGroundTruthItem[],
  benignPaths: readonly string[] = [],
): RedactionScore {
  const html = String(redactedHtml);

  const leaks: string[] = [];
  for (const item of truth.sensitive) {
    if (!item.mustRedact || item.literal === undefined) continue;
    if (html.includes(item.literal)) leaks.push(item.id);
  }

  const applied = log.entries.filter((e) => e.applied);
  const failed = log.entries.filter(
    (e) => !e.applied && !e.reason.startsWith('below minConfidence'),
  );

  const truthPaths = new Set(
    resolved.filter((t) => t.domPath !== null).map((t) => String(t.domPath)),
  );
  const benign = new Set(benignPaths);

  const overRedacted: string[] = [];
  for (const entry of applied) {
    if (entry.target.domPath === null) continue;
    const path = String(entry.target.domPath);
    // Over-broad two ways: it hit something explicitly marked benign, or it hit
    // something no truth item covers at all.
    if (benign.has(path) || !truthPaths.has(path)) {
      overRedacted.push(`${entry.kind}@${path}`);
    }
  }

  const expected = resolved.filter((t) => t.mustRedact).length;
  const correct = applied.length - overRedacted.length;

  return {
    leaks,
    overRedacted,
    redactionPrecision: applied.length === 0 ? 1 : Math.max(0, correct) / applied.length,
    redactionRecall: expected === 0 ? 1 : Math.min(1, Math.max(0, correct) / expected),
    applied: applied.length,
    failed: failed.length,
  };
}
