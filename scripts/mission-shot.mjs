import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Renders the telemetry demo page and writes PNGs.
 *
 * WHY THIS EXISTS. This repository has already learned the lesson twice: UI was
 * changed and shipped without anyone looking at it, the tests were green, and
 * the page still read badly. `scripts/panel-shots.mjs` was written for the side
 * panel after exactly that, and this is the same instrument pointed at the demo
 * page - which is the one artefact an examiner will actually look at.
 *
 * It renders the REAL page from the REAL server, so what is captured is what a
 * visitor gets, including the bundled analysis engine actually running.
 *
 *   node test-site/serve.mjs &
 *   node scripts/mission-shot.mjs
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'artifacts', 'mission-shots');
const URL_BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:8080';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const problems = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

await page.goto(`${URL_BASE}/mission.html`, { waitUntil: 'networkidle' });

/*
 * Wait for the analysis panel to have actually FILLED IN. Screenshotting before
 * the engine returns would capture the "waiting" placeholder and prove nothing
 * about the thing this page exists to show.
 */
await page.waitForFunction(
  () => {
    const el = document.getElementById('analysis-result');
    return el !== null && !el.textContent.includes('Waiting for');
  },
  { timeout: 20000 },
);

await page.screenshot({ path: join(OUT, 'mission-full.png'), fullPage: true });
await page.screenshot({ path: join(OUT, 'mission-above-fold.png') });

/* The two panels that carry the argument, on their own. */
for (const [name, selector] of [
  ['pipeline', '.band'],
  ['channels', '#channels'],
  ['chart', '.chart-wrap'],
  ['results', '.two-col'],
  ['flow', '.flow'],
]) {
  const node = page.locator(selector).first();
  if ((await node.count()) > 0) {
    await node.screenshot({ path: join(OUT, `mission-${name}.png`) });
  }
}

/* What the panels actually rendered, as text, so a regression is greppable. */
const summary = await page.evaluate(() => ({
  privacy: (document.getElementById('privacy-result')?.innerText ?? '').trim(),
  analysis: (document.getElementById('analysis-result')?.innerText ?? '').trim(),
  flow: ['flow-raw', 'flow-records', 'flow-payload'].map(
    (id) => document.getElementById(id)?.textContent ?? '?',
  ),
  rows: document.getElementById('stat-rows')?.textContent ?? '?',
}));

console.log('\n--- privacy panel ---\n' + summary.privacy);
console.log('\n--- analysis panel ---\n' + summary.analysis);
console.log(`\nflow: ${summary.flow[0]} raw -> ${summary.flow[1]} records + ${summary.flow[2]} metrics`);
console.log(`rows on page: ${summary.rows}`);
console.log(problems.length === 0 ? '\nno console errors' : `\nPROBLEMS:\n  ${problems.join('\n  ')}`);
console.log(`\nshots -> ${OUT.replace(ROOT, '.')}\n`);

await browser.close();
