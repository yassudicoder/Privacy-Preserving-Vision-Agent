import {
  type AnalysisLimits,
  type AnalysisRefusal,
  type AnalysisResult,
  type AnalysisShape,
  type AnalyzedColumn,
  type CorrelationResult,
  type ForecastResult,
  type OutlierResult,
  type TimeSeriesFeatures,
  type TrendResult,
  DEFAULT_ANALYSIS_LIMITS,
} from '@/contracts/index.ts';
import { chooseTable, readTable, type RawColumn } from './table.ts';
import {
  correlate,
  forecastNext,
  outliers,
  summarize,
  timeSeriesFeatures,
  trend,
} from './stats.ts';

/**
 * The one place an `AnalysisResult` is minted.
 *
 * `tests/architecture/boundaries.test.ts` pins that, exactly as it pins
 * `SanitizedContext` and `BakedScreenshot`. The type is nominal, so a caller
 * cannot hand the sanitizer numbers that did not come from this engine, and a
 * second cast appearing anywhere fails the build.
 *
 * WHAT LEAVES HERE, exhaustively: counts, statistics, slopes, correlation
 * coefficients, z-scores, row POSITIONS, and column header `DataAtom`s. No cell
 * value, no sample, no example row, no "largest value" string. The type has no
 * field that could hold one - see `contracts/analysis.ts`.
 *
 * WHAT IT COSTS THE MODEL: nothing. A 100,000-row table becomes roughly 40
 * numbers. The alternative - putting the table in the prompt - is both the
 * privacy failure this project exists to prevent and, at ~150,000 tokens, the
 * most expensive way to get a worse answer.
 */

/** How many numeric columns to correlate. Pairs grow quadratically. */
const MAX_CORRELATION_COLUMNS = 6;
/** Outliers reported per column. A ceiling on the report, not on the search. */
const MAX_OUTLIERS_PER_COLUMN = 10;

export interface AnalyzeOptions {
  readonly limits?: AnalysisLimits;
  readonly now?: () => number;
}

/**
 * A refusal, WITH the evidence for it.
 *
 * `columns` used to be `[]` on every refusal, and that made the most important
 * refusal unprovable. `all-columns-redacted` means the redactor removed every
 * column of the table - the privacy pipeline working exactly as designed - and
 * the receipt rendered it as "Analysis blocked" above "0 column(s), 0 value(s)
 * excluded". A claim with its own evidence zeroed out reads as a crash, which is
 * the opposite of what happened.
 *
 * Carrying the columns is safe by construction and not by care: `AnalyzedColumn`
 * holds counts, a kind and a `DataAtom` header, and has no field that can hold a
 * cell value. `contracts/egress.ts` validates every one of them on the way out
 * whether the analysis refused or not.
 */
function refuse(
  refusal: AnalysisRefusal,
  tablesFound: number,
  computeMs: number,
  read?: { columns: readonly AnalyzedColumn[]; rows: number; cells: number },
): AnalysisResult {
  const shape: AnalysisShape = {
    schemaVersion: 1,
    tablesFound,
    tableIndex: null,
    /*
     * ZERO ROWS ANALYSED, even when rows were READ. Nothing was computed from
     * them, and a non-zero count here would let the panel report a statistic
     * count over a table it produced no statistics for. `cellsRead` carries what
     * the engine actually looked at; the two are different facts.
     */
    rowsAnalyzed: 0,
    cellsRead: read?.cells ?? 0,
    columns: read?.columns ?? [],
    trends: [],
    correlations: [],
    outliers: [],
    forecasts: [],
    series: [],
    chartsDetected: 0,
    computeMs,
    refusal,
  };
  return shape as AnalysisResult;
}

/**
 * Chooses the x-axis for a trend.
 *
 * A temporal or monotonically-increasing column when one exists - a reading
 * against its timestamp is what "trend" means for telemetry - and the row
 * ordinal otherwise. Returning the ordinal is not a fallback that hides a
 * failure: for a table already in time order, position IS the time axis, and
 * `TrendResult.n` says how many points backed the fit either way.
 */
function axisFor(col: RawColumn, columns: readonly RawColumn[]): readonly number[] {
  const temporal = columns.find((c) => c.kind === 'temporal' && c.values.length >= col.values.length);
  if (temporal !== undefined) return temporal.values.slice(0, col.values.length);
  return col.rowIndexes;
}

/**
 * Runs the whole local analysis over one page.
 *
 * `doc` is the REDACTED document. Every value this reads has already been
 * through `redact()`, and cells that were PII arrive as placeholders and are
 * excluded and counted rather than coerced - see `table.ts`.
 */
