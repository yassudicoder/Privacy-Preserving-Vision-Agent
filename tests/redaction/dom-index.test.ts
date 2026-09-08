// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { canonicalPath, createDomIndex, mergeDetections, resolveDomPath, redact } from '@/redaction/index.ts';
import { type Detection, markUntrusted, redactionNonce } from '@/contracts/index.ts';

/**
 * The path index, and the quadratic it removed.
 *
 * HOW THIS GOT SHIPPED. 1112 tests passed over it. Every fixture in this repo is
 * a hand-written page of a few dozen elements, and at that size the difference
 * between linear and quadratic is 7 ms against 2 ms - invisible. It only became
 * visible against a generated 1,000-row table, where `redact()` took 6.3
 * MINUTES and the 10,000-row case never returned:
 *
 *     rows      parse       redact     analyse
 *      100       30ms        414ms         9ms
 *     1000      116ms     378745ms        58ms
 *
 * A ~900x cost for 10x the data. The analysis engine underneath it was linear
 * and finished in 58 ms; the redactor in front of it was the whole number.
 *
 * Two causes: `canonicalPath` materialised `parent.children` per level per call,
 * and `resolveDomPath` handed a deep `:nth-of-type` chain to a CSS engine that
 * evaluates it right-to-left - 307 ms for ONE `querySelector` on a 1,000-row
 * table, called once per detection group.
 *
 * So this file asserts two different things, because the fix has two ways to
 * fail. The first three tests are deterministic: the index must not change any
 * ANSWER, only the cost of getting it - a faster path resolver that resolves to
 * a different element would be a wrong-click bug, which is worse than the
 * slowness it replaced. The last is a tripwire on the cost itself.
 */

const NONCE = redactionNonce('a1b2c3d4');

