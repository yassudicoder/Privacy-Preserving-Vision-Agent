import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Renders the real panel at sidebar width and writes PNGs.
 *
 * WHY THIS EXISTS. Two rounds of UI changes were made and shipped without
 * anyone looking at the result - the tests were green, the tokens were light,
 * and the panel still read badly. `tests/panel/*` render the component and
 * assert selectors; not one of them can see that a column is cramped, that a
 * drawer summary is invisible, or that the first thing a new user sees explains
 * nothing. Those are the actual complaints, and they need eyes.
 *
 * It bundles the REAL `App` with the REAL stylesheet - not a mock of either -
 * so what is on screen here is what ships. State comes from `reduceAll` over
 * real `PanelEvent`s where possible, so a screenshot cannot show a combination
 * the reducer could not produce.
 *
 *   node scripts/panel-shots.mjs            # all states
 *   node scripts/panel-shots.mjs firstrun   # one
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'artifacts', 'panel-shots');
const TMP = join(OUT, '.tmp');

const ENTRY = `
import { render } from 'preact';
import { App, initialPanelState, reduceAll } from '@/panel/index.ts';

const HOST = { kind: 'chrome-offscreen', running: true, modelLoaded: true, note: '', model: { backend: 'webgpu', loadMs: 412, weightBytes: 232589 } };
const CLOUD = { kind: 'cloud', endpoint: 'https://sih26171-agent-server.onrender.com', model: 'gpt-5.6-luna', offDevice: true, authenticated: true, encrypted: true };

/** A realistic mid-task state, built by the REAL reducer from real events. */
function ranState() {
  return reduceAll([
    { type: 'session/start', taskId: 't1', goal: 'add laptop pro to cart', at: 0 },
    { type: 'frame/captured', frameId: 'f1', bytes: 106028, ms: 21 },
    { type: 'redaction/done', ms: 8, log: {
        createdAt: 0, residualRisk: 'low', entries: Array.from({ length: 18 }, (_, i) => ({
          detectionId: 'd' + i, kind: i % 3 === 0 ? 'email' : i % 3 === 1 ? 'phone' : 'credit-card',
          source: 'dom', strategy: 'placeholder', applied: i < 16,
          target: { domPath: null, rect: null, attr: null }, placeholder: null,
          preservedShape: { length: 10, charClass: 'mixed' }, evidence: { digest: 'x' },
        })),
        summary: { byKind: {}, bySource: {}, nodesRemoved: 0, attributesDropped: 0, placeholdersInserted: 16, pixelOpsQueued: 16, forgeriesStripped: 0 },
      } },
    { type: 'bake/done', opsApplied: 1, opsRequested: 16, opsOutsideFrame: 15, bytes: 60028, ms: 34 },
    { type: 'context/sent', bytes: 82481, imageBytes: 60028, elementCount: 63, elementsAvailable: 63,
      estimatedTokens: 5057, tokenBudget: 30000, dropped: [], namesTruncated: 0, geometryOmitted: false,
      duplicatesCollapsed: 0, preview: null },
    { type: 'context/transmitted', channel: 'cloud', modelId: 'gpt-5.6-luna' },
    { type: 'server/response', action: { type: 'click', ref: 'e14' }, ms: 940, rawLength: 34, modelId: 'gpt-5.6-luna' },
    { type: 'action/executed', action: { type: 'click', ref: 'e14' }, ok: true, ms: 12 },
    { type: 'step/done', step: 1, ok: true, e2eMs: 1120 },
    { type: 'host/status', kind: 'chrome-offscreen', running: true, modelLoaded: true, note: 'webgpu, 0.22 MB in 412 ms', model: { backend: 'webgpu', loadMs: 412, weightBytes: 232589 } },
    { type: 'tab/attached', tabId: 544578691, note: 'attached to tab 544578691' },
  ]);
}

const STATES = {
  firstrun: () => ({ state: { ...initialPanelState, host: HOST }, props: {} }),
  ready: () => ({
    state: { ...initialPanelState, host: HOST, deployment: CLOUD,
      attachedTab: { tabId: 544578691, note: 'attached to tab 544578691' } },
    props: { messages: [] },
  }),
  conversation: () => ({
    state: { ...ranState(), deployment: CLOUD },
    props: { messages: [
      { role: 'you', text: 'add laptop pro to cart' },
      { role: 'agent', text: 'I found two laptops. Which one did you mean - Laptop Pro, or Gaming Laptop X?' },
      { role: 'you', text: 'Laptop Pro' },
      { role: 'agent', text: 'Done. Laptop Pro is in the cart.' },
    ] },
  }),
  question: () => ({
    state: { ...ranState(), deployment: CLOUD },
    props: {
      pendingQuestion: 'Which one did you mean - Laptop Pro, or Gaming Laptop X?',
      messages: [
        { role: 'you', text: 'add a laptop to the cart' },
        { role: 'agent', text: 'Which one did you mean - Laptop Pro, or Gaming Laptop X?' },
      ],
    },
  }),
};

const which = new URLSearchParams(location.search).get('s') || 'ready';
const { state, props } = STATES[which]();

render(
  <App
    state={state}
    build={{ version: '0.9.3', built: '2026-09-07 04:20 UTC' }}
    onRunTask={() => {}}
    onAnswer={() => {}}
    onStop={() => {}}
    onRunStep={() => {}}
    onGrantSite={() => {}}
    onClearPrivacyLens={() => {}}
    onSelectBackend={() => {}}
    onConfigureBackend={() => {}}
    onSetBackendToken={() => {}}
    onCheckBackend={() => {}}
    onToggleScreenshot={() => {}}
    onToggleVision={() => {}}
    onSetBudget={() => {}}
    onTogglePlanOnly={() => {}}
    onCopyReceipt={() => {}}
    onGrantOrigin={() => {}}
    onLoadModel={() => {}}
    budgetTokens={30000}
    tokenSet={{ cloud: true }}
    backendConfig={{ cloud: { endpoint: 'https://sih26171-agent-server.onrender.com', model: 'gpt-5.6-luna' } }}
    {...props}
  />,
  document.getElementById('root'),
);
`;

mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, 'entry.tsx'), ENTRY);

await build({
  entryPoints: [join(TMP, 'entry.tsx')],
  bundle: true,
  outfile: join(TMP, 'bundle.js'),
  jsx: 'automatic',
  jsxImportSource: 'preact',
  format: 'iife',
  logLevel: 'error',
  alias: { '@': join(ROOT, 'src') },
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
});

const css = readFileSync(join(ROOT, 'src/entrypoints/sidepanel/style.css'), 'utf8');
const js = readFileSync(join(TMP, 'bundle.js'), 'utf8');
writeFileSync(
  join(TMP, 'index.html'),
  `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${js}</script>`,
);

const only = process.argv[2];
const shots = only ? [only] : ['firstrun', 'ready', 'question', 'conversation'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 380, height: 720 }, deviceScaleFactor: 2 });

for (const s of shots) {
  await page.goto('file://' + join(TMP, 'index.html').replace(/\\/g, '/') + '?s=' + s);
  await page.waitForTimeout(150);
  const file = join(OUT, s + '.png');
  await page.screenshot({ path: file, fullPage: true });
  const h = await page.evaluate(() => document.body.scrollHeight);
  console.log(`  ${s.padEnd(13)} ${String(h).padStart(5)}px tall  ->  ${file}`);
}

// Drawers open, on the conversation state - the densest thing in the product.
await page.goto('file://' + join(TMP, 'index.html').replace(/\\/g, '/') + '?s=conversation');
await page.waitForTimeout(100);
for (const id of ['drawer-privacy', 'drawer-settings']) {
  await page.evaluate((i) => { document.querySelectorAll('details').forEach((d) => (d.open = false)); const d = document.getElementById(i); if (d) d.open = true; }, id);
  await page.waitForTimeout(100);
  const file = join(OUT, id + '.png');
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${id.padEnd(13)} -> ${file}`);
}

await browser.close();
rmSync(TMP, { recursive: true, force: true });
console.log('\nWrote ' + OUT);
