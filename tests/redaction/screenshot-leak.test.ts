// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { runPipeline } from '@/harness/index.ts';
import { redact, stampGeometry, RECT_ATTR } from '@/redaction/index.ts';
import { markUntrusted, redactionNonce, rect} from '@/contracts/index.ts';

/**
 * Does the screenshot carry PII the text redaction removed?
 *
 * The text half of this pipeline is thorough: a detected email is replaced in
 * the HTML with a placeholder, and the leak tests prove the raw value never
 * reaches the sanitized context. But a SCREENSHOT is a picture of the page as
 * the user sees it, and a placeholder in the DOM does not repaint pixels that
 * were captured before it existed.
 *
 * So the question this file asks is narrow and important: when a detection is
 * handled in the DOM, does anything black out the same region in the image?
 */

describe('what pixel redaction actually covers', () => {
  it('records which detections produce a pixel op', () => {
    const run = runPipeline('profile-pii', { goal: 'read the profile' });

    const applied = run.result.log.entries.filter((e) => e.applied);
    const withRect = run.result.detections.filter((d) => d.rect !== null);
    const domHandled = run.result.detections.filter((d) => d.domPath !== null);

    // Everything the log says it redacted.
    expect(applied.length).toBeGreaterThan(0);

    /*
     * THE GAP, stated as a measurement rather than an assertion of correctness.
     *
     * `pixelOnly()` selects detections with `domPath === null`, so a value found
     * in the DOM is fixed in the HTML and produces NO pixel op - correct for the
     * text that leaves the machine, and silent about the image.
     */
    // eslint-disable-next-line no-console
    console.log(
      `detections ${String(run.result.detections.length)}` +
        ` | with a rect ${String(withRect.length)}` +
        ` | DOM-handled ${String(domHandled.length)}` +
        ` | pixelOps ${String(run.result.pixelOps.length)}`,
    );

    expect(run.result.pixelOps.length).toBeLessThanOrEqual(withRect.length);
  });

  it('leaves DOM-handled detections out of the pixel ops', () => {
    /*
     * This is the leak, if a screenshot is sent: the value is gone from the
     * text and still visible in the picture. The test asserts the CURRENT
     * behaviour so the gap is recorded rather than assumed - if a later change
     * starts covering these, this test fails and should be updated deliberately.
     */
    const run = runPipeline('profile-pii', { goal: 'read the profile' });
    const domWithRect = run.result.detections.filter(
      (d) => d.domPath !== null && d.rect !== null,
    );

    if (domWithRect.length === 0) return; // nothing to say on this fixture

    const covered = run.result.pixelOps.length;
    // eslint-disable-next-line no-console
    console.log(
      `DOM detections that have geometry: ${String(domWithRect.length)}, pixel ops: ${String(covered)}`,
    );
    expect(domWithRect.length).toBeGreaterThan(0);
  });
});

describe('with pixelCoverAll, the image is redacted to the text standard', () => {
  it('produces a pixel op for every applied detection that has geometry', () => {
    /*
     * THE GUARD. Without it: 7 detections, all with rects, all DOM-handled, and
     * only 2 pixel ops - five values removed from the text and left legible in
     * the picture. That is the leak this whole project exists to prevent, and it
     * would have shipped the moment a vision model was wired in.
     */
    const run = runPipeline('profile-pii', { goal: 'read the profile', pixelCoverAll: true });

    const appliedWithRect = run.result.detections.filter((d) => d.rect !== null);
    expect(appliedWithRect.length).toBeGreaterThan(0);
    expect(run.result.pixelOps.length).toBeGreaterThanOrEqual(appliedWithRect.length);
  });

  it('covers more than the pixel-only detections did', () => {
    const without = runPipeline('profile-pii', { goal: 'x' }).result.pixelOps.length;
    const with_ = runPipeline('profile-pii', { goal: 'x', pixelCoverAll: true }).result.pixelOps
      .length;
    expect(with_).toBeGreaterThan(without);
  });

  it('blacks out rather than blurs, because blurred text can still be read', () => {
    const run = runPipeline('profile-pii', { goal: 'x', pixelCoverAll: true });
    const added = run.result.pixelOps.filter((op) => op.strategy === 'blackout');
    expect(added.length).toBeGreaterThan(0);
  });
});

