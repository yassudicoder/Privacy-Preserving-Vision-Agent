import { type SanitizedElement, iou } from '@/contracts/index.ts';
import type { ExpectedElement } from './types.ts';

/**
 * SIH metric 1: accuracy of the visual context extracted from the screen.
 *
 * This grades the thing the server actually receives - `SanitizedElement[]` -
 * against what a correct reading of the page would have produced. It is 25% of
 * the rubric, the single largest slice, and it is graded with the same rigour as
 * detection: one-to-one greedy matching, no double credit, misses and spurious
 * elements both counted.
 *
 * An element is judged on four things, because getting any one wrong makes the
 * server's plan wrong in a different way:
 *   role        - "is this clickable" drives what the agent can even attempt
 *   name        - how the model identifies the target
 *   geometry    - where it is; also what redaction boxes are aligned against
 *   sensitivity - whether the agent is allowed to type into it
 */

export interface ScreenContextScore {
  readonly elementPrecision: number;
  readonly elementRecall: number;
  readonly elementF1: number;
  /** Of matched pairs, the fraction with the right role. */
  readonly roleAccuracy: number;
  /** Of matched pairs, the fraction with the right accessible name. */
  readonly nameAccuracy: number;
  /** Of matched pairs, the fraction with the right sensitivity flag. */
  readonly sensitivityAccuracy: number;
  /** Of matched pairs that both have rects, the mean IoU. */
  readonly geometryIou: number;
  /** Of matched pairs, the fraction with exactly the expected states. */
  readonly stateAccuracy: number;
  /** Weighted composite, 0..1. What feeds the benchmark ranker. */
  readonly score: number;
  readonly matched: readonly { readonly expectedId: string; readonly ref: string; readonly quality: number }[];
  readonly missing: readonly string[];
  readonly spurious: readonly string[];
}

/** Weights inside metric 1. Identity of an element matters more than its pixels. */
export const SCREEN_WEIGHTS = {
  elementF1: 0.4,
  role: 0.2,
  name: 0.2,
  geometry: 0.1,
  sensitivity: 0.1,
} as const;

export function normaliseName(name: string | null): string {
  if (name === null) return '';
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Exact after normalisation, else Jaccard over word tokens. */
export function nameSimilarity(a: string | null, b: string | null): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (na === '' && nb === '') return 1;
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;

  const ta = new Set(na.split(/[^a-z0-9]+/).filter((t) => t !== ''));
  const tb = new Set(nb.split(/[^a-z0-9]+/).filter((t) => t !== ''));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function rectIou(found: SanitizedElement, expected: ExpectedElement): number | null {
  if (expected.rect === undefined) return null;
  if (found.rect.width <= 0 || found.rect.height <= 0) return 0;
  return iou(found.rect, {
    space: 'css-viewport',
    x: expected.rect.x,
    y: expected.rect.y,
    width: expected.rect.width,
    height: expected.rect.height,
  });
}

/**
 * How good a candidate pairing is. Used only for matching, not for the final
 * score - so a wrong role still pairs (and is then counted as a role error)
 * rather than being reported as both a miss and a spurious element.
 */
function pairQuality(found: SanitizedElement, expected: ExpectedElement): number {
  const name = nameSimilarity(found.name?.text ?? null, expected.name);
  const geometry = rectIou(found, expected);
  const role = found.role === expected.role ? 1 : 0;
  const geometryPart = geometry === null ? 0 : geometry;
  const geometryWeight = geometry === null ? 0 : 0.3;
  return (name * 0.5 + role * 0.2 + geometryPart * geometryWeight) / (0.7 + geometryWeight);
}

export interface ScreenScoreOptions {
  /** Pair quality below this is not a match at all. */
  readonly matchThreshold?: number;
}

export function scoreScreenContext(
  found: readonly SanitizedElement[],
  expected: readonly ExpectedElement[],
  opts: ScreenScoreOptions = {},
): ScreenContextScore {
  const threshold = opts.matchThreshold ?? 0.4;

  // Score every pairing, then take them greedily best-first. One-to-one.
  const candidates: { f: SanitizedElement; e: ExpectedElement; q: number }[] = [];
  for (const f of found) {
    for (const e of expected) {
      const q = pairQuality(f, e);
      if (q >= threshold) candidates.push({ f, e, q });
    }
  }
  candidates.sort((a, b) => b.q - a.q);

  const usedFound = new Set<string>();
  const usedExpected = new Set<string>();
  const matched: { expectedId: string; ref: string; quality: number }[] = [];
  const pairs: { f: SanitizedElement; e: ExpectedElement }[] = [];

  for (const c of candidates) {
    const ref = String(c.f.ref);
    if (usedFound.has(ref) || usedExpected.has(c.e.id)) continue;
    usedFound.add(ref);
    usedExpected.add(c.e.id);
    matched.push({ expectedId: c.e.id, ref, quality: c.q });
    pairs.push({ f: c.f, e: c.e });
  }

  const tp = pairs.length;
  const elementPrecision = found.length === 0 ? (expected.length === 0 ? 1 : 0) : tp / found.length;
  const elementRecall = expected.length === 0 ? 1 : tp / expected.length;
  const elementF1 =
    elementPrecision + elementRecall === 0
      ? 0
      : (2 * elementPrecision * elementRecall) / (elementPrecision + elementRecall);

  const roleHits = pairs.filter((p) => p.f.role === p.e.role).length;
  const nameHits = pairs.filter((p) => nameSimilarity(p.f.name?.text ?? null, p.e.name) >= 0.999).length;
  const sensitivityHits = pairs.filter((p) => p.f.isSensitive === p.e.sensitive).length;
  const stateHits = pairs.filter((p) => {
    const want = [...(p.e.states ?? [])].sort();
    const got = [...p.f.states].sort();
    return want.length === got.length && want.every((s, i) => s === got[i]);
  }).length;

  const ious = pairs
    .map((p) => rectIou(p.f, p.e))
    .filter((v): v is number => v !== null);

  const roleAccuracy = tp === 0 ? 0 : roleHits / tp;
  const nameAccuracy = tp === 0 ? 0 : nameHits / tp;
  const sensitivityAccuracy = tp === 0 ? 0 : sensitivityHits / tp;
  const stateAccuracy = tp === 0 ? 0 : stateHits / tp;
  const geometryIou = ious.length === 0 ? 0 : ious.reduce((a, b) => a + b, 0) / ious.length;

  const score =
    elementF1 * SCREEN_WEIGHTS.elementF1 +
    roleAccuracy * SCREEN_WEIGHTS.role +
    nameAccuracy * SCREEN_WEIGHTS.name +
    geometryIou * SCREEN_WEIGHTS.geometry +
    sensitivityAccuracy * SCREEN_WEIGHTS.sensitivity;

  return {
    elementPrecision,
    elementRecall,
    elementF1,
    roleAccuracy,
    nameAccuracy,
    sensitivityAccuracy,
    geometryIou,
    stateAccuracy,
    score,
    matched,
    missing: expected.filter((e) => !usedExpected.has(e.id)).map((e) => e.id),
    spurious: found.filter((f) => !usedFound.has(String(f.ref))).map((f) => String(f.ref)),
  };
}
