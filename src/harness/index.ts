/**
 * Fixtures, scoring, timing and resource budgets.
 *
 * Sits ABOVE every other module in the dependency DAG: it may import all of
 * them, and none of them may import it. It also touches the filesystem, so
 * nothing in the extension bundle can depend on it.
 */
export { loadFixture, loadAllFixtures, allFixtureIds, parseFixture, resolveTruth, resolveBenign, truthLiterals } from './load.ts';
export type { Fixture, GroundTruth, GroundTruthItem, ExpectedElement, ResolvedGroundTruthItem, TruthLocator, BenignItem } from './types.ts';

export { runPipeline } from './pipeline.ts';
export type { PipelineOptions, PipelineOutput } from './pipeline.ts';

export { scoreDetections, scoreRedaction } from './score.ts';
export type { DetectionScore, RedactionScore, ScoreOptions } from './score.ts';

export { scoreScreenContext, nameSimilarity, normaliseName, SCREEN_WEIGHTS } from './score-screen.ts';
export type { ScreenContextScore, ScreenScoreOptions } from './score-screen.ts';

export { measureResources, checkBudget, loadBudgets, budgetFor, writeBudgets, toMemoryReading } from './resource.ts';
export type { ResourceMeasurement, Budget, BudgetFile, BudgetResult, MeasureOptions } from './resource.ts';

export { timeIt, distribution, benchmarkFn } from './timing.ts';
export type { Timed, Distribution } from './timing.ts';

export { runFixtureBenchmark, makeBenchDeps, scoreFixture, requestBytesFor, frameFor, benchFixtures } from './bench-runner.ts';
export type { RunBenchOptions } from './bench-runner.ts';

export { ensureDomParser } from './dom-env.ts';
