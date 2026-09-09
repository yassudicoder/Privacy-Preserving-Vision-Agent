import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  hasAnyPlaceholder,
  inspectAnalysis,
  markUntrusted,
  redactionNonce,
  summariseAnalysis,
} from '@/contracts/index.ts';
import { analyzeDocument } from '@/analysis/index.ts';
import { redact } from '@/redaction/index.ts';

/**
 * Does the LIVE demo page actually exercise the analysis engine?
 *
 * `mission.html` exists to be shown to a room, and a demo that quietly fails to
 * trigger half of what it claims to show is worse than no demo. So this loads
 * the REAL page, runs its REAL script to generate frames, then puts the result
 * through the REAL redactor and the REAL engine and reports which capabilities
 * actually fired - trend, correlation, outlier, forecast, redaction, chart.
 *
 * It also greps the exact outbound bytes for the invented PII, the same check
 * `verify-analysis.ts` makes over the static datasets. The demo page must clear
 * the same bar as the fixtures.
 *
 *   npx tsx test-site/verify-mission.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/*
 * `redact()` needs a DOMParser and Node has none. Supplied from a throwaway
 * jsdom, exactly as the other verifiers do it - the page under test gets its
 * OWN jsdom below, so the two never share a document.
 */
(globalThis as unknown as { DOMParser: unknown }).DOMParser = new JSDOM(
  '<!doctype html><html><body></body></html>',
).window.DOMParser;
const NONCE = redactionNonce('a1b2c3d4');

/** Literals the page plants. None may survive into the analysis block. */
const PLANTED = ['example.invalid', 'Iyer', 'Fernandes', 'Bakshi', 'Kulkarni', 'Menon', 'Raghavan'];

function buildPage(frames: number): { doc: Document; close: () => void } {
  const html = readFileSync(join(HERE, 'mission.html'), 'utf8');
  const script = readFileSync(join(HERE, 'mission.js'), 'utf8');

  /*
   * The page is loaded with its own script INLINED rather than by letting jsdom
   * fetch `mission.js`, because jsdom resolves that against a `file://` base and
   * silently renders an empty table when it cannot. An empty table would make
   * every assertion below vacuous, which is the one failure this file must not
   * have.
   */
  const inlined = html.replace(
    '<script src="mission.js"></script>',
    `<script>${script}</script>`,
  );

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {
    // jsdom has no canvas backend; `drawTrace` guards for it and returns.
  });

  const dom = new JSDOM(inlined, {
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    virtualConsole,
  });

  // The page opens with 60 frames. Top up to the requested size through the
  // page's OWN generator, so what is analysed is what a viewer would see.
  const extra = frames - 60;
  if (extra > 0) dom.window.eval(`append(${String(extra)})`);

  return {
    doc: dom.window.document,
    close: () => {
      dom.window.close();
    },
  };
}

function run(frames: number): void {
  const { doc, close } = buildPage(frames);

  const rowsOnPage = doc.querySelectorAll('#downlink-body tr').length;
  const canvases = doc.querySelectorAll('canvas, svg').length;

  const tRedact = Date.now();
  const result = redact(markUntrusted(doc.documentElement.outerHTML), [], {
    viewport: { cssWidth: 1280, cssHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'demo-salt',
    nonce: NONCE,
    minConfidence: 0.5,
    frameId: 'f1',
    url: 'http://localhost:8080/mission.html',
    now: Date.now(),
  });
  const redactMs = Date.now() - tRedact;

  const analysis = analyzeDocument(result.doc);
  const wire = JSON.stringify(analysis);
  const receipt = summariseAnalysis(analysis);
  const violations = inspectAnalysis(analysis);

  const leaked = PLANTED.filter((p) => wire.includes(p));
  const placeholderLeak = hasAnyPlaceholder(wire);

  const numeric = analysis.columns.filter((c) => c.kind === 'numeric');
  const redactedCols = analysis.columns.filter((c) => c.kind === 'redacted');
  const strong = analysis.correlations.filter((c) => c.strength === 'strong');
  const rising = analysis.trends.filter((t) => t.direction === 'rising');
  const falling = analysis.trends.filter((t) => t.direction === 'falling');

  console.log(`\n--- ${String(rowsOnPage)} frames on the page -------------------------------`);
  console.log(
    `  redact ${String(redactMs)} ms   analyse ${String(Math.round(analysis.computeMs))} ms   ` +
      `payload ${String(wire.length)} B   gate ${violations.length === 0 ? 'OK' : 'REFUSED'}   ` +
      `${leaked.length === 0 && !placeholderLeak ? 'NO LEAK' : `LEAK: ${leaked.join(',')}`}`,
  );
  console.log(
    `  rows analysed ${String(analysis.rowsAnalyzed)}   ` +
      `numeric cols ${String(numeric.length)}   redacted cols ${String(redactedCols.length)}   ` +
      `PII cells excluded ${String(receipt.piiCellsExcluded)}   charts ${String(analysis.chartsDetected)}`,
  );

  /*
   * THE CAPABILITY CHECKLIST. The page claims to demonstrate these; this says
   * whether the engine found them, on this run, with this seed. A blank here is
   * a demo that will not show what it promises.
   */
  const checks: readonly [string, boolean, string][] = [
    ['rising trend', rising.length > 0, rising.map((t) => label(t.columnIndex)).join(', ')],
    ['falling trend', falling.length > 0, falling.map((t) => label(t.columnIndex)).join(', ')],
    [
      'strong correlation',
      strong.length > 0,
      strong.slice(0, 3).map((c) => `${label(c.aIndex)}~${label(c.bIndex)} r=${(c.r ?? 0).toFixed(2)}`).join(', '),
    ],
    [
      'outliers',
      analysis.outliers.length > 0,
      `${String(analysis.outliers.length)} found, worst z=${maxZ(analysis.outliers).toFixed(1)}`,
    ],
    [
      'forecast with an interval',
      analysis.forecasts.some((f) => f.lower !== null),
      analysis.forecasts
        .filter((f) => f.lower !== null)
        .slice(0, 2)
        .map((f) => `${label(f.columnIndex)} next=${f.next.toFixed(0)}`)
        .join(', '),
    ],
    ['PII columns removed', redactedCols.length > 0, redactedCols.map((c) => c.label?.text ?? '?').join(', ')],
    ['missing / unparsed counted', analysis.columns.some((c) => c.nMissing + c.nUnparsed > 0), ''],
    ['chart detected', analysis.chartsDetected > 0, `${String(analysis.chartsDetected)} canvas/svg`],
  ];

  for (const [name, ok, detail] of checks) {
    console.log(`    ${ok ? 'yes' : 'NO '}  ${name.padEnd(28)} ${detail}`);
  }

  function label(index: number): string {
    return analysis.columns.find((c) => c.index === index)?.label?.text ?? `col${String(index)}`;
  }

  close();
}

function maxZ(outliers: readonly { readonly z: number }[]): number {
  return outliers.reduce((m, o) => Math.max(m, Math.abs(o.z)), 0);
}

console.log('\nLIVE DEMO PAGE - real page, real script, real redactor, real engine');
for (const frames of [60, 300, 1200]) run(frames);
console.log('');
