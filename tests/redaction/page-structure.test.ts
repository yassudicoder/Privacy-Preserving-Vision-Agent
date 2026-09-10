// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_POLICY,
  inspectOutboundContext,
  markUntrusted,
  redactionNonce,
} from '@/contracts/index.ts';
import {
  DEFAULT_VIEWPORT,
  buildSanitizedContext,
  redact,
  validationContextFor,
  verifyOutboundRedaction,
} from '@/redaction/index.ts';
import { renderPrompt } from '@/agent-server/index.ts';

/**
 * The page reaches the model as sanitized HTML: the controls and headings,
 * the containers around them, and a closed set of attributes - and nothing a
 * stylesheet, a script or DevTools would add. Built from the REDACTED document,
 * through the same gates as before.
 */
const HOSTILE = `<!doctype html><html><head>
<style>.nav-input{color:red}</style><script>alert("leak")</script><title>Shop</title></head><body>
<header><form id="search-form" role="search" action="/s?session=abc">
  <input type="text" name="field-keywords" id="q" class="nav-input" style="width:100px"
         onfocus="steal()" data-tracking="zz9" placeholder="Search">
  <input type="submit" value="Go">
</form></header>
<main><ul>
  <li><h2>Apple MacBook Pro</h2>
      <a href="/dp/B0MAC?ref=sr_1&amp;email=john.doe@example.com#reviews">Apple MacBook Pro</a>
      <button class="a-button">Add to cart</button></li>
  <li><h2>Dell XPS 13</h2>
      <a href="https://other.example/dp/DELL?x=1">Dell XPS 13</a>
      <button class="a-button">Add to cart</button></li>
</ul>
<a id="contact-john.doe@example.com" href="mailto:john.doe@example.com">Contact us</a>
</main></body></html>`;

function build() {
  const result = redact(markUntrusted(HOSTILE), [], {
    viewport: DEFAULT_VIEWPORT,
    nonce: redactionNonce('ab12cd34'),
  });
  return buildSanitizedContext({
    doc: result.doc,
    log: result.log,
    detections: result.detections,
    viewport: DEFAULT_VIEWPORT,
    url: 'https://shop.example/s?k=laptop',
    taskId: 't',
    step: 0,
    goal: 'add the dell laptop to the cart',
    screenshot: null,
    budget: DEFAULT_BUDGET_POLICY,
  });
}

describe('the page representation is sanitized HTML with structure', () => {
  const ctx = build();
  const prompt = renderPrompt(ctx);
  const payload = JSON.stringify(ctx);

  it('carries tag, useful attributes and the enclosing form', () => {
    const q = ctx.elements.find((e) => e.attrs?.some((a) => a.key === 'name' && a.value.text === 'field-keywords'));
    expect(q?.tag).toBe('input');
    expect(Object.fromEntries((q?.attrs ?? []).map((a) => [a.key, a.value.text]))).toEqual({
      id: 'q',
      name: 'field-keywords',
      type: 'text',
      placeholder: 'Search',
    });
    const form = ctx.containers?.[q?.container ?? -1];
    expect(form).toMatchObject({ tag: 'form', role: 'search' });
    expect(prompt).toContain('<form role="search" id="search-form">');
    expect(prompt).toContain('<input id="q" name="field-keywords" type="text" placeholder="Search">');
  });

  it('sends NO CSS, script, class, style, handler or data-* - in the payload or the prompt', () => {
    for (const text of [payload, prompt]) {
      for (const banned of ['color:red', 'alert(', 'nav-input', 'a-button', 'width:100px', 'steal()', 'zz9', 'class=', 'style=', 'onfocus']) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it('shows no artificial refs to the model', () => {
    expect(prompt).not.toMatch(/\bref=e\d+/);
    expect(prompt).not.toMatch(/"ref"\s*:/);
  });

  it('cuts hrefs to origin + path, and drops any attribute carrying PII', () => {
    expect(prompt).toContain('<a href="/dp/B0MAC">Apple MacBook Pro</a>');
    expect(prompt).toContain('<a href="https://other.example/dp/DELL">Dell XPS 13</a>');
    expect(prompt).toContain('<a href="mailto:">Contact us</a>');
    expect(payload).not.toContain('john.doe');
    expect(payload).not.toContain('session=abc');
  });

  it('marks each repeated control with its own section, nested in its own <li>', () => {
    expect(prompt).toContain('<button within="Apple MacBook Pro">Add to cart</button>');
    expect(prompt).toContain('<button within="Dell XPS 13">Add to cart</button>');
    // The page data only: the instructions carry a worked example with its own <li>s.
    const page = prompt.slice(prompt.indexOf('PAGE HTML (sanitized'));
    expect(page.match(/<li>/g)?.length).toBe(2);
  });

  it('passes both egress gates unchanged', () => {
    expect(inspectOutboundContext(ctx)).toEqual([]);
    expect(verifyOutboundRedaction(ctx, { minConfidence: 0.5 }).ok).toBe(true);
  });

  it('resolves the model-style target to the Dell button, and refuses it without `within`', () => {
    const vctx = validationContextFor(ctx, ['https://shop.example']);
    const dell = vctx.locate?.({ tag: 'button', text: 'Add to cart', within: 'Dell XPS' });
    expect(dell?.ok).toBe(true);
    const chosen = ctx.elements.find((e) => dell?.ok === true && e.ref === dell.ref);
    expect(chosen?.groupName?.text).toBe('Dell XPS 13');
    expect(vctx.locate?.({ tag: 'button', text: 'Add to cart' })).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});
