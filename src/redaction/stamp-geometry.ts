import type { RectProvider } from '@/contracts/index.ts';

/**
 * Copy live layout onto a detached clone, so redaction can see geometry.
 *
 * THE PROBLEM. Redaction runs on HTML parsed from a string - in Chrome's
 * offscreen document, in Firefox's event page - and a parsed document has NO
 * LAYOUT. `getBoundingClientRect()` there returns zeros, so the default
 * `attributeRectProvider` falls back to `data-test-rect`, an attribute only
 * FIXTURES carry. On a real page, every DOM detection came out with a null rect.
 *
 * That was invisible right up until a screenshot was sent, and then it was
 * serious: a detection with no rect produces no pixel op, so `bake` logged
 * `0 pixel op(s)` and the image reached the model with the card number still
 * legible - while the text beside it read `[[PII:CREDIT_CARD:1:...]]`.
 *
 * WHY A CLONE. Stamping `data-test-rect` into the live document would be an
 * unrequested side effect on the user's page: visible to the site, visible to
 * any MutationObserver it has installed, and persistent after the step. The
 * clone is serialised and thrown away.
 *
 * WHY INJECTED. `readRect` is a parameter so this is testable without a layout
 * engine - jsdom has none, which is the whole reason the gap existed. The same
 * move `scanDom`, `bench` and the worker runtime already make.
 */

/** The attribute both this and `attributeRectProvider` agree on. */
export const RECT_ATTR = 'data-test-rect';

/**
 * Marks an element the browser did not lay out.
 *
 * WHY IT HAS TO COME FROM HERE. `accessibleName` falls back to the element's
 * text when a link or button carries no `aria-label`, and a flat `textContent`
 * swallows every descendant - including the visually-hidden helper spans real
 * sites are full of. On amazon.in the cart link produced the name
 * `"Cart, shift, alt, c"`: the accesskey announcement, hidden from sighted users
 * by a CSS CLASS, concatenated onto the real name. The agent was then offered
 * two candidates for one control and asked the user which they meant.
 *
 * `aria-hidden` and `hidden` are attributes and can be checked anywhere. A class
 * that sets `display:none` cannot - it needs the cascade, and by the time
 * `accessibleName` runs the document has been parsed out of a string and has no
 * layout at all. THIS is the only point in the pipeline standing in front of a
 * real browser with a real stylesheet, and it is already walking every element
 * asking for its rect.
 *
 * So an element the browser gives no box is marked, and the name computation
 * skips its text. `display:none` and `visibility:hidden` both produce no usable
 * rect, and both propagate to descendants - so marking per element is enough and
 * is safer than pruning a subtree: a zero-height wrapper keeps whatever its
 * laid-out children say.
 *
 * ABSENT MEANS "NOT KNOWN", NEVER "VISIBLE". Nothing stamps in jsdom or in the
 * fixtures, so nothing is marked there and the name computation behaves exactly
 * as it did. This can only ever remove text a real browser confirmed was not
 * rendered.
 */
export const UNRENDERED_ATTR = 'data-sih-unrendered';

export interface StampResult {
  /** Elements walked in the source tree. */
  readonly visited: number;
  /** Elements that had usable geometry and were stamped. */
  readonly stamped: number;
}

/**
 * Walks `source` and `clone` in parallel, writing each element's rect onto the
 * clone. The two trees must be structurally identical - pass a clone of the
 * source, not an arbitrary document.
 *
 * Elements with no geometry are skipped rather than stamped with zeros: a zero
 * rect is not "at the origin", it is "not laid out", and `parseRectAttr` would
 * happily produce a 0x0 rect that covers nothing while looking like data.
 */
export function stampGeometry(
  source: Element,
  clone: Element,
  readRect: RectProvider,
): StampResult {
  const live = source.querySelectorAll('*');
  const copies = clone.querySelectorAll('*');

  /*
   * Deliberately paired by index rather than by selector.
   *
   * `cloneNode(true)` preserves document order exactly, so index i in one tree
   * is index i in the other. Matching by id or path would be slower and would
   * silently mis-pair on a page with duplicate ids - which is invalid HTML and
   * therefore exactly what a hostile page would serve.
   */
  const n = Math.min(live.length, copies.length);
  let stamped = 0;

  for (let i = 0; i < n; i += 1) {
    const from = live[i];
    const to = copies[i];
    if (from === undefined || to === undefined) continue;

    /*
     * REMOVED FIRST, ALWAYS. The attribute is page-authored until we overwrite
     * it.
     *
     * `cloneNode(true)` copies whatever the page wrote, and
     * `attributeRectProvider` reads `data-test-rect` back with no provenance
     * check - so a page that stamps its own could hand the redactor geometry of
     * its choosing. That matters because the screenshot guard keys on whether a
     * pixel op exists: one forged rect produces one op, and an aggregate guard
     * is disarmed by it.
     *
     * Clearing on every element makes the attribute mean exactly one thing:
     * "this is a rect WE measured". Page content is untrusted by this project's
     * own rule, and an attribute the page can write is page content.
     */
    to.removeAttribute(RECT_ATTR);
    /*
     * CLEARED FOR THE SAME REASON, and the reason is sharper for this one.
     *
     * A page that could author `data-sih-unrendered` could mark the real
     * accessible name as not-rendered and leave a different one behind - so the
     * model would be shown a name the user never sees, on an element they think
     * they recognise. Page content is untrusted by this project's own rule, and
     * an attribute the page can write is page content.
     */
    to.removeAttribute(UNRENDERED_ATTR);

    const r = readRect(from);
    if (r === null || r.width <= 0 || r.height <= 0) {
      // No box: the browser did not render it. Recorded as a fact we measured,
      // which is what lets `accessibleName` leave its text out.
      to.setAttribute(UNRENDERED_ATTR, '');
      continue;
    }

    to.setAttribute(
      RECT_ATTR,
      `${String(Math.round(r.x))},${String(Math.round(r.y))},` +
        `${String(Math.round(r.width))},${String(Math.round(r.height))}`,
    );
    stamped += 1;
  }

  return { visited: n, stamped };
}
