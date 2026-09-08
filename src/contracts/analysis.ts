import type { Brand } from './brand.ts';
import type { DataAtom } from './untrusted.ts';

/**
 * What a local analysis produced, and the ONLY shape of it allowed to leave.
 *
 * THE RULE THIS TYPE ENFORCES: computers calculate, the model explains.
 *
 * Every field below is a NUMBER, an ENUM, or a `DataAtom` that redaction
 * already minted. There is deliberately no field capable of holding a cell
 * value, a row, a sample, an example, or a "top 5" list - so a 100,000-row
 * table cannot be smuggled out one interesting value at a time, and no future
 * edit can add that capability without changing this file, widening
 * `ALLOWED_KEYS`, and passing `tests/analysis/privacy.test.ts`.
 *
 * That is the same trick `BakedScreenshot` uses. A guarantee that lives in a
 * type survives a refactor; a guarantee that lives in a code review does not.
 *
 * WHY IT LIVES IN CONTRACTS. `SanitizedContextShape` carries it, and
 * `contracts` may import nothing - `boundaries.test.ts` fails any non-relative
 * specifier in this directory. So the TYPE is declared here and the COMPUTE
 * lives in `analysis/`, which may see only contracts. `redaction/sanitize.ts`
 * remains the sole place a `SanitizedContext` is minted.
 */

declare const ANALYZED: unique symbol;

/** How a column was classified. Drives which statistics are even attempted. */
export type ColumnKind =
  /** Parsed as numbers throughout. The only kind statistics run on. */
  | 'numeric'
  /** Parsed as dates or a monotonic index. Used as the x-axis for trends. */
  | 'temporal'
  /** Text that repeats. Only its cardinality is reported, never its values. */
  | 'categorical'
  /**
   * Every non-empty cell carried a redaction placeholder.
   *
   * Reported as its own kind rather than folded into `categorical`, because
   * "this column was PII and was excluded" is the single most important thing
   * the receipt can say about a table, and a kind that hides it would make the
   * privacy claim unverifiable from the output.
   */
  | 'redacted'
  /** Parsed as none of the above. Counted, never described. */
  | 'unknown';

/**
 * One column, described without quoting it.
 *
 * `label` is the header cell - page-derived, therefore a `DataAtom`, therefore
 * already neutralised, length-capped, and PII-substituted by the time it
 * arrives. It is the ONLY page text in this entire structure.
 */
export interface AnalyzedColumn {
  /** Position in the table. A number, so it can never be a value. */
  readonly index: number;
  readonly label: DataAtom | null;
  readonly kind: ColumnKind;
  /** Rows with a usable value of this column's kind. */
  readonly n: number;
  /** Rows whose cell was empty or unparseable. */
  readonly nMissing: number;
  /**
   * Rows whose cell carried a redaction placeholder and were EXCLUDED.
   *
   * Counted rather than coerced, and that distinction is load-bearing. A
   * placeholder like `[[PII:EMAIL:3:9f2a...]]` returns `NaN` from
   * `Number.parseFloat`, and an unguarded mean over a column containing one is
   * `NaN` - or worse, silently skipped, so a mean over 900 of 1,000 rows is
   * reported as if it covered all of them. Excluding explicitly and saying how
   * many is the only version of this that can be checked.
   */
  readonly nRedacted: number;
  /**
   * Cells that held text which was neither a placeholder nor a number.
   *
   * Reported alongside `n` because the two together are the only honest
   * description of coverage: `n` alone says how many values a statistic was
   * computed from and says nothing about how many it skipped.
   */
  readonly nUnparsed: number;
  /** Distinct values, for a categorical column. A COUNT, never the values. */
  readonly distinct: number | null;
  readonly stats: NumericSummary | null;
}

/** Descriptive statistics. Every field is a number computed on this device. */
export interface NumericSummary {
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly mean: number;
  readonly median: number;
  /** Sample standard deviation (n-1). Null when n < 2. */
  readonly stdDev: number | null;
  readonly p25: number;
  readonly p75: number;
}

