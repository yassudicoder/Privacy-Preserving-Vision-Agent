// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RECT_ATTR, redact, scanDom, stampGeometry } from '@/redaction/index.ts';
import { markUntrusted, rect, redactionNonce, type RectProvider } from '@/contracts/index.ts';

/**
 * The fix for the unredacted screenshot, tested without a layout engine.
 *
 * jsdom returns zeros from `getBoundingClientRect()` - which is precisely why
 * the bug survived to a real browser - so the rect reader is injected. These
 * tests drive the real function with a fake reader; the browser supplies
 * `liveRects` instead.
 */

const HTML =
  '<html><body>' +
  '<input id="card" name="cardNumber" value="4111 1111 1111 1111">' +
  '<input id="email" name="email" value="nobody@example.com">' +
  '<button id="pay">Pay now</button>' +
  '</body></html>';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Gives every element a distinct, plausible rect. */
function fakeLayout(): RectProvider {
  let i = 0;
  return () => {
    i += 1;
    return rect('css-viewport', 10, i * 40, 200, 30);
  };
}

describe('stampGeometry copies layout onto the clone', () => {
  it('writes a rect the redactor can read back', () => {
    const doc = parse(HTML);
    const root = doc.documentElement;
    const clone = root.cloneNode(true) as HTMLElement;

    const res = stampGeometry(root, clone, fakeLayout());

    expect(res.stamped).toBe(res.visited);
    expect(res.stamped).toBeGreaterThan(0);
    const card = clone.querySelector('#card');
    expect(card?.getAttribute(RECT_ATTR)).toMatch(/^\d+,\d+,200,30$/);
  });

  it('leaves the live document untouched', () => {
    /*
     * The whole reason it is a clone. Writing into the live DOM would be an
     * unrequested side effect on the user's page - visible to the site, visible
     * to any MutationObserver, and still there after the step.
     */
    const doc = parse(HTML);
    const root = doc.documentElement;
    const clone = root.cloneNode(true) as HTMLElement;

    stampGeometry(root, clone, fakeLayout());

    expect(root.querySelector(`[${RECT_ATTR}]`)).toBeNull();
    expect(root.outerHTML).not.toContain(RECT_ATTR);
  });

  it('skips elements with no layout rather than stamping zeros', () => {
    // A 0x0 rect is "not laid out", not "at the origin". Stamping it would
    // produce a rect that covers nothing while looking like real data.
    const doc = parse(HTML);
    const root = doc.documentElement;
    const clone = root.cloneNode(true) as HTMLElement;

    const res = stampGeometry(root, clone, () => null);

    expect(res.stamped).toBe(0);
    expect(clone.outerHTML).not.toContain(RECT_ATTR);
  });

  it('skips zero-area rects too', () => {
    const doc = parse(HTML);
    const root = doc.documentElement;
    const clone = root.cloneNode(true) as HTMLElement;

    const res = stampGeometry(root, clone, () => rect('css-viewport', 5, 5, 0, 0));

    expect(res.stamped).toBe(0);
  });

  it('pairs elements by document order, so the rect lands on the right node', () => {
    // Mis-pairing would be the worst outcome: every element carries geometry,
    // every detection produces a pixel op, and every op blacks out the wrong
    // region - a redaction that looks thorough and covers nothing.
    const doc = parse(HTML);
    const root = doc.documentElement;
    const clone = root.cloneNode(true) as HTMLElement;

    stampGeometry(root, clone, (el) => {
      const id = el.getAttribute('id');
      if (id === 'card') return rect('css-viewport', 1, 1, 11, 11);
      if (id === 'email') return rect('css-viewport', 2, 2, 22, 22);
      if (id === 'pay') return rect('css-viewport', 3, 3, 33, 33);
      return null;
    });

    expect(clone.querySelector('#card')?.getAttribute(RECT_ATTR)).toBe('1,1,11,11');
    expect(clone.querySelector('#email')?.getAttribute(RECT_ATTR)).toBe('2,2,22,22');
    expect(clone.querySelector('#pay')?.getAttribute(RECT_ATTR)).toBe('3,3,33,33');
  });
});

describe('the stamped clone is what makes pixel redaction possible', () => {
  /*
   * THE END-TO-END POINT. Everything above is mechanism; this is the reason.
   * Serialise the stamped clone, run the real redaction over it, and the pixel
   * ops that were missing on every real page appear.
   */
  function opsFor(html: string): number {
    return redact(markUntrusted(html), [], {
      nonce: redactionNonce('a1b2c3d4'),
      salt: 's',
      pixelCoverAll: true,
    }).pixelOps.length;
  }

  it('produces zero pixel ops without the stamp - the shipped bug', () => {
    expect(opsFor(HTML)).toBe(0);
  });

  it('produces pixel ops with it', () => {
    const doc = parse(HTML);
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    stampGeometry(doc.documentElement, clone, fakeLayout());

    const after = opsFor(clone.outerHTML);
    expect(after).toBeGreaterThan(0);
  });

  it('the detections themselves gain geometry', () => {
    const doc = parse(HTML);
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    stampGeometry(doc.documentElement, clone, fakeLayout());

    const before = scanDom(parse(HTML)).detections.filter((d) => d.rect !== null).length;
    const after = scanDom(parse(clone.outerHTML)).detections.filter((d) => d.rect !== null).length;

    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);
  });
});