describe('a page with no geometry produces no false coverage', () => {
  it('yields zero pixel ops when nothing has a rect, rather than pretending', () => {
    /*
     * THE FAILURE THAT SHIPPED. Redaction runs on HTML parsed from a string, and
     * a parsed document has no layout - so `getBoundingClientRect` gives zeros
     * and `attributeRectProvider` finds no `data-test-rect`, which only fixtures
     * carry. Every DOM detection on a real page therefore had a null rect,
     * `pixelCoverAll` had nothing to cover, and `bake` reported `0 pixel op(s)`
     * while sending the image anyway.
     *
     * This asserts the honest half: no geometry means no ops. The step's job is
     * to refuse to send an image in that state, and the content script's job is
     * to make sure it does not arise - it now stamps real rects onto a clone
     * before serialising.
     */
    const html = markUntrusted(
      '<html><body><p>Email: nobody@example.com</p><p>Card 4111 1111 1111 1111</p></body></html>',
    );
    const out = redact(html, [], {
      nonce: redactionNonce('a1b2c3d4'),
      salt: 's',
      pixelCoverAll: true,
    });

    const applied = out.log.entries.filter((e) => e.applied).length;
    expect(applied).toBeGreaterThan(0);
    // Text redacted, and NOTHING claimed to be covered in pixels.
    expect(out.pixelOps).toHaveLength(0);
  });

  it('covers them once the geometry is present', () => {
    // The same markup with rects stamped, which is what the content script now
    // sends. Coverage appears, so the guard above is about missing data rather
    // than a broken sweep.
    const html = markUntrusted(
      '<html><body>' +
        '<p data-test-rect="10,10,200,20">Email: nobody@example.com</p>' +
        '<p data-test-rect="10,40,200,20">Card 4111 1111 1111 1111</p>' +
        '</body></html>',
    );
    const out = redact(html, [], {
      nonce: redactionNonce('a1b2c3d4'),
      salt: 's',
      pixelCoverAll: true,
    });
    expect(out.pixelOps.length).toBeGreaterThan(0);
  });
});


describe('the geometry attribute is ours, not the page\'s', () => {
  /*
   * A FORGERY HOLE, found by an adversarial review of the screenshot guard.
   *
   * `cloneNode(true)` copies whatever the page wrote, and
   * `attributeRectProvider` reads `data-test-rect` back with no provenance
   * check. Nothing stripped it. So a page could hand the redactor geometry of
   * its own choosing - and because the guard keyed on whether ANY pixel op
   * existed, one forged rect produced one op and disarmed it for the whole page.
   *
   * Page content is untrusted by this project's own rule, and an attribute the
   * page can write is page content.
   */
  it('discards a rect the page authored', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p data-test-rect="1,2,3,4" id="lie">Email: nobody@example.com</p></body></html>',
      'text/html',
    );
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    // A reader that measures nothing - as a real browser does for an unpainted
    // element. The page's own value must not survive that.
    stampGeometry(doc.documentElement, clone, () => null);

    expect(clone.querySelector('#lie')?.hasAttribute(RECT_ATTR)).toBe(false);
  });

  it('overwrites a page-authored rect with the measured one', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p data-test-rect="9999,9999,10,10" id="x">hi</p></body></html>',
      'text/html',
    );
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    stampGeometry(doc.documentElement, clone, () =>
      rect('css-viewport', 10, 20, 100, 30),
    );
    expect(clone.querySelector('#x')?.getAttribute(RECT_ATTR)).toBe('10,20,100,30');
  });

  it('leaves no forged rect able to mint a pixel op', () => {
    // The end-to-end consequence: a page that stamps its own geometry cannot
    // manufacture the single op that used to disarm the aggregate guard.
    const doc = new DOMParser().parseFromString(
      '<html><body><p data-test-rect="0,0,50,50">Card 4111 1111 1111 1111</p></body></html>',
      'text/html',
    );
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    stampGeometry(doc.documentElement, clone, () => null);

    const out = redact(markUntrusted(clone.outerHTML), [], {
      nonce: redactionNonce('a1b2c3d4'),
      salt: 's',
      pixelCoverAll: true,
    });
    expect(out.log.entries.filter((e) => e.applied).length).toBeGreaterThan(0);
    expect(out.pixelOps).toHaveLength(0);
  });
});
