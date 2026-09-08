import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_ANALYSIS_LIMITS,
  hasAnyPlaceholder,
  inspectAnalysis,
  markUntrusted,
  redactionNonce,
} from '@/contracts/index.ts';
import { analyzeDocument } from '@/analysis/index.ts';
import { redact } from '@/redaction/index.ts';

/**
 * The end-to-end proof, over the SYNTHETIC datasets, at every size.
 *
 * Not a unit test: it runs the real redactor and the real analysis engine over
 * real generated pages up to 100,000 rows, and reports what would actually
 * reach the model. `npm test` cannot do this - a 100,000-row fixture in
 * `src/harness/fixtures/` would be parsed and redacted by eight test files on
 * every run, for coverage the 100-row case already gives.
 *
 * What it measures, per dataset:
 *   - rows analyzed, and PII cells the redactor removed BEFORE analysis
 *   - the exact byte size of the analysis block that would be transmitted
 *   - whether any planted fake PII literal survives into that block
 *   - whether the egress gate accepts it
 *   - wall-clock, against the resource budget
 *
 *   npx tsx test-site/verify-analysis.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const NONCE = redactionNonce('a1b2c3d4');

/** Literals the generator plants. None may survive into the analysis block. */
const PLANTED = ['example.invalid', 'Test Subject', 'Sample Person', 'Demo User', '+91 98'];

function run(file: string): void {
  const path = join(HERE, 'data', file);
  if (!existsSync(path)) {
    console.log(`  ${file.padEnd(24)} SKIPPED - run: node scripts/make-datasets.mjs`);
    return;
  }
  const html = readFileSync(path, 'utf8');

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const g = globalThis as unknown as { DOMParser?: unknown };
  g.DOMParser = dom.window.DOMParser;

  const tRedact = Date.now();
  const result = redact(markUntrusted(html), [], {
    viewport: { cssWidth: 1280, cssHeight: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'verify-salt',
    nonce: NONCE,
    minConfidence: 0.5,
    frameId: 'f1',
    url: 'https://synthetic.invalid/data',
    now: Date.now(),
  });
  const redactMs = Date.now() - tRedact;

  const applied = result.log.entries.filter((e) => e.applied).length;

  const analysis = analyzeDocument(result.doc, { limits: DEFAULT_ANALYSIS_LIMITS });
  const wire = JSON.stringify(analysis);

  // The gate must accept a real analysis, or the feature does not ship.
  const violations = inspectAnalysis(analysis);

  /*
   * THE ASSERTION THAT MATTERS. Not "we believe it is clean" - the planted
   * literals are searched for in the exact bytes that would be transmitted.
   */
  const leaked = PLANTED.filter((p) => wire.includes(p));
  const placeholderLeak = hasAnyPlaceholder(wire);

  const numeric = analysis.columns.filter((c) => c.kind === 'numeric').length;
  const redactedCols = analysis.columns.filter((c) => c.kind === 'redacted').length;
  const piiCells = analysis.columns.reduce((a, c) => a + c.nRedacted, 0);

  console.log(
    `  ${file.padEnd(24)} ` +
      `${String(analysis.rowsAnalyzed).padStart(7)} rows  ` +
      `${String(numeric)}num/${String(redactedCols)}pii cols  ` +
      `${String(piiCells).padStart(7)} PII cells removed  ` +
      `${String(wire.length).padStart(6)} B out  ` +
      `redact ${String(redactMs).padStart(5)}ms  ` +
      `analyse ${String(Math.round(analysis.computeMs)).padStart(4)}ms  ` +
      `${violations.length === 0 ? 'GATE OK' : 'GATE REFUSED'}  ` +
      `${leaked.length === 0 && !placeholderLeak ? 'NO LEAK' : 'LEAK: ' + leaked.join(',')}`,
  );

  if (violations.length > 0) {
    for (const v of violations.slice(0, 3)) console.log(`      ! ${v.code}: ${v.detail}`);
  }
  if (analysis.refusal !== null) console.log(`      refusal: ${analysis.refusal}`);
}

console.log('\nSYNTHETIC ANALYSIS VERIFICATION - real redactor, real engine, real bytes\n');
for (const n of [100, 1000, 10000, 100000]) {
  for (const stem of ['telemetry', 'sales']) run(`${stem}-${n}.html`);
}

// A worked example at one size, so the numbers are readable rather than a table.
const path = join(HERE, 'data', 'telemetry-1000.html');
if (existsSync(path)) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  (globalThis as unknown as { DOMParser?: unknown }).DOMParser = dom.window.DOMParser;
  const r = redact(markUntrusted(readFileSync(path, 'utf8')), [], {
    viewport: { cssWidth: 1280, cssHeight: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 's', nonce: NONCE, minConfidence: 0.5, frameId: 'f', url: 'https://x.invalid/', now: 0,
  });
  const a = analyzeDocument(r.doc);
  console.log('\ntelemetry-1000, what the model would be told:\n');
  for (const c of a.columns) {
    const label = c.label?.text ?? `col${String(c.index)}`;
    if (c.kind === 'redacted') {
      console.log(`  ${label.padEnd(16)} REDACTED  ${String(c.nRedacted)} PII cells excluded`);
      continue;
    }
    if (c.stats === null) {
      console.log(`  ${label.padEnd(16)} ${c.kind}`);
      continue;
    }
    const t = a.trends.find((x) => x.columnIndex === c.index);
    const s = a.series.find((x) => x.columnIndex === c.index);
    const f = a.forecasts.find((x) => x.columnIndex === c.index);
    console.log(
      `  ${label.padEnd(16)} n=${String(c.n).padStart(4)} ` +
        `mean=${c.stats.mean.toFixed(2).padStart(10)} ` +
        `min=${c.stats.min.toFixed(1).padStart(9)} max=${c.stats.max.toFixed(1).padStart(9)} ` +
        `${(t?.direction ?? '-').padEnd(7)} r2=${(t?.r2 ?? 0).toFixed(2)} ` +
        `vol=${(s?.band ?? '-').padEnd(6)} ${(s?.momentum ?? '-').padEnd(12)} ` +
        `next=${f === undefined ? '-' : f.next.toFixed(1)}`,
    );
  }
  console.log(`\n  charts on page: ${String(a.chartsDetected)}   outliers: ${String(a.outliers.length)}`);
  for (const cr of a.correlations.filter((x) => x.strength === 'strong').slice(0, 4)) {
    const an = a.columns[cr.aIndex]?.label?.text ?? String(cr.aIndex);
    const bn = a.columns[cr.bIndex]?.label?.text ?? String(cr.bIndex);
    console.log(`  correlation: ${an} vs ${bn}  r=${(cr.r ?? 0).toFixed(3)} (${cr.strength})`);
  }
}
console.log('');