/** A least-squares fit over one numeric column against an index or time axis. */
export interface TrendResult {
  readonly columnIndex: number;
  readonly slope: number;
  readonly intercept: number;
  /** Coefficient of determination, 0..1. How much of the variance the line explains. */
  readonly r2: number;
  readonly direction: 'rising' | 'falling' | 'flat';
  /** Points the fit used, after excluding missing and redacted cells. */
  readonly n: number;
}

/** Pearson correlation between two numeric columns, by index. */
export interface CorrelationResult {
  readonly aIndex: number;
  readonly bIndex: number;
  /** -1..1. Null when either column has zero variance. */
  readonly r: number | null;
  readonly n: number;
  readonly strength: 'none' | 'weak' | 'moderate' | 'strong';
}

/**
 * An outlier, identified by POSITION.
 *
 * `rowIndex` is an ordinal, and `z` is how many standard deviations from the
 * mean. Neither is the value. A field carrying the value would be the single
 * easiest way to exfiltrate the interesting rows of a table, which is exactly
 * why there is not one.
 */
export interface OutlierResult {
  readonly columnIndex: number;
  readonly rowIndex: number;
  readonly z: number;
  readonly direction: 'high' | 'low';
}

/**
 * A forecast of the next value, with an interval.
 *
 * `method` names what produced it so nothing has to be taken on faith, and
 * `confidence` is `null` when the model cannot honestly express one - a
 * forecast with an invented interval is worse than a forecast with none.
 */
export interface ForecastResult {
  readonly columnIndex: number;
  readonly next: number;
  /** 95% prediction interval. Null when n is too small to compute one. */
  readonly lower: number | null;
  readonly upper: number | null;
  readonly method: 'linear-least-squares' | 'last-value' | 'moving-average';
  /** r2 of the underlying fit, 0..1. Null for methods that have no fit. */
  /**
   * How well the linear fit explained the data: r-squared, 0 to 1.
   *
   * NAMED FOR WHAT IT IS. This was `confidence`, which reads as a
   * probability that the prediction is right - it is not one, and no
   * surface the model or the user reads said otherwise. r-squared is a
   * goodness-of-fit of the line to the rows already observed and says
   * nothing on its own about the next value.
   *
   * Null for `moving-average`, because that method fits no line.
   */
  readonly fitR2: number | null;
  readonly n: number;
}

/**
 * Time-series shape of one numeric column.
 *
 * SEPARATE FROM `TrendResult` because they answer different questions and
 * conflating them is how a confident number gets attached to noise. A slope
 * says which way the whole series leans; these say how it has behaved
 * RECENTLY and how much it moves about. A rising slope with high volatility
 * and falling momentum is a materially different situation from a rising slope
 * with neither, and a single "trend: up" cannot express it.
 *
 * Every field is computed on this device from values that already passed
 * redaction, and every field here is a DERIVED quantity rather than an
 * observation.
 *
 * `recentHigh` and `recentLow` used to sit in this list and have been REMOVED.
 * They were the max and min of the trailing window - actual cell values, and
 * worse than the column's global min/max, because naming the window narrows the
 * rows they could have come from to the last third of the table. On a six-row
 * column they published two of the six outright. They also added little:
 * `movingAverage` already reports the recent level and `volatility` how much it
 * moves. The disclosure was the largest in this type and the value the smallest.
 */
export interface TimeSeriesFeatures {
  readonly columnIndex: number;
  /** Points the window covered. */
  readonly n: number;
  /** (last - first) / |first|, as a percentage. Null when first is 0. */
  readonly changePercent: number | null;
  /** Mean change per step across the whole series. */
  readonly rateOfChange: number;
  /** Standard deviation of step-to-step differences. Absolute, not relative. */
  readonly volatility: number;
  /**
   * Volatility relative to the mean level, as a percentage. Null when the mean
   * is 0. This is the one a person can read without knowing the units.
   */
  readonly volatilityPct: number | null;
  readonly band: 'low' | 'medium' | 'high';
  /** Rate in the last window vs the rate in the one before it. */
  readonly momentum: 'accelerating' | 'steady' | 'decelerating';
  readonly movingAverage: number;
  readonly movingAverageWindow: number;
  /** |r| of the fit, 0..1. How much the direction can be relied on. */
  readonly trendStrength: number | null;
}

