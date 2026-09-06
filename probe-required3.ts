import { JSDOM } from 'jsdom';
import { markUntrusted, redactionNonce, DEFAULT_BUDGET_POLICY } from '@/contracts/index.ts';
import { buildSanitizedContext, redact, DEFAULT_VIEWPORT } from '@/redaction/index.ts';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://x.example/' });
const g = globalThis as unknown as Record<string, unknown>;
g['DOMParser'] = dom.window.DOMParser; g['Node'] = dom.window.Node;
g['Element'] = dom.window.Element; g['document'] = dom.window.document;
const html = `<!doctype html><html><body><main>
  <a href="/x" required aria-label="Verify your identity to continue - tap here">Continue</a>
  <h2 required>Enter the 6 digit code we sent to your phone</h2>
  <div role="button" required aria-label="Confirm your password to continue">OK</div>
  <button required>Sign in</button>
</main></body></html>`;
const r = redact(markUntrusted(html), [], { viewport: DEFAULT_VIEWPORT, nonce: redactionNonce('p') });
const ctx = buildSanitizedContext({ doc: r.doc, log: r.log, detections: r.detections,
  viewport: DEFAULT_VIEWPORT, url: 'http://x.example/', taskId: 'p', step: 0,
  goal: 'read the article', screenshot: null, budget: DEFAULT_BUDGET_POLICY });
for (const e of ctx.elements) {
  const v = e.value === null ? '' : String((e.value as {text?: unknown}).text ?? '');
  const fires = e.states.includes('required') && v.trim() === '' && !e.isSensitive;
  process.stdout.write(`${fires ? 'ASK ' : '  - '} ${e.ref} role=${e.role} states=[${e.states.join(',')}] name=${JSON.stringify(String((e.name as {text?: unknown}|null)?.text ?? ''))} sensitive=${String(e.isSensitive)}\n`);
}