export function analyzeDocument(doc: Document, opts: AnalyzeOptions = {}): AnalysisResult {
  const limits = opts.limits ?? DEFAULT_ANALYSIS_LIMITS;
  const now = opts.now ?? ((): number => Date.now());
  const t0 = now();

  const chosen = chooseTable(doc);
  if (chosen === null) return refuse('no-table-found', 0, now() - t0);

  const read = readTable(chosen.table, limits);
  if (read.rows === 0) return refuse('no-table-found', chosen.found, now() - t0);

  const numericCols = read.columns.filter((c) => c.kind === 'numeric' && c.values.length > 0);

  if (numericCols.length === 0) {
    /*
     * TWO DIFFERENT REFUSALS, and the difference is the whole privacy story of
     * this feature. A table whose every column was PII is not "nothing to
     * analyse" - it is "the redactor removed all of it", which is the system
     * working, and the receipt must be able to say which happened.
     */
    const anyRedacted = read.columns.some((c) => c.kind === 'redacted');
    return refuse(
      anyRedacted ? 'all-columns-redacted' : 'no-numeric-column',
      chosen.found,
      now() - t0,
      {
        // The counts that make the refusal checkable. Every column here is
        // `redacted`, `categorical` or `unknown` - none has `stats`, because
        // none held numbers.
        columns: read.columns.map((c) => ({
          index: c.index,
          label: c.label,
          kind: c.kind,
          n: 0,
          nMissing: c.nMissing,
          nRedacted: c.nRedacted,
          nUnparsed: c.nUnparsed,
          distinct: c.distinct,
          stats: null,
        })),
        rows: read.rows,
        cells: read.cells,
      },
    );
  }

  const trends: TrendResult[] = [];
  const forecasts: ForecastResult[] = [];
  const found: OutlierResult[] = [];
  const series: TimeSeriesFeatures[] = [];

  for (const col of numericCols) {
    /*
     * The time budget is checked BETWEEN columns, not inside the arithmetic.
     * JavaScript has no interrupt, so a genuinely unbounded loop cannot be
     * stopped from outside - what a budget can do is decline to start the next
     * unit of work. The per-column cost is already bounded by `maxCells`, so
     * the worst overrun is one column.
     */
    if (now() - t0 > limits.timeoutMs) break;

    if (col.values.length >= limits.minPointsForTrend) {
      const t = trend(col.index, axisFor(col, read.columns), col.values);
      if (t !== null) trends.push(t);
    }

    const f = forecastNext(col.index, col.values, limits.minPointsForTrend);
    if (f !== null) forecasts.push(f);

    const ts = timeSeriesFeatures(col.index, col.values);
    if (ts !== null) series.push(ts);

    found.push(...outliers(col.index, col.values, col.rowIndexes).slice(0, MAX_OUTLIERS_PER_COLUMN));
  }

  const correlations: CorrelationResult[] = [];
  const pairable = numericCols.slice(0, MAX_CORRELATION_COLUMNS);
  for (let i = 0; i < pairable.length; i += 1) {
    for (let j = i + 1; j < pairable.length; j += 1) {
      if (now() - t0 > limits.timeoutMs) break;
      const a = pairable[i];
      const b = pairable[j];
      if (a === undefined || b === undefined) continue;
      /*
       * Correlated over the OVERLAP only. Two columns with different missing
       * rows have different lengths, and zipping them by position would pair
       * unrelated observations and produce a confident coefficient for a
       * relationship that was never measured.
       */
      const n = Math.min(a.values.length, b.values.length);
      if (n < 3) continue;
      correlations.push(correlate(a.index, b.index, a.values.slice(0, n), b.values.slice(0, n)));
    }
  }

  const columns: AnalyzedColumn[] = read.columns.map((c) => ({
    index: c.index,
    label: c.label,
    kind: c.kind,
    n: c.values.length,
    nMissing: c.nMissing,
    nRedacted: c.nRedacted,
    nUnparsed: c.nUnparsed,
    distinct: c.distinct,
    stats: c.kind === 'numeric' ? summarize(c.values) : null,
  }));

  const shape: AnalysisShape = {
    schemaVersion: 1,
    tablesFound: chosen.found,
    tableIndex: chosen.index,
    rowsAnalyzed: read.rows,
    cellsRead: read.cells,
    columns,
    trends,
    correlations,
    outliers: found,
    forecasts,
    series,
    /*
     * A canvas or an inline SVG is almost always a graph, and a graph is the one
     * thing a table extract CANNOT represent - its shape, axes, legend and
     * annotations live in pixels. Counted so the panel can say "this page has a
     * chart the numbers do not cover; the redacted screenshot would carry it"
     * rather than silently analysing half the page. A COUNT, never the image.
     */
    chartsDetected: doc.querySelectorAll('canvas, svg').length,
    computeMs: now() - t0,
    /*
     * A TRUNCATED READ IS NOT A CLEAN ONE. `readTable` stops at the cell
     * ceiling, and reporting statistics over the first 200,000 cells of a
     * larger table as if they covered it would be exactly the confident
     * partial answer this codebase keeps removing. The refusal is carried
     * alongside the numbers rather than instead of them - the figures are real
     * for the rows read, and the panel says how many that was.
     */
    refusal: read.truncated ? 'too-many-cells' : null,
  };

  // The single sanctioned cast. Everything above is what makes it true.
  return shape as AnalysisResult;
}
