import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bundles the REAL redaction and analysis engines for the demo page.
 *
 * WHY THIS EXISTS. `test-site/mission.html` shows a "Local Analysis" panel and a
 * privacy summary. Those numbers have to be real or the demonstration is a
 * mock-up of itself - and the honest way to make them real is to run the
 * SHIPPED code, not a second implementation written to agree with it. A
 * reimplementation would drift, and the first time it drifted the demo would
 * quietly start proving something the product does not do.
 *
 * So this bundles `src/redaction` and `src/analysis` exactly as they ship in the
 * extension, and the page runs the same two functions the extension runs:
 *
 *     redact(html)  ->  a document with the PII replaced by placeholders
 *     analyzeDocument(thatDocument)  ->  the statistics
 *
 * WHAT IS AND IS NOT THE SAME AS AN EXTENSION RUN. Same code, same order, same
 * result for the same input. What differs is WHERE the input comes from: the
 * extension snapshots the live page through its content script and the panel
 * reports what it measured. The page here feeds the engines its own table. The
 * two agree because they are the same functions; the page says so rather than
 * implying it is showing the extension's own numbers.
 *
 * Output is generated, not committed - `npm run test-site` rebuilds it every
 * time, so it cannot go stale against the source it is bundled from.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'test-site', '.engine-tmp');
const OUT = join(ROOT, 'test-site', 'demo-engine.js');

/*
 * A SMALL, EXPLICIT SURFACE. Only the two entry points the page needs, plus the
 * helpers required to call them. Exporting the whole barrel would put the agent
 * client and the panel reducer into a page that has no use for either.
 */
const ENTRY = `
import { redact } from '@/redaction/index.ts';
import { analyzeDocument } from '@/analysis/index.ts';
import { markUntrusted, redactionNonce, summariseAnalysis } from '@/contracts/index.ts';

/**
 * Run the real pipeline over a fragment of this page.
 *
 * The nonce is fixed here because nothing on this page checks one - the nonce
 * exists so a SERVER can reject a placeholder a hostile page minted, and there
 * is no server in this path. Everything else is exactly what the extension does.
 */
function runPipeline(html) {
  const started = performance.now();
  const result = redact(markUntrusted(html), [], {
    viewport: { cssWidth: window.innerWidth, cssHeight: window.innerHeight, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'demo-page-salt',
    nonce: redactionNonce('a1b2c3d4'),
    minConfidence: 0.5,
    frameId: 'demo',
    url: String(location.href),
    now: Date.now(),
  });
  const redactMs = performance.now() - started;

  const analysis = analyzeDocument(result.doc);
  const receipt = summariseAnalysis(analysis);

  const applied = result.log.entries.filter((e) => e.applied);
  const byKind = {};
  for (const entry of applied) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;

  return {
    analysis,
    receipt,
    redactMs,
    piiApplied: applied.length,
    piiByKind: byKind,
    /*
     * The exact bytes that would go on the wire for the analysis block. Measured
     * off the object, never estimated - it is half of the comparison the page
     * is making and an estimate would make the other half meaningless.
     */
    payloadBytes: JSON.stringify(analysis).length,
  };
}

window.__SIH_ENGINE = { runPipeline };
`;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, 'entry.ts'), ENTRY, 'utf8');

await build({
  entryPoints: [join(TMP, 'entry.ts')],
  bundle: true,
  outfile: OUT,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'error',
  alias: { '@': join(ROOT, 'src') },
  loader: { '.ts': 'ts' },
});

rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`demo engine bundled -> ${OUT.replace(ROOT, '.')}\n`);
