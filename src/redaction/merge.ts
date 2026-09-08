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

/**
 * Grid resolution for the overlap index, in CSS pixels, and the cap on how many
 * cells one rect may occupy.
 *
 * 64 px is a little larger than the PII rects this pipeline actually sees (a
 * form field, a table cell, a face box), so a typical rect lands in one to four
 * cells and a probe reads a handful of neighbours. The cap exists for the rect a
 * hostile page can author: geometry is page-supplied, and a 1x10^9 px box would
 * otherwise materialise a grid entry per cell.
 */
const CELL_PX = 64;
const MAX_CELLS_PER_RECT = 256;

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

  /*
   * DEDUPLICATION IS INDEXED, because it used to compare every pair.
   *
   * This was `kept.findIndex(k => sameTarget(k, c) || overlapping(k, c))` inside
   * the loop over `all` - a linear scan of a list that grows to the length of
   * the input. Measured on the generated telemetry pages, where one detection
   * per row makes n the row count:
   *
   *     rows        redact()
   *    10,000        3,742 ms
   *   100,000      352,663 ms
   *
   * 94x for 10x the data. At 100,000 rows that is 5 billion pair comparisons,
   * each one a string compare of two `:nth-of-type` chains. It was invisible on
   * every fixture in this repo because they carry a few dozen detections, where
   * n^2 and n are the same number.
   *
   * BOTH PREDICATES ARE INDEXABLE, which is what makes this safe rather than
   * approximate:
   *
   *   - `sameTarget` requires domPath, attr, nodeIndex and kind to be EQUAL, and
   *     both paths to be non-null. That is a hash key. At most one kept entry
   *     can hold a given key, because a second one carrying it would have been
   *     merged into the first instead of pushed.
   *   - `overlapping` requires BOTH rects to be non-null and IoU >= 0.5. A rect
   *     with no rect-bearing neighbour in its own patch of the page cannot
   *     overlap anything, so only detections sharing a grid cell are compared.
   *
   * The result is the same detection list, not a similar one: `tests/redaction/
   * merge.test.ts` pins the behaviour and `dom-index.test.ts` pins the cost.
   */
  const byTarget = new Map<string, number>();
  const grid = new Map<string, number[]>();
  const withRect: number[] = [];
  const oversized: number[] = [];

  const targetKeyOf = (d: Detection): string | null =>
    d.domPath === null
      ? null
      : `${d.kind}\u0000${String(d.domPath)}\u0000${d.attr === null ? '\u0001' : d.attr}\u0000${d.nodeIndex === null ? '\u0001' : String(d.nodeIndex)}`;

  /*
   * The cells a rect touches, or null if it touches too many.
   *
   * A rect is bucketed into EVERY cell it covers, not just the one holding its
   * origin - two rects that overlap at all must then share a cell, so the grid
   * cannot miss a pair that `overlapping` would have found. A rect spanning more
   * cells than the cap (a full-page vision box, a rect with absurd geometry from
   * a hostile page) is not bucketed at all and goes on `oversized`, which every
   * probe scans. That keeps the worst case honest instead of quietly dropping
   * comparisons.
   */
  const cellsOf = (d: Detection): string[] | null => {
    const r = d.rect;
    if (r === null) return null;
    const x0 = Math.floor(r.x / CELL_PX);
    const x1 = Math.floor((r.x + Math.max(0, r.width)) / CELL_PX);
    const y0 = Math.floor(r.y / CELL_PX);
    const y1 = Math.floor((r.y + Math.max(0, r.height)) / CELL_PX);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    if (w * h > MAX_CELLS_PER_RECT) return null;
    const out: string[] = [];
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) out.push(`${String(x)},${String(y)}`);
    }
    return out;
  };

  /*
   * THE LOWEST INDEX WINS, and getting this backwards leaked a detection.
   *
   * `findIndex` returns the EARLIEST kept entry satisfying the predicate, and
   * two kept entries can genuinely carry the same target key - a winner with no
   * domPath that later GAINS one from its candidate now collides with an entry
   * that already had it. This first registered "first wins", which kept the
   * stale HIGHER index and made the merge land on the wrong winner:
   *
   *   V (0.46, vision, no domPath) merges with C and gains domPath P
   *   D1 (0.44, regex, domPath P) was already registered at index 1
   *   E (0.20, regex, domPath P) then matched index 1 instead of index 0
   *
   * The pairwise scan matched index 0, corroborated V (vision) against E
   * (regex), and lifted it to 0.52. Indexed, V stayed at 0.46 - BELOW the
   * default `minConfidence` of 0.5 - so `redact()` filed it under "below
   * minConfidence" and never redacted it. A missed merge is not a cosmetic
   * difference here; it is a PII value reaching the payload.
   */
  const registerTarget = (key: string | null, at: number): void => {
    if (key === null) return;
    const existing = byTarget.get(key);
    if (existing === undefined || at < existing) byTarget.set(key, at);
  };

  const indexAt = (d: Detection, at: number): void => {
    const key = targetKeyOf(d);
    registerTarget(key, at);
    if (d.rect === null) return;
    withRect.push(at);
    const cells = cellsOf(d);
    if (cells === null) {
      oversized.push(at);
      return;
    }
    for (const c of cells) {
      const list = grid.get(c);
      if (list === undefined) grid.set(c, [at]);
      else list.push(at);
    }
  };

  for (const candidate of all) {
    /*
     * The LOWEST matching index, because that is what `findIndex` returned and
     * `all` is sorted by descending confidence - so the earliest match is the
     * most confident one, and the winner has to stay the best evidence.
     */
    const key = targetKeyOf(candidate);
    let dupIndex = -1;
    if (key !== null) {
      const hit = byTarget.get(key);
      /*
       * THE PREDICATE STILL DECIDES. `targetKeyOf` hashes exactly the fields
       * `sameTarget` compares, and re-running it on a hit costs one comparison
       * and removes a whole class of failure: if the two ever drift apart, the
       * index can only MISS a merge, never invent one. An invented merge
       * discards a real detection, and a discarded detection is an unredacted
       * value - the one outcome this module must never produce.
       */
      if (hit !== undefined) {
        const k = kept[hit];
        if (k !== undefined && sameTarget(k, candidate)) dupIndex = hit;
      }
    }

    if (candidate.rect !== null) {
      const cells = cellsOf(candidate);
      const probe: Iterable<number> =
        cells === null
          ? withRect
          : new Set([...cells.flatMap((c) => grid.get(c) ?? []), ...oversized]);
      for (const i of probe) {
        if (dupIndex !== -1 && i >= dupIndex) continue;
        const k = kept[i];
        if (k !== undefined && overlapping(k, candidate, iouThreshold)) dupIndex = i;
      }
    }

    if (dupIndex === -1) {
      indexAt(candidate, kept.length);
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

    const merged: Detection = {
      ...winner,
      confidence,
      // A DOM path is more actionable than a bare rect; keep whichever exists.
      domPath: winner.domPath ?? candidate.domPath,
      rect: winner.rect ?? candidate.rect,
      evidence: corroborated
        ? { ...winner.evidence, rule: `${winner.evidence.rule}+${candidate.evidence.rule}` }
        : winner.evidence,
    };
    kept[dupIndex] = merged;

    /*
     * A MERGED ENTRY CAN GAIN A PATH OR A RECT, and the index has to learn about
     * it. The scan this replaced re-read every kept entry on every iteration, so
     * a winner that acquired a domPath from its candidate was matchable by the
     * very next detection for free. Indexed, it is invisible until re-indexed -
     * which would silently split one target into two detections.
     */
    if (winner.domPath === null && merged.domPath !== null) {
      registerTarget(targetKeyOf(merged), dupIndex);
    }
    if (winner.rect === null && merged.rect !== null) {
      withRect.push(dupIndex);
      const cells = cellsOf(merged);
      if (cells === null) oversized.push(dupIndex);
      else {
        for (const c of cells) {
          const list = grid.get(c);
          if (list === undefined) grid.set(c, [dupIndex]);
          else list.push(dupIndex);
        }
      }
    }
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
