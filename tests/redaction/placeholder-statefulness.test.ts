import { describe, expect, it } from 'vitest';
import { hasAnyPlaceholder, ANY_PLACEHOLDER_RE } from '@/contracts/index.ts';

/**
 * Two defects an adversarial audit found in this change, pinned so they cannot
 * come back quietly. Both had the same shape: code that looks obviously correct
 * and is wrong in a way no existing test could see.
 */

describe('hasAnyPlaceholder is stateless, and the shared regex is not', () => {
  const REDACTED = 'Email [[PII:EMAIL:1:a1b2c3d4]]';

  it('answers the same for the same input, every time', () => {
    /*
     * THE BUG: `sanitize.ts` called `ANY_PLACEHOLDER_RE.test()` three times per
     * element - name, group name, value - on a module-level regex carrying `/g`.
     * `.test()` on a global regex resumes from `lastIndex`, so the answers
     * alternated true/false/true regardless of the input. `DataAtom.redacted` is
     * what tells the server which fields were protected, so roughly half of them
     * were wrong on every page.
     *
     * Three identical calls is the smallest reproduction, and it is exactly what
     * one element does.
     */
    expect(hasAnyPlaceholder(REDACTED)).toBe(true);
    expect(hasAnyPlaceholder(REDACTED)).toBe(true);
    expect(hasAnyPlaceholder(REDACTED)).toBe(true);
  });

  it('is false for text with no placeholder, even after a true', () => {
    expect(hasAnyPlaceholder(REDACTED)).toBe(true);
    expect(hasAnyPlaceholder('nothing here')).toBe(false);
    expect(hasAnyPlaceholder(REDACTED)).toBe(true);
  });

  it('demonstrates why the shared /g regex could not be used', () => {
    /*
     * Kept as a live demonstration rather than a comment, so the reason this
     * helper exists is visible to whoever next reaches for the shared constant.
     * If a future change drops `/g` this fails, and dropping `/g` would silently
     * break `stripForgedPlaceholders`, which relies on it to replace ALL matches.
     */
    ANY_PLACEHOLDER_RE.lastIndex = 0;
    const first = ANY_PLACEHOLDER_RE.test(REDACTED);
    const second = ANY_PLACEHOLDER_RE.test(REDACTED);
    ANY_PLACEHOLDER_RE.lastIndex = 0;

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(ANY_PLACEHOLDER_RE.flags).toContain('g');
  });

  it('still replaces every occurrence through the shared regex', () => {
    // `.replace()` and `.match()` ignore and reset lastIndex, so they were never
    // affected and must keep working.
    const two = '[[PII:EMAIL:1:aaaa]] and [[PII:PHONE:2:bbbb]]';
    expect(two.replace(ANY_PLACEHOLDER_RE, 'X')).toBe('X and X');
    expect(two.match(ANY_PLACEHOLDER_RE)).toHaveLength(2);
  });
});
