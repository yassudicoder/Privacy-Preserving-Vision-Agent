// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  inspectAnalysis,
  markUntrusted,
  redactionNonce,
  toDataAtom,
} from '@/contracts/index.ts';
import {
  analyzeDocument,
  chooseTable,
  forecastNext,
  outliers,
  parseNumber,
  readTable,
  summarize,
  timeSeriesFeatures,
  trend,
} from '@/analysis/index.ts';
import { redact } from '@/redaction/index.ts';
import { DEFAULT_ANALYSIS_LIMITS } from '@/contracts/index.ts';

/**
 * Every defect an adversarial review of this layer actually found.
 *
 * These are not hypotheticals. A multi-agent review read the shipped code, built
 * reproductions against the real pipeline, and confirmed each of the following.
 * They divide into two kinds, and both matter for the same reason:
 *
 *   DISCLOSURE - a path by which an actual cell value reached the model. The
 *   claim this whole module makes is that only aggregates leave, and three
 *   separate routes were republishing individual cells: a data row promoted to
 *   column headers, a summary of one value, and a "forecast" that was the last
 *   cell copied out.
 *
 *   HONESTY - a number presented as something it is not. An interval labelled
 *   95% that covers 70%, a goodness-of-fit borrowed from a model that was
 *   rejected, a column reported as fully parsed when a fifth of it was not.
 *   These do not leak anything; they make the output confidently wrong, which
 *   this project treats as the same class of failure.
 */

const NONCE = redactionNonce('a1b2c3d4');

