// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markUntrusted, redactionNonce } from '@/contracts/index.ts';
import { extractRefPaths, extractElements, redact, resolveDomPath, DEFAULT_VIEWPORT } from '@/redaction/index.ts';

/**
 * The ref -> element map must survive DOM drift between the snapshot it is
 * computed on and the LIVE page the content script resolves against.
 *
 * A real amazon.in run died here: the model chose the checkout submit, the
 * client matched it, and every click reported `failed` because the positional
 * `nth-of-type` path no longer walked to it on the mutated live page. The map
 * now anchors to a unique id/name, which redaction never rewrites and mutation
 * does not move.
 */
const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

describe('the execution map anchors on a stable id/name and survives drift', () => {
  const SNAPSHOT =
    '<!doctype html><html><body><div id="cart">' +
    '<form id="checkoutForm"><input name="proceedToRetailCheckout" type="submit" value="Proceed to checkout"></form>' +
    '</div></body></html>';
  // Live page seconds later: the site prepended a banner <div>, shifting every
  // positional nth-of-type on the path to the input.
  const LIVE = SNAPSHOT.replace('<body>', '<body><div class="banner">Sponsored</div>');

  it('uses a name/id selector, not a positional chain, for an identified control', () => {
    const paths = extractRefPaths(parse(SNAPSHOT));
    const sel = [...paths.values()][0]!;
    expect(sel).toBe('input[name="proceedToRetailCheckout"]');
    expect(sel).not.toContain('nth-of-type');
  });

  it('resolves on the drifted live page, where the positional path returns null', () => {
    const snap = parse(SNAPSHOT);
    const live = parse(LIVE);
    const sel = [...extractRefPaths(snap).values()][0]!;
    // The fix resolves live...
    expect(resolveDomPath(live, sel as never)?.getAttribute('name')).toBe('proceedToRetailCheckout');
    // ...where the old positional path does not.
    const positional = 'html>body:nth-of-type(1)>div:nth-of-type(1)>form:nth-of-type(1)>input:nth-of-type(1)';
    expect(resolveDomPath(live, positional as never)).toBeNull();
  });

  it('falls back to the positional path when there is no unique id/name', () => {
    const paths = extractRefPaths(parse('<!doctype html><html><body><a href="/1">A</a><a href="/2">B</a></body></html>'));
    for (const sel of paths.values()) expect(sel).toContain('nth-of-type');
  });

  it('does NOT anchor on a duplicated name - it would be ambiguous', () => {
    const dup = '<!doctype html><html><body>' +
      '<input name="q" value="1"><input name="q" value="2"></body></html>';
    const paths = extractRefPaths(parse(dup));
    for (const sel of paths.values()) expect(sel).toContain('nth-of-type');
  });

  it('keys still line up one-for-one with extractElements, and every selector resolves', () => {
    const doc = parse(SNAPSHOT);
    const r = redact(markUntrusted(SNAPSHOT), [], { viewport: DEFAULT_VIEWPORT, nonce: redactionNonce('reftest') });
    const paths = extractRefPaths(r.doc);
    const els = extractElements(r.doc, r.detections, { nonce: 'reftest' });
    expect([...paths.keys()]).toEqual(els.map((e) => String(e.ref)));
    for (const sel of paths.values()) expect(r.doc.querySelector(sel)).not.toBeNull();
    void doc;
  });
});
