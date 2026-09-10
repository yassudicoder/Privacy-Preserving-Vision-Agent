// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buildSanitizedContext,
  extractElements,
  extractRefPaths,
  redact,
  DEFAULT_VIEWPORT,
  RECT_ATTR,
  UNRENDERED_ATTR,
} from '@/redaction/index.ts';
import {
  DEFAULT_BUDGET_POLICY,
  markUntrusted,
  redactionNonce,
  rankElement,
  type SanitizedElement,
  type ViewportInfo,
} from '@/contracts/index.ts';

/**
 * A control nobody can see must not be offered to the model as a choice.
 *
 * On a real amazon.in run the agent stopped and asked:
 *
 *   Which one did you mean - Cart, shift, alt, c, or 1 item in cart?
 *
 * Two links to one destination, differing only in that one of them is parked
 * off-screen as part of a keyboard-shortcut menu. Neither answer was useful and
 * the task could not continue.
 *
 * The evidence to exclude it always survived the parse and was never read:
 * `stampGeometry` runs in the content script against the LIVE DOM, where the
 * browser has applied the stylesheet, and writes both the real rect and a marker
 * for elements it gave no box at all. `isHidden` consulted neither, because
 * extraction runs against a `DOMParser` document with no CSS - so every
 * class-based hiding idiom was invisible to it.
 */

function ensureParser(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g['DOMParser'] = window.DOMParser;
  g['Node'] = window.Node;
  g['Element'] = window.Element;
  g['document'] = window.document;
}

/** Build a context the way the pipeline does, from HTML carrying stamped rects. */
function contextFor(bodyHtml: string): ReturnType<typeof buildSanitizedContext> {
  ensureParser();
  const result = redact(markUntrusted(`<!doctype html><html><body>${bodyHtml}</body></html>`), [], {
    viewport: DEFAULT_VIEWPORT,
    nonce: redactionNonce('offscreen'),
  });
  return buildSanitizedContext({
    doc: result.doc,
    log: result.log,
    detections: result.detections,
    viewport: DEFAULT_VIEWPORT,
    url: 'https://example.invalid/',
    taskId: 't',
    step: 0,
    goal: 'go to the cart',
    screenshot: null,
    budget: DEFAULT_BUDGET_POLICY,
  });
}

const names = (ctx: { elements: readonly SanitizedElement[] }): string[] =>
  ctx.elements.map((e) => e.name?.text ?? '');

describe('an element parked off-screen is not extracted', () => {
  it('drops a link at the -9999px hiding position, keeping the real one', () => {
    /*
     * The amazon.in shape, reduced: two links to the cart, one of them an entry
     * in a shortcut menu parked far to the left. Only the visible one should
     * reach the model - with both, `detectAmbiguity` sees two distinctly-named
     * links matching the goal term and stops to ask which.
     */
    const ctx = contextFor(
      `<a href="/cart" ${RECT_ATTR}="1200,20,80,40">1 item in cart</a>` +
        `<a href="/cart" ${RECT_ATTR}="-9966,20,120,40">Cart, shift, alt, c</a>`,
    );
    expect(names(ctx)).toEqual(['1 item in cart']);
  });

  it('drops an element the browser gave no box at all', () => {
    // The class-based `display:none` idiom. No attribute on the element says so;
    // `stampGeometry` marks it because the live browser reported no rect.
    const ctx = contextFor(
      `<a href="/x" ${RECT_ATTR}="10,10,80,40">Real</a>` +
        `<a href="/x" ${UNRENDERED_ATTR}="">Hidden by a stylesheet</a>`,
    );
    expect(names(ctx)).toEqual(['Real']);
  });

  it('KEEPS below-fold content, which is the whole reason Y is not tested', () => {
    /*
     * Rects are `css-viewport`, so Y says only where the page is scrolled to.
     * Below-fold and scrolled-past controls are ordinary, reachable content and
     * excluding them would break every task that needs to scroll.
     */
    const ctx = contextFor(
      `<a href="/a" ${RECT_ATTR}="10,9000,80,40">Far below the fold</a>` +
        `<a href="/b" ${RECT_ATTR}="10,-4000,80,40">Scrolled past above</a>`,
    );
    expect(names(ctx)).toEqual(['Far below the fold', 'Scrolled past above']);
  });

  it('KEEPS a horizontally scrolled carousel slide', () => {
    // The competing risk, and the reason the threshold is 5,000 rather than 0:
    // a few slides into a carousel is genuinely reachable content at negative X.
    const ctx = contextFor(`<a href="/s" ${RECT_ATTR}="-2400,300,200,150">Slide 3</a>`);
    expect(names(ctx)).toEqual(['Slide 3']);
  });

  it('keeps everything when nothing was stamped', () => {
    /*
     * FAIL-OPEN. jsdom and the fixtures stamp nothing, and a page the content
     * script never measured yields no geometry evidence - which must mean "not
     * known", never "hidden". Otherwise a failed stamp would silently empty the
     * element list.
     */
    const ctx = contextFor('<a href="/a">One</a><a href="/b">Two</a>');
    expect(names(ctx)).toEqual(['One', 'Two']);
  });
});

