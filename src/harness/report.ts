import { SIH_WEIGHTS } from '@/contracts/index.ts';
import { allFixtureIds } from './load.ts';
import { runPipeline } from './pipeline.ts';
import { scoreDetections, scoreRedaction } from './score.ts';
import { scoreScreenContext } from './score-screen.ts';
import { runFixtureBenchmark } from './bench-runner.ts';
import { ensureDomParser } from './dom-env.ts';

/**
 * The scorecard. `npm run scorecard`.
 *
 * Prints the five rubric numbers per fixture, so the effect of a change on the
 * thing we are actually graded on is one command away rather than an argument.
 */

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`.padStart(7);
}

async function main(): Promise<void> {
  await ensureDomParser();
  const ids = allFixtureIds();

  console.log('\nSIH26171 scorecard');
  console.log('='.repeat(78));
  console.log(
    ['fixture'.padEnd(14), 'visual', 'pii-P', 'pii-R', 'redact-P', 'leaks', ' sub-thr'].join('  '),
  );
  console.log('-'.repeat(78));

  let leakTotal = 0;
  for (const id of ids) {
    const run = runPipeline(id);
    const det = scoreDetections(run.result.detections, run.resolvedTruth, {
      minConfidence: run.minConfidence,
    });
    const strict = scoreDetections(run.result.detections, run.resolvedTruth);
    const red = scoreRedaction(
      run.result.html,
      run.result.log,
      run.fixture.truth,
      run.resolvedTruth,
      run.benignPaths,
    );
    const screen = scoreScreenContext(run.context.elements, run.fixture.truth.expectedElements);
    leakTotal += red.leaks.length;

    console.log(
      [
        id.padEnd(14),
        pct(screen.score),
        pct(det.precision),
        pct(det.recall),
        pct(red.redactionPrecision),
        String(red.leaks.length).padStart(5),
        String(det.belowThreshold).padStart(7),
      ].join('  '),
    );
    if (red.leaks.length > 0) console.log(`    LEAKED: ${red.leaks.join(', ')}`);
    if (det.unmatchedTruth.length > 0) console.log(`    missed: ${det.unmatchedTruth.join(', ')}`);
    if (det.unmatchedFound.length > 0) {
      console.log(`    spurious: ${det.unmatchedFound.join(', ')}`);
    }
    if (strict.unmatchedFound.length > det.unmatchedFound.length) {
      // Detections the system produced but never acts on. Shown so the
      // operating-point number cannot quietly hide weak-rule noise.
      const extra = strict.unmatchedFound.filter((f) => !det.unmatchedFound.includes(f));
      console.log(`    below threshold (never redacted): ${extra.join(', ')}`);
    }
  }

  console.log('-'.repeat(78));
  console.log(
    `weights: visual ${String(SIH_WEIGHTS.visualContext)} | pii ${String(SIH_WEIGHTS.piiDetection)} | redaction ${String(SIH_WEIGHTS.redactionPrecision)} | resource ${String(SIH_WEIGHTS.clientResource)} | latency ${String(SIH_WEIGHTS.latency)}`,
  );
  console.log(`total leaks across all fixtures: ${String(leakTotal)}`);
  console.log('pii-P/pii-R are measured at the redaction threshold; sub-thr counts');
  console.log('detections the system produced but never acts on.');

  const report = await runFixtureBenchmark({ now: Date.now() });
  console.log('\nbenchmark');
  console.log('-'.repeat(78));
  for (const row of report.ranking) {
    console.log(
      `${row.candidateId.padEnd(16)} ${row.backend.padEnd(10)} rubric ${row.rubricScore.toFixed(3)}  (${String(row.failures)} failure(s) over ${String(row.fixtures)} run(s))`,
    );
  }
  console.log(`\nscreenshot policy: ${report.screenshot.sendScreenshot ? 'SEND' : 'DO NOT SEND'}`);
  console.log(`  ${report.screenshot.rationale}`);
  console.log('');
}

await main();