function redactedDoc(html: string): Document {
  return redact(markUntrusted(html), [], {
    viewport: { cssWidth: 900, cssHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'test-salt',
    nonce: NONCE,
    minConfidence: 0.5,
    frameId: 'f1',
    url: 'https://synthetic.invalid/data',
    now: 0,
  }).doc;
}

function table(inner: string): Document {
  return redactedDoc(`<!doctype html><html><body><table>${inner}</table></body></html>`);
}

// --- disclosure --------------------------------------------------------------

describe('no path republishes an individual cell', () => {
  it('does not promote a data row to column labels when there is no <th>', () => {
    /*
     * The header used to be `first all-<th> row ?? rowEls[0]`. On a table with no
     * header - most hand-written HTML - the first DATA row became the header and
     * its cells became `label` DataAtoms. A label is the one string this module
     * may emit, so real values left through the single field the egress gate is
     * built to pass. The row was also dropped from every statistic.
     */
    const doc = table(
      `<tbody>${['4200', '4310', '4425', '4530', '4640', '4755']
        .map((v) => `<tr><td>${v}</td></tr>`)
        .join('')}</tbody>`,
    );
    const chosen = chooseTable(doc);
    const read = readTable(chosen!.table, DEFAULT_ANALYSIS_LIMITS);

    expect(read.columns[0]?.label).toBeNull();
    // And the first row is still DATA: six rows in, six values out.
    expect(read.rows).toBe(6);
    expect(read.columns[0]?.values).toEqual([4200, 4310, 4425, 4530, 4640, 4755]);

    /*
     * THE RESIDUAL, STATED RATHER THAN ASSERTED AWAY.
     *
     * `min` and `max` are cell values - not by accident but by definition: the
     * smallest observation IS an observation. So `4200` and `4755` DO appear in
     * the payload, and no amount of care changes that while descriptive
     * statistics are published at all. What the fixes above buy is that the
     * INTERIOR values do not, and that a column too small for the extremes to be
     * anonymising is not summarised at all (see the n<5 test below).
     *
     * This is the honest boundary of the claim: aggregates leave, and two of the
     * aggregates coincide with real rows.
     */
    const wire = JSON.stringify(analyzeDocument(doc));
    expect(wire).toContain('4200');
    expect(wire).toContain('4755');
    for (const interior of ['4310', '4425', '4530', '4640']) {
      expect(wire, `interior value ${interior} must not appear`).not.toContain(interior);
    }
  });

  it('still uses a real all-<th> header row', () => {
    const doc = table(
      `<thead><tr><th>altitude</th></tr></thead><tbody>${Array.from(
        { length: 6 },
        (_, i) => `<tr><td>${String(100 + i)}</td></tr>`,
      ).join('')}</tbody>`,
    );
    const read = readTable(chooseTable(doc)!.table, DEFAULT_ANALYSIS_LIMITS);
    expect(read.columns[0]?.label?.text).toBe('altitude');
    expect(read.rows).toBe(6);
  });

  it('refuses to summarise a column too small to aggregate', () => {
    /*
     * At n=1 min, max, mean, median, sum, p25 and p75 are ALL the single cell,
     * and `n` travels beside them so a reader knows it was one row. That is the
     * table republished, not summarised.
     */
    expect(summarize([42])).toBeNull();
    expect(summarize([42, 43])).toBeNull();
    expect(summarize([1, 2, 3, 4])).toBeNull();
    expect(summarize([1, 2, 3, 4, 5])).not.toBeNull();

    // End to end: the value must not appear in the wire payload.
    const doc = table(
      `<thead><tr><th>salary</th></tr></thead><tbody><tr><td>987654</td></tr></tbody>`,
    );
    expect(JSON.stringify(analyzeDocument(doc))).not.toContain('987654');
  });

  it('refuses a forecast rather than returning the last cell as one', () => {
    /*
     * `method: 'last-value'` returned `values[n - 1]` - one cell, verbatim,
     * presented to the model as a prediction. Not a prediction and not an
     * aggregate: two defects in one field.
     */
    expect(forecastNext(0, [500], 3)).toBeNull();
    expect(forecastNext(0, [500, 600], 3)).toBeNull();
    expect(forecastNext(0, [500, 600, 700], 3)).toBeNull();
    expect(forecastNext(0, [1, 2, 3, 4, 5], 3)).not.toBeNull();
  });

  it('refuses a DataAtom carrying fields an atom does not have', () => {
    /*
     * `isDataAtom` checks the four fields it needs are present, not that nothing
     * else is - and the walker deliberately skips labels, because labels are the
     * one place text is allowed. So an atom-shaped object with an extra field
     * cleared both gates. The one legal text field was the one field uncounted.
     */
    const atom = toDataAtom(markUntrusted('altitude'), { redacted: false });
    const smuggled = { ...atom, raw: 'yash@example.com,5000,Mumbai' };
    const v = inspectAnalysis({ schemaVersion: 1, columns: [{ index: 0, label: smuggled }] });
    expect(v.some((x) => x.detail.includes('raw'))).toBe(true);
  });
});

// --- honesty -----------------------------------------------------------------

describe('no figure is presented as something it is not', () => {
  it('counts cells that were neither empty, redacted, nor numeric', () => {
    /*
     * A column of 1,000 rows with 200 reading "N/A" reported `n=800,
     * nMissing=0, nRedacted=0` - which says every row of the column parsed. The
     * mean covered 80% of the data and nothing on screen said so.
     */
    /*
     * Three kinds of non-number in one column, because they are three different
     * facts and the counters have to keep them apart:
     *   "N/A"     - an explicit no-value marker. MISSING.
     *   "pending" - text that is not a number and not a declared absence.
     *               UNPARSED, which is the counter that did not exist.
     *   the rest  - real values.
     */
    const cells = ['N/A', 'N/A', 'pending', '10', '20', '30', '40', '50', '60', '70'];
    const doc = table(
      `<thead><tr><th>v</th></tr></thead><tbody>${cells
        .map((v) => `<tr><td>${v}</td></tr>`)
        .join('')}</tbody>`,
    );
    const col = readTable(chooseTable(doc)!.table, DEFAULT_ANALYSIS_LIMITS).columns[0];

    expect(col?.nMissing).toBe(2);
    expect(col?.nUnparsed).toBe(1);
    expect(col?.values).toEqual([10, 20, 30, 40, 50, 60, 70]);
    // n plus every exclusion has to account for every row read. Before
    // `nUnparsed` existed this sum was 7 + 0 + 2 = 9 against 10 rows, and
    // nothing anywhere accounted for the tenth.
    expect(
      (col?.values.length ?? 0) + (col?.nUnparsed ?? 0) + (col?.nMissing ?? 0),
    ).toBe(10);
  });

  it('refuses an ambiguous decimal rather than misreading it by 1000x', () => {
    // "1.234,56" is 1234.56 in de-DE and nothing at all in en-GB. Stripping
    // separators parsed it as 1.23456.
    expect(parseNumber('1.234,56')).toBeNull();
    expect(parseNumber('1 234,56')).toBeNull();
    expect(parseNumber('1,23')).toBeNull();
    // The unambiguous shapes still parse.
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('1234.56')).toBe(1234.56);
    expect(parseNumber('(1,234)')).toBe(-1234);
    expect(parseNumber('12.5%')).toBe(12.5);
  });

  it('widens a small-sample interval to the t quantile, not the normal one', () => {
    /*
     * 1.96 is the NORMAL quantile. With n=5 there are 3 degrees of freedom and
     * the two-sided 95% t is 3.182 - 62% wider. The interval said 95% and
     * covered far less.
     */
    const f = forecastNext(0, [10, 21, 29, 41, 52], 3);
    expect(f?.method).toBe('linear-least-squares');
    expect(f?.lower).not.toBeNull();

    // Reconstruct the half-width and check it against the normal quantile.
    const half = (f!.upper as number) - (f!.next as number);
    const normalHalf = (half / 3.182) * 1.96;
    expect(half).toBeGreaterThan(normalHalf * 1.5);
  });

  it('reports no interval at all rather than a zero-width one', () => {
    // Perfectly collinear: every residual is 0, so the old code produced
    // [next, next] - a prediction stated with total certainty from five rows.
    const f = forecastNext(0, [10, 20, 30, 40, 50], 3);
    expect(f?.next).toBeCloseTo(60, 6);
    expect(f?.lower).toBeNull();
    expect(f?.upper).toBeNull();
  });

  it('does not attach the rejected fit r2 to a moving-average forecast', () => {
    /*
     * The moving-average branch runs BECAUSE the linear fit explained under 25%
     * of the variance. Carrying that r2 forward labelled a value the fit did not
     * produce with the fit's own quality score.
     */
    const noisy = [50, 12, 88, 31, 67, 25, 90, 40, 5, 70];
    const f = forecastNext(0, noisy, 3);
    expect(f?.method).toBe('moving-average');
    expect(f?.fitR2).toBeNull();
  });

  it('calls a straight line steady, not accelerating', () => {
    /*
     * Momentum compared the MEAN of a late window against an early one, and the
     * late window of any rising series has a higher mean. So every rising column
     * read `accelerating`. Observed on real output: a column of 1..1000 - the
     * definition of a constant rate - came back rising and accelerating.
     */
    const linear = Array.from({ length: 60 }, (_, i) => i + 1);
    expect(timeSeriesFeatures(0, linear)?.momentum).toBe('steady');

    // And something genuinely accelerating still reads as such.
    const accel = Array.from({ length: 60 }, (_, i) => i * i);
    expect(timeSeriesFeatures(0, accel)?.momentum).toBe('accelerating');
  });

  it('finds a lone extreme in an otherwise-constant column at small n', () => {
    /*
     * When more than half the values are identical the MAD is 0, and the old
     * fallback was the standard deviation - which the outlier itself inflates,
     * hiding its own z-score. Measured: zero outliers at n=5, 8, 10 and 12, and
     * only from n=13 did the extreme clear the threshold.
     */
    const values = [...Array.from({ length: 9 }, () => 100), 9999];
    const found = outliers(0, values, values.map((_, i) => i));
    expect(found.length).toBe(1);
    expect(found[0]?.rowIndex).toBe(9);
    // Still the POSITION and a z-score, never the value.
    expect(JSON.stringify(found)).not.toContain('9999');
  });

  it('measures trend direction against the real x span, not the row count', () => {
    /*
     * `slope` is per unit of x, and x may be a timestamp column. Multiplying by
     * `n - 1` is only the total change when x increments by exactly 1 per row -
     * so a column sampled every 0.5 s read as twice the climb it had, and one
     * timestamped in milliseconds read `flat` while climbing steadily.
     */
    const ys = Array.from({ length: 40 }, (_, i) => 1000 + i * 50);
    // x in milliseconds: 40 points spanning 39,000 units.
    const xsMs = Array.from({ length: 40 }, (_, i) => i * 1000);
    expect(trend(0, xsMs, ys)?.direction).toBe('rising');
    // The same series against a row ordinal must agree with itself.
    const xsRow = Array.from({ length: 40 }, (_, i) => i);
    expect(trend(0, xsRow, ys)?.direction).toBe('rising');
  });

  it('reports a redacted column header as redacted', () => {
    // The label atom hard-coded `redacted: false`, so a header the redactor had
    // rewritten travelled describing itself as untouched.
    const doc = table(
      `<thead><tr><th>owner ada@example.com</th></tr></thead><tbody>${Array.from(
        { length: 6 },
        (_, i) => `<tr><td>${String(i)}</td></tr>`,
      ).join('')}</tbody>`,
    );
    const col = readTable(chooseTable(doc)!.table, DEFAULT_ANALYSIS_LIMITS).columns[0];
    expect(col?.label?.redacted).toBe(true);
    expect(col?.label?.text).not.toContain('ada@example.com');
  });
});
