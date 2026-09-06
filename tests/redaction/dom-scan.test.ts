// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scanDom } from '@/redaction/index.ts';

/**
 * The DOM scan, which carries metrics 2 and 3 on its own today.
 *
 * The vision channel returned zero boxes on every real page measured, so every
 * detection in those runs came from here. That makes the image-attribute rules
 * the only thing standing between a photographed card or ID and the server.
 */

// ---------------------------------------------------------------------------
// a card that exists only as a picture
// ---------------------------------------------------------------------------

describe('an image of a payment card', () => {
  /*
   * THE GAP THIS CLOSES. The text rules have always had a `credit-card` entry,
   * so a card NUMBER in the DOM is caught. The IMAGE rules had id-document,
   * signature and face - and no card. So `<img alt="photo of my debit card">`
   * produced a detection from neither channel, and no model could rescue it:
   * COCO has no credit card, and a face detector finds faces.
   *
   * Zero bytes, zero milliseconds, and it reaches a PII kind that was otherwise
   * unreachable on this build.
   */
  function scanImg(attrs: string): ReturnType<typeof scanDom>['detections'] {
    const doc = new DOMParser().parseFromString(
      `<html><body><img ${attrs} data-test-rect="10,10,200,120"></body></html>`,
      'text/html',
    );
    return scanDom(doc).detections;
  }

  it('detects a debit card photo by its alt text', () => {
    const found = scanImg('src="a.jpg" alt="photo of my debit card"');
    expect(found.some((d) => d.kind === 'credit-card')).toBe(true);
  });

  it('detects credit card, bank card and card front', () => {
    for (const alt of ['My credit card', 'bank card', 'card front', 'card_back', 'Mastercard']) {
      const found = scanImg(`src="a.jpg" alt="${alt}"`);
      expect(found.some((d) => d.kind === 'credit-card')).toBe(true);
    }
  });

  it('carries geometry, so it can be covered in pixels too', () => {
    const found = scanImg('src="a.jpg" alt="debit card"').filter((d) => d.kind === 'credit-card');
    expect(found[0]?.rect).not.toBeNull();
  });

  it('does NOT fire on cards that are not payment cards', () => {
    /*
     * The precision half, which is 20% of the score. `\bcard\b` on its own would
     * have taken every one of these.
     */
    for (const alt of [
      'business card',
      'gift card',
      'loyalty card',
      'card sorting exercise',
      'birthday card',
      'visa application form',
      'student visa',
    ]) {
      const found = scanImg(`src="a.jpg" alt="${alt}"`);
      expect(found.some((d) => d.kind === 'credit-card')).toBe(false);
    }
  });
});
