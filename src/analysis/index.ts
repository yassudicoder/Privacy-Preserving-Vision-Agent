/**
 * Local, deterministic data analysis.
 *
 * "Computers calculate; the model explains." Everything in this module runs on
 * the user's device over the ALREADY-REDACTED document, reaches no network, and
 * emits numbers - so a 100,000-row table becomes roughly 40 values, and the raw
 * rows never leave the machine.
 *
 * The module may import only `contracts`, like every other feature module. The
 * `AnalysisResult` TYPE lives in `contracts/analysis.ts` because
 * `SanitizedContextShape` carries it and contracts may import nothing; the
 * compute lives here. `redaction/sanitize.ts` remains the sole minting site for
 * a `SanitizedContext`, and `analysis/analyze.ts` is the sole minting site for
 * an `AnalysisResult`.
 */
export { analyzeDocument } from './analyze.ts';
export type { AnalyzeOptions } from './analyze.ts';

export { chooseTable, readTable, parseNumber } from './table.ts';
export type { RawColumn, ReadTableResult } from './table.ts';

export {
  correlate,
  forecastNext,
  linearFit,
  mean,
  median,
  outliers,
  pearson,
  percentile,
  stdDev,
  sum,
  summarize,
  timeSeriesFeatures,
  trend,
} from './stats.ts';
