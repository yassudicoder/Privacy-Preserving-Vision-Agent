/* Adversarial probe for the "required + empty + !isSensitive" claim.
 * Runs the REAL redact() + buildSanitizedContext() over every fixture and the
 * test site, and reports every element that would trigger, plus near misses. */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  markUntrusted, redactionNonce, DEFAULT_BUDGET_POLICY, unsafeUnwrap,
} from '@/contracts/index.ts';
import { buildSanitizedContext, redact, DEFAULT_VIEWPORT } from '@/redaction/index.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:8080/' });
const g = globalThis as unknown as Record<string, unknown>;
g['DOMParser'] = dom.window.DOMParser;
g['Node'] = dom.window.Node;
g['Element'] = dom.window.Element;
g['document'] = dom.window.document;

const fixturesDir = fileURLToPath(new URL('./src/harness/fixtures/', import.meta.url));
const pages: { id: string; path: string }[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => ({ id: f, path: fixturesDir + f }));
pages.push({ id: 'test-site/index.html', path: fileURLToPath(new URL('./test-site/index.html', import.meta.url)) });
pages.push({ id: 'test-site/vision.html', path: fileURLToPath(new URL('./test-site/vision.html', import.meta.url)) });

function text(atom: unknown): string {
  if (atom === null || atom === undefined) return '<null>';
  try {
    return String((atom as { text?: unknown }).text ?? JSON.stringify(atom));
  } catch {
    return '<opaque>';
  }
}

let grand = 0;
for (const page of pages) {
  const html = readFileSync(page.path, 'utf8');
  const rawRequired = (html.match(/(?<![\w-])required(?![\w-])/g) ?? []).length;
  const result = redact(markUntrusted(html), [], {
    viewport: DEFAULT_VIEWPORT, nonce: redactionNonce('probe1234'),
  });
  const ctx = buildSanitizedContext({
    doc: result.doc, log: result.log, detections: result.detections,
    viewport: DEFAULT_VIEWPORT, url: 'http://localhost:8080/', taskId: 'probe', step: 0,
    goal: 'book a flight from mumbai to goa', screenshot: null, budget: DEFAULT_BUDGET_POLICY,
  });

  const required = ctx.elements.filter((e) => e.states.includes('required'));
  const wouldAsk = required.filter((e) => {
    const v = e.value === null ? '' : text(e.value);
    return v.trim() === '' && !e.isSensitive;
  });
  grand += wouldAsk.length;

  process.stdout.write(
    `\n=== ${page.id}\n  raw 'required' in source: ${String(rawRequired)}\n` +
    `  elements sent: ${String(ctx.elements.length)}\n` +
    `  states=required: ${String(required.length)}\n` +
    `  WOULD ASK (required, empty, not sensitive): ${String(wouldAsk.length)}\n`,
  );
  for (const e of required) {
    process.stdout.write(
      `    REQ ${e.ref} role=${e.role} name=${JSON.stringify(text(e.name))} ` +
      `value=${JSON.stringify(text(e.value))} sensitive=${String(e.isSensitive)}\n`,
    );
  }
  // near misses: every empty non-sensitive input-ish element that is NOT required
  const nearly = ctx.elements.filter(
    (e) => ['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton'].includes(e.role) &&
      !e.states.includes('required'),
  );
  for (const e of nearly) {
    process.stdout.write(
      `    -   ${e.ref} role=${e.role} name=${JSON.stringify(text(e.name))} ` +
      `value=${JSON.stringify(text(e.value))} sensitive=${String(e.isSensitive)}\n`,
    );
  }
}
process.stdout.write(`\nTOTAL WOULD-ASK ACROSS ALL PAGES: ${String(grand)}\n`);
void unsafeUnwrap;
