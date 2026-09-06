import {
  type Detection,
  type PiiKind,
  type RectProvider,
  type VisionDetection,
  area,
  containment,
  iou,
  visionToDetection,
} from '@/contracts/index.ts';
import { attributeRectProvider, canonicalPath } from './dom-scan.ts';

/**
 * Merge what the pixels saw with what the markup says.
 *
 * Two jobs:
 *   1. Attach vision boxes to DOM elements where they overlap, so a face the
 *      model found also gets its <img> handled in the HTML, not only in pixels.
 *   2. Deduplicate. When both channels independently flag the same thing, that
 *      agreement is evidence - the merged detection is more confident than
 *      either input, not just the max of the two.
 *
 * Pure. `doc` is optional; without it, vision boxes stay pixel-only.
 */

export interface MergeOptions {
  /** Same-kind detections overlapping by at least this much collapse into one. */
  readonly iouThreshold?: number;
  /** Fraction of a vision box that must sit inside an element to attach to it. */
  readonly containmentThreshold?: number;
  readonly doc?: Document;
  readonly rectOf?: RectProvider;
  /** Confidence granted when two independent sources agree. */
  readonly agreementBoost?: number;
}

const DEFAULTS = {
  iouThreshold: 0.5,
  containmentThreshold: 0.6,
  agreementBoost: 0.06,
} as const;

/**
 * Smallest element containing enough of the vision box. Smallest wins so a face
 * box lands on the <img>, not on <body>.
 */
export function attachToElement(
  det: Detection,
  doc: Document,
  rectOf: RectProvider,
  threshold: number,
): Element | null {
  if (det.rect === null) return null;
  let best: Element | null = null;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const r = rectOf(el);
    if (r === null || r.width <= 0 || r.height <= 0) continue;
    if (containment(det.rect, r) < threshold) continue;
    const a = area(r);
    if (a < bestArea) {
      bestArea = a;
      best = el;
    }
  }
  return best;
}

function sameTarget(a: Detection, b: Detection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.domPath !== null && b.domPath !== null && a.domPath === b.domPath) {
    return a.attr === b.attr && a.nodeIndex === b.nodeIndex;
  }
  return false;
}

function overlapping(a: Detection, b: Detection, threshold: number): boolean {
  if (a.kind !== b.kind) return false;
  if (a.rect === null || b.rect === null) return false;
  return iou(a.rect, b.rect) >= threshold;
}

function independentSources(a: Detection, b: Detection): boolean {
  const aVision = a.source === 'vision';
  const bVision = b.source === 'vision';
  return aVision !== bVision;
}

export function mergeDetections(
  dom: readonly Detection[],
  vision: readonly VisionDetection[],
  opts: MergeOptions = {},
): Detection[] {
  const iouThreshold = opts.iouThreshold ?? DEFAULTS.iouThreshold;
  const containmentThreshold = opts.containmentThreshold ?? DEFAULTS.containmentThreshold;
  const boost = opts.agreementBoost ?? DEFAULTS.agreementBoost;
  const rectOf = opts.rectOf ?? attributeRectProvider;
  const doc = opts.doc;

  // 1. Vision boxes become detections, attached to a DOM node where possible.
  const visionDetections: Detection[] = vision.map((v) => {
    const base = visionToDetection(v);
    if (doc === undefined) return base;
    const el = attachToElement(base, doc, rectOf, containmentThreshold);
    if (el === null) return base;
    return { ...base, domPath: canonicalPath(el) };
  });

  // 2. Collapse. Highest confidence first so the survivor is the best evidence.
  const all = [...dom, ...visionDetections].sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];

  for (const candidate of all) {
    const dupIndex = kept.findIndex(
      (k) => sameTarget(k, candidate) || overlapping(k, candidate, iouThreshold),
    );

    if (dupIndex === -1) {
      kept.push(candidate);
      continue;
    }

    const winner = kept[dupIndex];
    if (winner === undefined) continue;

    // Corroboration from a genuinely different channel is worth something.
    const corroborated = independentSources(winner, candidate);
    const confidence = corroborated
      ? Math.min(0.99, winner.confidence + boost)
      : winner.confidence;

    kept[dupIndex] = {
      ...winner,
      confidence,
      // A DOM path is more actionable than a bare rect; keep whichever exists.
      domPath: winner.domPath ?? candidate.domPath,
      rect: winner.rect ?? candidate.rect,
      evidence: corroborated
        ? { ...winner.evidence, rule: `${winner.evidence.rule}+${candidate.evidence.rule}` }
        : winner.evidence,
    };
  }

  return kept.sort((a, b) => b.confidence - a.confidence);
}

/** Detections with no DOM counterpart. These can only be handled in pixels. */
export function pixelOnly(detections: readonly Detection[]): Detection[] {
  return detections.filter((d) => d.domPath === null && d.rect !== null);
}

export function countByKind(
  detections: readonly Detection[],
): Readonly<Partial<Record<PiiKind, number>>> {
  const out: Partial<Record<PiiKind, number>> = {};
  for (const d of detections) {
    out[d.kind] = (out[d.kind] ?? 0) + 1;
  }
  return out;
}
