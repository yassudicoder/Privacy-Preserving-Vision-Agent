// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { accessibleName, stampGeometry, UNRENDERED_ATTR } from '@/redaction/index.ts';
import type { RectProvider } from '@/contracts/index.ts';

/**
 * A name is what a PERSON sees, not every string in the subtree.
 *
 * `accessibleName` fell back to `el.textContent` for links, buttons and
 * headings, which concatenates every descendant text node regardless of whether
 * any of it is rendered or exposed. Real sites are full of visually-hidden
 * helper text, so on amazon.in the cart link came out as
 * `"Cart, shift, alt, c"` - the accesskey announcement glued onto the real name.
 *
 * The cost was not cosmetic. The agent saw two differently-named candidates for
 * one control and stopped to ask the user which they meant:
 *
 *   needs an answer: Which one did you mean - Cart, shift, alt, c, or 1 item in cart?
 *
 * Neither choice was wrong and neither was useful.
 */

function el(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const first = host.firstElementChild;
  if (first === null) throw new Error('no element');
  return first;
}

describe('hidden text is excluded from an accessible name', () => {
  it('ignores an aria-hidden subtree', () => {
    const a = el('<a href="/cart">Cart<span aria-hidden="true">shift, alt, c</span></a>');
    expect(accessibleName(a)).toBe('Cart');
  });

  it('ignores a [hidden] subtree', () => {
    const a = el('<a href="/x">Buy<span hidden>press B</span></a>');
    expect(accessibleName(a)).toBe('Buy');
  });

  it('ignores an inline display:none and visibility:hidden', () => {
    expect(accessibleName(el('<a href="/x">Buy<i style="display:none">now!</i></a>'))).toBe('Buy');
    expect(
      accessibleName(el('<a href="/x">Buy<i style="visibility: hidden">now!</i></a>')),
    ).toBe('Buy');
    // A style attribute that merely MENTIONS display must not be over-matched.
    expect(accessibleName(el('<a href="/x">Buy<i style="display:inline">now</i></a>'))).toBe(
      'Buy now',
    );
  });

  it('ignores script and style text', () => {
    const a = el('<a href="/x">Buy<script>var x=1</script><style>.a{color:red}</style></a>');
    expect(accessibleName(a)).toBe('Buy');
  });

  it('collapses the whitespace between nodes', () => {
    // The joins between text nodes are arbitrary source formatting that no
    // reader ever saw. A stale-target check compares these across contexts, so
    // "Laptop Pro   Rs 49,999" and "Laptop Pro Rs 49,999" must not differ.
    const a = el('<a href="/x">\n  Laptop Pro\n  <span>  Rs 49,999 </span>\n</a>');
    expect(accessibleName(a)).toBe('Laptop Pro Rs 49,999');
  });

  it('still reads a plain nested name', () => {
    const a = el('<a href="/x"><span>Add</span> <b>to cart</b></a>');
    expect(accessibleName(a)).toBe('Add to cart');
  });
});

