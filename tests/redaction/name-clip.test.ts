// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { accessibleName } from '@/redaction/index.ts';

/**
 * A long name keeps the end that tells it apart.
 *
 * On amazon.in three different laptops arrived with one name, because the text
 * fallback was `slice(0, 120)` and the variant - memory, storage, colour - sits
 * after character 120 of every title.
 */
describe('a long name keeps the end that tells it apart', () => {
  it('clips the middle, marks it, and keeps head and tail', () => {
    document.body.innerHTML =
      '<a href="/p1">2026 MacBook Pro Laptop with M5 Pro chip with 15-core CPU and 16-core GPU: ' +
      'Built for AI, 35.97 cm (14.2") Liquid Retina XDR Display, 24GB Unified Memory, 1TB SSD ' +
      'Storage; Space Black</a>';
    const link = document.querySelector('a');
    const name = link === null ? '' : (accessibleName(link) ?? '');
    expect(name.length).toBeLessThanOrEqual(125);
    expect(name).toContain('2026 MacBook Pro');
    expect(name).toContain('1TB SSD Storage; Space Black');
    expect(name).toContain(' … ');
  });

  it('leaves a name that fits exactly as it was', () => {
    document.body.innerHTML = '<button>Add to cart</button>';
    const button = document.querySelector('button');
    expect(button === null ? null : accessibleName(button)).toBe('Add to cart');
  });
});