describe('refs stay consistent when an element is dropped', () => {
  it('numbers the survivors without leaving a ref pointing elsewhere', () => {
    /*
     * THE HAZARD THIS CLASS OF CHANGE CARRIES. Refs are positional ordinals, and
     * `extractElements` and `extractRefPaths` walk separately - they agree only
     * because both go through `interestingElements`, which is where the filter
     * lives. A filter applied in one walk and not the other would have the model
     * name `e2` while the content script resolved `e2` to a different element:
     * validated, executed, reported ok, and wrong.
     */
    const ctx = contextFor(
      `<a href="/1" ${RECT_ATTR}="10,10,50,20">First</a>` +
        `<a href="/2" ${RECT_ATTR}="-9966,10,50,20">Parked</a>` +
        `<a href="/3" ${RECT_ATTR}="10,60,50,20">Third</a>`,
    );
    expect(names(ctx)).toEqual(['First', 'Third']);
    // Contiguous from e1, with no gap where the dropped element used to be.
    expect(ctx.elements.map((e) => String(e.ref))).toEqual(['e1', 'e2']);
  });

  it('the two extraction walks assign the SAME refs', () => {
    /*
     * The property that actually matters, asserted against both walks rather
     * than inferred from one. `extractElements` numbers what the model is shown;
     * `extractRefPaths` numbers what the content script resolves. They agree only
     * because both iterate `interestingElements`, which is where the visibility
     * filter lives - so this fails the moment a filter is added to one and not
     * the other.
     */
    ensureParser();
    const html =
      `<!doctype html><html><body>` +
      `<a href="/1" ${RECT_ATTR}="10,10,50,20">First</a>` +
      `<a href="/2" ${RECT_ATTR}="-9966,10,50,20">Parked</a>` +
      `<a href="/3" ${RECT_ATTR}="10,60,50,20">Third</a>` +
      `</body></html>`;
    const result = redact(markUntrusted(html), [], {
      viewport: DEFAULT_VIEWPORT,
      nonce: redactionNonce('offscreen'),
    });
    const paths = extractRefPaths(result.doc);
    const elements = extractElements(result.doc, result.detections, { nonce: 'offscreen' });

    expect([...paths.keys()]).toEqual(elements.map((e) => String(e.ref)));
    // And the parked link is in neither.
    expect(paths.size).toBe(2);
    for (const path of paths.values()) {
      const el = result.doc.querySelector(path);
      expect(el?.getAttribute('href')).not.toBe('/2');
    }
  });
});

describe('an off-screen element does not out-rank a visible one', () => {
  const viewport: ViewportInfo = DEFAULT_VIEWPORT;

  function el(name: string, x: number): SanitizedElement {
    return {
      ref: 'e1' as SanitizedElement['ref'],
      role: 'link',
      name: { text: name, redacted: false, truncated: false, kind: 'text' } as never,
      rect: { space: 'css-viewport', x, y: 20, width: 100, height: 30 },
      states: [],
      isSensitive: false,
    } as unknown as SanitizedElement;
  }

  it('scores a box entirely left of the viewport as OFF screen', () => {
    /*
     * `isOnScreen` tested both vertical edges and only the RIGHT horizontal one,
     * so `x < cssWidth` was trivially true for anything parked at negative X and
     * the element collected the on-screen rank BONUS. The asymmetry did not just
     * fail to demote a hidden control - it promoted it above real ones.
     */
    const goal = new Set(['cart']);
    const visible = rankElement(el('cart', 100), goal, viewport);
    const parked = rankElement(el('cart', -9966), goal, viewport);
    expect(parked).toBeLessThan(visible);
  });

  it('still counts a partially visible box as on screen', () => {
    // Straddling the left edge is visible, and the test is an INTERSECTION -
    // not "fully inside".
    const goal = new Set(['cart']);
    const straddling = rankElement(el('cart', -40), goal, viewport);
    const inside = rankElement(el('cart', 100), goal, viewport);
    expect(straddling).toBe(inside);
  });
});