/** A table big enough that a quadratic shows up and a linear one does not. */
function bigTable(rows: number, withPii: boolean): string {
  const body = Array.from({ length: rows }, (_, i) => {
    const pii = withPii ? `user${String(i)}@example.invalid` : `row${String(i)}`;
    return `<tr><td>${String(i)}</td><td>${String(i * 7)}</td><td>${pii}</td></tr>`;
  }).join('');
  return `<!doctype html><html><body><h1>data</h1><table><thead><tr><th>i</th><th>v</th><th>who</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('the index changes cost, never the answer', () => {
  it('produces byte-identical paths with and without an index', () => {
    /*
     * Sampled ACROSS the table, not from the front. The first version of this
     * measurement sliced the first 500 cells - which all live in the first ~60
     * rows - so the sibling walk never walked far and the quadratic did not
     * appear. Taking every 37th row exercises the deep ordinals that are the
     * entire point.
     */
    const doc = parse(bigTable(400, false));
    const cells = Array.from(doc.querySelectorAll('td')).filter((_, i) => i % 37 === 0);
    expect(cells.length).toBeGreaterThan(10);

    const index = createDomIndex();
    for (const el of cells) {
      expect(String(canonicalPath(el, index))).toBe(String(canonicalPath(el)));
    }
  });

  it('resolves to the same element the CSS engine would, indexed or not', () => {
    const doc = parse(bigTable(300, false));
    const cells = Array.from(doc.querySelectorAll('td')).filter((_, i) => i % 29 === 0);
    const index = createDomIndex();

    for (const el of cells) {
      const path = canonicalPath(el);
      // The walk, the indexed walk, and querySelector must agree on identity -
      // not on truthiness. A test that only checked `!== null` would pass while
      // every path resolved to row 1.
      expect(resolveDomPath(doc, path)).toBe(el);
      expect(resolveDomPath(doc, path, index)).toBe(el);
      expect(doc.querySelector(String(path))).toBe(el);
    }
  });

  it('falls back to querySelector for a path it does not recognise', () => {
    /*
     * `resolveDomPath` is exported and takes any `DomPath`. The fast walk only
     * understands the grammar `canonicalPath` emits, so anything else has to
     * reach the CSS engine exactly as before - otherwise this optimisation
     * silently removes resolutions callers used to get.
     */
    const doc = parse('<!doctype html><html><body><div id="x"><span>hi</span></div></body></html>');
    const el = doc.querySelector('#x span');
    expect(resolveDomPath(doc, '#x span' as never)).toBe(el);
    expect(resolveDomPath(doc, 'div > span' as never)).toBe(el);
    // Still null-safe on a selector no engine will accept.
    expect(resolveDomPath(doc, ':::not-a-selector' as never)).toBeNull();
  });

  it('returns null for a canonical path with no such element, rather than falling back', () => {
    /*
     * The distinction the walk has to preserve: "this is not a path I parse"
     * (hand it to the CSS engine) is not "there is no such element" (say so).
     * Getting that backwards would make every miss retry through the 307 ms
     * `querySelector` this change exists to avoid, and the quadratic would come
     * straight back on exactly the pages where paths stop resolving.
     */
    const doc = parse(bigTable(10, false));
    expect(
      resolveDomPath(doc, 'html>body:nth-of-type(1)>table:nth-of-type(9)' as never),
    ).toBeNull();
    expect(
      resolveDomPath(doc, 'html>body:nth-of-type(1)>nosuchtag:nth-of-type(1)' as never),
    ).toBeNull();

    // And the counterpart: `html:nth-of-type(1)` is NOT what canonicalPath
    // emits for a root (it emits a bare `html`), so it is not a canonical path
    // at all and must reach the CSS engine, which matches it.
    expect(resolveDomPath(doc, 'html:nth-of-type(1)' as never)).toBe(doc.documentElement);
  });
});

describe('the merge index agrees with the pairwise scan it replaced', () => {
  /*
   * `mergeDetections` deduplicated by scanning every kept detection for every
   * candidate. Measured on the generated telemetry pages:
   *
   *     rows     mergeDetections
   *   10,000            1,035 ms
   *  100,000        1,767,327 ms      <- 29 minutes, 1708x for 10x the data
   *
   * It is now a hash on `sameTarget` plus a spatial grid on `overlapping`. That
   * is only worth having if it returns THE SAME LIST, so this runs the original
   * O(n^2) rule as a reference implementation over randomised detections and
   * compares element for element. A faster merge that collapsed one extra pair
   * would silently discard a detection - and a discarded detection is a value
   * that never gets redacted.
   */
  const iou = (a: Rect, b: Rect): number => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.width, b.x + b.width);
    const bt = Math.min(a.y + a.height, b.y + b.height);
    if (r <= x || bt <= y) return 0;
    const inter = (r - x) * (bt - y);
    return inter / (a.width * a.height + b.width * b.height - inter);
  };

  interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** Deterministic PRNG, so a failure is reproducible from the seed alone. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeDetections(n: number, seed: number): Detection[] {
    const r = rng(seed);
    const kinds = ['email', 'phone', 'person'] as const;
    return Array.from({ length: n }, (_, i) => {
      // Deliberately COLLIDING inputs: a small path space and a small
      // coordinate space, so duplicates and overlaps actually happen. Random
      // detections spread over a large space would merge nothing and the test
      // would pass without exercising the thing it exists to check.
      const row = Math.floor(r() * (n / 3) + 1);
      const withRect = r() < 0.7;
      /*
       * A THIRD OF DETECTIONS CARRY NO domPath, and the first version of this
       * generator gave every one of them a path. That omission hid a real leak:
       * the only way a kept entry can GAIN a domPath mid-merge is to have
       * started without one, and the index bug below lived entirely on that
       * path. A fuzzer that cannot reach a state cannot test it.
       */
      const withPath = r() >= 0.35;
      const x = Math.floor(r() * 400);
      const y = Math.floor(r() * 400);
      return {
        id: `d-${String(i)}` as Detection['id'],
        kind: kinds[Math.floor(r() * kinds.length)] as Detection['kind'],
        source: r() < 0.5 ? 'regex' : 'vision',
        confidence: Math.round(r() * 100) / 100,
        rect: withRect
          ? { space: 'css-viewport' as const, x, y, width: 20 + Math.floor(r() * 40), height: 20 }
          : null,
        domPath: withPath
          ? (`html>body:nth-of-type(1)>tr:nth-of-type(${String(row)})` as Detection['domPath'])
          : null,
        attr: r() < 0.3 ? 'value' : null,
        nodeIndex: r() < 0.5 ? 0 : null,
        textSpan: null,
        evidence: { rule: `r${String(i)}`, valueLength: 5, valueHash: 'h' },
      } as Detection;
    });
  }

  /** The rule this file replaced, verbatim, as the oracle. */
  function referenceMerge(dom: readonly Detection[]): Detection[] {
    const sameTarget = (a: Detection, b: Detection): boolean => {
      if (a.kind !== b.kind) return false;
      if (a.domPath !== null && b.domPath !== null && a.domPath === b.domPath) {
        return a.attr === b.attr && a.nodeIndex === b.nodeIndex;
      }
      return false;
    };
    const overlapping = (a: Detection, b: Detection): boolean => {
      if (a.kind !== b.kind) return false;
      if (a.rect === null || b.rect === null) return false;
      return iou(a.rect, b.rect) >= 0.5;
    };
    const all = [...dom].sort((a, b) => b.confidence - a.confidence);
    const kept: Detection[] = [];
    for (const candidate of all) {
      const dupIndex = kept.findIndex((k) => sameTarget(k, candidate) || overlapping(k, candidate));
      if (dupIndex === -1) {
        kept.push(candidate);
        continue;
      }
      const winner = kept[dupIndex];
      if (winner === undefined) continue;
      const corroborated = (winner.source === 'vision') !== (candidate.source === 'vision');
      kept[dupIndex] = {
        ...winner,
        confidence: corroborated ? Math.min(0.99, winner.confidence + 0.06) : winner.confidence,
        domPath: winner.domPath ?? candidate.domPath,
        rect: winner.rect ?? candidate.rect,
        evidence: corroborated
          ? { ...winner.evidence, rule: `${winner.evidence.rule}+${candidate.evidence.rule}` }
          : winner.evidence,
      };
    }
    return kept.sort((a, b) => b.confidence - a.confidence);
  }

  it('produces the identical detection list on randomised colliding input', () => {
    for (const seed of [1, 7, 42, 1234, 98765]) {
      const input = makeDetections(300, seed);
      const fast = mergeDetections(input, []);
      const slow = referenceMerge(input);

      expect(fast.length, `seed ${String(seed)}: kept count`).toBe(slow.length);
      // Compare the SET of surviving ids, not just the count - two lists of the
      // same length can still have collapsed different pairs.
      expect(new Set(fast.map((d) => String(d.id)))).toEqual(
        new Set(slow.map((d) => String(d.id))),
      );
      for (let i = 0; i < fast.length; i += 1) {
        expect(fast[i]?.confidence, `seed ${String(seed)} row ${String(i)}`).toBe(
          slow[i]?.confidence,
        );
      }
    }
  });

  it('lets a winner that GAINS a domPath outrank one that already had it', () => {
    /*
     * THE CASE THAT LEAKED, reduced to four detections.
     *
     * `findIndex` returns the EARLIEST kept entry matching, and two kept entries
     * can carry the same target key once a winner acquires a domPath from its
     * candidate. The index registered "first key wins", which pinned the key to
     * the entry that already had the path - a HIGHER index - so the merge landed
     * on the wrong winner:
     *
     *   V  0.46 vision, no domPath, rect (0,0)     -> kept[0]
     *   D1 0.44 regex,  domPath P,  rect (1000,1000) -> kept[1], registers P
     *   C  0.30 vision, domPath P,  rect (5,5)     -> overlaps V, so kept[0]
     *                                                  MERGES and gains domPath P
     *   E  0.20 regex,  domPath P,  no rect        -> should match kept[0]
     *
     * The pairwise scan matched E against kept[0], found vision-versus-regex,
     * and applied the corroboration boost: 0.46 -> 0.52. Indexed, E matched
     * kept[1] instead, no boost fired, and V stayed at 0.46.
     *
     * 0.46 is BELOW the default `minConfidence` of 0.5 and 0.52 is above it. So
     * this was not a cosmetic difference in a confidence field - `redact()`
     * files everything under the threshold as "below minConfidence" and never
     * redacts it. The optimisation was dropping a PII value into the payload.
     */
    const path = 'html>body:nth-of-type(1)>p:nth-of-type(1)' as Detection['domPath'];
    const at = (x: number, y: number): Detection['rect'] =>
      ({ space: 'css-viewport', x, y, width: 100, height: 100 }) as Detection['rect'];
    const make = (
      id: string,
      confidence: number,
      source: Detection['source'],
      domPath: Detection['domPath'],
      rect: Detection['rect'],
    ): Detection =>
      ({
        id: id as Detection['id'],
        kind: 'email',
        source,
        confidence,
        rect,
        domPath,
        attr: null,
        nodeIndex: null,
        textSpan: null,
        evidence: { rule: id, valueLength: 5, valueHash: 'h' },
      }) as Detection;

    const input = [
      make('V', 0.46, 'vision', null, at(0, 0)),
      make('D1', 0.44, 'regex', path, at(1000, 1000)),
      make('C', 0.3, 'vision', path, at(5, 5)),
      make('E', 0.2, 'regex', path, null),
    ];

    const fast = mergeDetections(input, []);
    const slow = referenceMerge(input);
    const show = (l: readonly Detection[]): string[] =>
      l.map((d) => `${String(d.id)} ${d.confidence.toFixed(2)} ${d.evidence.rule}`);
    expect(show(fast)).toEqual(show(slow));

    // And the consequence, stated directly: it has to clear the threshold that
    // decides whether `redact()` acts on it at all.
    const v = fast.find((d) => String(d.id) === 'V');
    expect(v?.confidence).toBeCloseTo(0.52, 10);
    expect(v?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('merges 20,000 detections without pairwise comparison', () => {
    const input = makeDetections(20_000, 99);
    const t0 = Date.now();
    const out = mergeDetections(input, []);
    const elapsed = Date.now() - t0;
    // It must have actually collapsed things, or the timing proves nothing.
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(input.length);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});

describe('redaction cost is linear in the size of the page', () => {
  it('redacts 2,000 PII rows in seconds, not minutes', () => {
    /*
     * A TRIPWIRE, not a benchmark, and the ceiling is deliberately absurd.
     *
     * Measured after the fix: ~0.4 s for 1,000 rows. Measured BEFORE it: 378.7
     * SECONDS for the same page, and 2,000 rows would have been roughly 25
     * minutes. A 30-second ceiling cannot fire on a slow machine, a cold JIT or
     * a loaded CI box, and fires immediately if either quadratic comes back.
     *
     * Same reasoning as the 64 MB bundle ceiling in `tests/built/bundle.test.ts`:
     * if this fails, the question is what got slower, not what the number should
     * become.
     */
    const html = bigTable(2000, true);
    const t0 = Date.now();
    const result = redact(markUntrusted(html), [], {
      salt: 'perf-salt',
      nonce: NONCE,
      minConfidence: 0.5,
      frameId: 'f1',
      url: 'https://synthetic.invalid/data',
      now: 0,
    });
    const elapsed = Date.now() - t0;

    // It has to have done the WORK, or the timing means nothing. A redactor
    // that found zero detections would be very fast and completely broken.
    const applied = result.log.entries.filter((e) => e.applied).length;
    expect(applied).toBe(2000);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});
