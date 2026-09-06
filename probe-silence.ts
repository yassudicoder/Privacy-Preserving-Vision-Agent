/* Adversarial probe: run the REAL pipeline over test-site/index.html and ask
 * detectAmbiguity exactly what step.ts:684 asks it. Not part of npm test. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  markUntrusted, redactionNonce, detectAmbiguity, DEFAULT_BUDGET_POLICY,
} from '@/contracts/index.ts';
import { buildSanitizedContext, redact, DEFAULT_VIEWPORT } from '@/redaction/index.ts';

const HTML_PATH = fileURLToPath(new URL('./test-site/index.html', import.meta.url));
const PAGE_URL = 'http://localhost:8080/';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: PAGE_URL });
const g = globalThis as unknown as Record<string, unknown>;
g['DOMParser'] = dom.window.DOMParser;
g['Node'] = dom.window.Node;
g['Element'] = dom.window.Element;
g['document'] = dom.window.document;

const html = readFileSync(HTML_PATH, 'utf8');
const result = redact(markUntrusted(html), [], {
  viewport: DEFAULT_VIEWPORT, nonce: redactionNonce('testlab1'),
});

const GOALS = [
  'Search for laptop',
  'Open Laptop Pro',
  'Add Laptop Pro to cart',
  'Select India as country',
  'Write a review saying Great laptop',
  'Login with the test account',
  'Enable the terms checkbox',
  'Go to the profile',
  'Search for headphones',
];

for (const goal of GOALS) {
  const context = buildSanitizedContext({
    doc: result.doc, log: result.log, detections: result.detections,
    viewport: DEFAULT_VIEWPORT, url: PAGE_URL, taskId: 'probe', step: 0,
    goal, screenshot: null, budget: DEFAULT_BUDGET_POLICY,
  });
  const f = detectAmbiguity(goal, context.elements);
  if (f === null) {
    process.stdout.write(`SILENT  ${goal}\n          (${context.elements.length} elements)\n`);
  } else {
    process.stdout.write(`ASK     ${goal}\n          term=${f.term}\n          ${f.question}\n`);
  }
}