/** Why an analysis produced nothing. Reported, never silently empty. */
export type AnalysisRefusal =
  | 'no-table-found'
  | 'no-numeric-column'
  | 'too-many-cells'
  | 'timed-out'
  | 'all-columns-redacted';

export interface AnalysisShape {
  readonly schemaVersion: 1;
  /** Tables found on the page. A count, not the tables. */
  readonly tablesFound: number;
  /** Which table was analyzed, by position. Null when none was. */
  readonly tableIndex: number | null;
  /** Rows the engine actually read. The headline number in the receipt. */
  readonly rowsAnalyzed: number;
  /** Cells read. Bounded by `maxCells`; used for the resource report. */
  readonly cellsRead: number;
  readonly columns: readonly AnalyzedColumn[];
  readonly trends: readonly TrendResult[];
  readonly correlations: readonly CorrelationResult[];
  readonly outliers: readonly OutlierResult[];
  readonly forecasts: readonly ForecastResult[];
  readonly series: readonly TimeSeriesFeatures[];
  /**
   * Charts the page carries, by count.
   *
   * A canvas or an inline SVG is almost always a graph, and a graph is the one
   * thing a table extract CANNOT represent - its shape, axes, legend and
   * annotations live in pixels. The engine reports how many it saw so the panel
   * can say "this page has a chart the numbers do not cover; the redacted
   * screenshot would carry it" rather than silently analysing half the page.
   *
   * A COUNT, never the image and never its contents.
   */
  readonly chartsDetected: number;
  /** Wall-clock of the compute, on this device. */
  readonly computeMs: number;
  /** Set when nothing could be computed. Null on success. */
  readonly refusal: AnalysisRefusal | null;
}

/**
 * Nominal, and minted in exactly one place.
 *
 * `analysis/analyze.ts` is the only file permitted to cast to this, and
 * `tests/architecture/boundaries.test.ts` pins that list the same way it pins
 * `SanitizedContext` and `BakedScreenshot`. An object literal of the right
 * shape is not assignable, so a caller cannot hand the sanitizer numbers that
 * did not come from the engine.
 */
export type AnalysisResult = AnalysisShape & { readonly [ANALYZED]: true };

/** An identifier for a table on the page. A position, never a selector. */
export type TableIndex = Brand<number, 'TableIndex'>;

/**
 * Ceilings on what the engine may read.
 *
 * A table is page-controlled, so its size is attacker-controlled. Without a cap
 * a hostile page could hand the extension a 10-million-cell table and spend the
 * user's main thread on it - a denial of service that costs metric 4 (client
 * resource utilization, 20%) and metric 5 (latency, 15%) at once.
 *
 * `maxCells` rather than `maxRows` because cost is rows times columns, and a
 * 50-column table at 20,000 rows is the same work as a 5-column one at 200,000.
 */
export interface AnalysisLimits {
  readonly maxCells: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  /** Checked between columns. A budget, not a hard interrupt - JS has none. */
  readonly timeoutMs: number;
  /** Below this many points a trend or forecast is not attempted. */
  readonly minPointsForTrend: number;
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  /*
   * 200,000 cells - a 100,000-row table of two columns, or 20,000 rows of ten.
   * Measured rather than guessed: see `npm run analysis:bench`. Above this the
   * compute stops being free relative to the rest of the step.
   */
  maxCells: 200_000,
  maxRows: 100_000,
  maxColumns: 64,
  timeoutMs: 2_000,
  minPointsForTrend: 3,
};

/** True when a column's statistics may be trusted as covering the whole column. */
export function isColumnComplete(col: AnalyzedColumn): boolean {
  return col.nMissing === 0 && col.nRedacted === 0;
}

/** Nothing was computed. Distinct from "computed and found nothing". */
export function isEmptyAnalysis(a: AnalysisShape): boolean {
  return a.refusal !== null || a.rowsAnalyzed === 0;
}