describe('the amazon.in cart link, which is what found this', () => {
  /*
   * The shape that produced the question. The accesskey announcement is hidden
   * by a CLASS - no attribute on the element says so - which is why the
   * attribute checks alone are not enough and `stampGeometry` has to mark it.
   */
  const CART =
    '<a href="/gp/cart" id="nav-cart">' +
    '<span id="nav-cart-count" aria-hidden="true">1</span>' +
    '<span class="nav-line-1">1 item in cart</span>' +
    '<span class="nav-line-2">Cart</span>' +
    '<span class="nav-accesskey">shift, alt, c</span>' +
    '</a>';

  it('WITHOUT layout information, the accesskey text is still included', () => {
    /*
     * Stated as the honest limit rather than hidden. A document parsed out of a
     * string has no cascade, so a class-based `display:none` is invisible to it.
     * The `aria-hidden` count span IS excluded, because that one is an attribute.
     */
    const a = el(CART);
    // Stated exactly rather than by substring: "1 item in cart" contains the
    // count's own digit, so a `not.toContain('1')` would be testing nothing.
    expect(accessibleName(a)).toBe('1 item in cart Cart shift, alt, c');
  });

  it('WITH layout stamped by the content script, the name is just what is shown', () => {
    /*
     * This is the real path: `stampGeometry` runs in the CONTENT SCRIPT against
     * the live DOM, where the browser has applied the stylesheet, and marks
     * every element it gave no box. `accessibleName` then skips their text.
     */
    const live = el(CART);
    document.body.append(live);
    const clone = live.cloneNode(true) as Element;

    // A real browser's answer for this markup: the count and the accesskey
    // announcement are not laid out, everything else is.
    const hidden = new Set(['nav-cart-count', 'nav-accesskey']);
    const readRect: RectProvider = (e) => {
      const marker = e.getAttribute('id') ?? e.getAttribute('class') ?? '';
      if (hidden.has(marker)) return null;
      return { x: 0, y: 0, width: 40, height: 20, space: 'css-viewport' };
    };

    stampGeometry(live, clone, readRect);
    expect(accessibleName(clone)).toBe('1 item in cart Cart');
  });

  it('a PAGE-authored unrendered marker is cleared, never trusted', () => {
    /*
     * Otherwise a page could mark its real name as not-rendered and leave a
     * different one behind - showing the model a name the user never sees, on an
     * element they think they recognise. Same rule `data-test-rect` already has,
     * and for a sharper reason.
     */
    const live = el(`<a href="/x"><span ${UNRENDERED_ATTR}="">Real name</span></a>`);
    document.body.append(live);
    const clone = live.cloneNode(true) as Element;
    const readRect: RectProvider = () => ({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      space: 'css-viewport',
    });

    stampGeometry(live, clone, readRect);
    // The forged attribute was removed and the element measured, so its text
    // counts exactly as any other element's would.
    expect(accessibleName(clone)).toBe('Real name');
  });
});

describe('an explicit label still wins, hidden or not', () => {
  it('aria-label beats everything in the subtree', () => {
    const a = el('<a href="/cart" aria-label="Cart, 1 item">Cart<span>shift, alt, c</span></a>');
    expect(accessibleName(a)).toBe('Cart, 1 item');
  });

  it('an aria-hidden aria-labelledby TARGET is still a valid label', () => {
    /*
     * The distinction that matters: `aria-hidden` excludes a node from being
     * read as part of an ancestor's name, but naming a target EXPLICITLY is the
     * standard way to supply a name without showing it twice. Excluding it would
     * discard the one thing the author said the name was.
     */
    document.body.innerHTML =
      '<span id="lbl" aria-hidden="true">Shopping cart</span>' +
      '<a href="/cart" aria-labelledby="lbl">Cart</a>';
    const a = document.querySelector('a');
    expect(a).not.toBeNull();
    expect(accessibleName(a as Element)).toBe('Shopping cart');
  });
});

describe('the walk survives a hostile document', () => {
  it('walks a deeply nested tree', () => {
    /*
     * Depth is attacker-controlled, and the walk is iterative so that a deep
     * document cannot overflow the stack and take the whole step with it.
     *
     * 1,000 rather than the depth that would actually break a recursive walk:
     * JSDOM ITSELF cannot hold a deeper tree - its `_descendantAdded` recurses
     * up the ancestor chain on every insertion and dies with
     * `Maximum call stack size exceeded` well before 20,000. So this asserts the
     * walk handles real nesting; the stack-safety property is a fact about the
     * implementation being a loop, which is visible in the source and is not
     * something this environment can demonstrate.
     */
    let html = 'deep';
    for (let i = 0; i < 1_000; i += 1) html = `<span>${html}</span>`;
    const a = el(`<a href="/x">${html}</a>`);
    expect(accessibleName(a)).toBe('deep');
  });

  it('bounds the text it accumulates', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `<span>chunk${String(i)}</span>`).join('');
    const a = el(`<a href="/x">${many}</a>`);
    const name = accessibleName(a);
    expect(name).not.toBeNull();
    // The caller slices to 120 anyway; the point is that nothing built a
    // megabyte string out of a page's worth of nodes first.
    expect((name as string).length).toBeLessThanOrEqual(120);
  });
});
