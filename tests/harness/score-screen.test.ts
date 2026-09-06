// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type SanitizedElement, elementRef, markUntrusted, rect, toDataAtom } from '@/contracts/index.ts';
import type { ExpectedElement } from '@/harness/index.ts';
import { allFixtureIds, nameSimilarity, runPipeline, scoreScreenContext } from '@/harness/index.ts';

function el(over: Partial<SanitizedElement> = {}): SanitizedElement {
  return {
    ref: elementRef('e1'),
    role: 'button',
    name: toDataAtom(markUntrusted('Sign in'), { redacted: false }),
    value: null,
    rect: rect('css-viewport', 10, 20, 100, 40),
    states: [],
    isSensitive: false,
    ...over,
  };
}

function expected(over: Partial<ExpectedElement> = {}): ExpectedElement {
  return {
    id: 'x1',
    role: 'button',
    name: 'Sign in',
    selector: 'button',
    sensitive: false,
    rect: { x: 10, y: 20, width: 100, height: 40 },
    ...over,
  };
}

describe('nameSimilarity', () => {
  it('is 1 for identical names after normalisation', () => {
    expect(nameSimilarity('Sign In', '  sign   in ')).toBe(1);
  });

  it('is 1 when both are absent', () => {
    expect(nameSimilarity(null, null)).toBe(1);
  });

  it('is 0 when only one is absent', () => {
    expect(nameSimilarity('Sign in', null)).toBe(0);
  });

  it('falls back to token overlap for partial matches', () => {
    const s = nameSimilarity('Delivery address', 'address');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe('scoreScreenContext', () => {
  it('scores a perfect reading as 1', () => {
    const s = scoreScreenContext([el()], [expected()]);
    expect(s.elementF1).toBe(1);
    expect(s.roleAccuracy).toBe(1);
    expect(s.nameAccuracy).toBe(1);
    expect(s.geometryIou).toBe(1);
    expect(s.sensitivityAccuracy).toBe(1);
    expect(s.score).toBeCloseTo(1, 5);
  });

  it('counts a missing element', () => {
    const s = scoreScreenContext([], [expected()]);
    expect(s.elementRecall).toBe(0);
    expect(s.missing).toEqual(['x1']);
    expect(s.score).toBe(0);
  });

  it('counts a spurious element', () => {
    const s = scoreScreenContext([el()], []);
    expect(s.elementPrecision).toBe(0);
    expect(s.spurious).toEqual(['e1']);
  });

  it('still pairs an element with the wrong role, then penalises the role', () => {
    // Reporting it as both a miss and a spurious element would double-count one
    // mistake and make role errors look worse than dropped elements.
    const s = scoreScreenContext([el({ role: 'link' })], [expected({ role: 'button' })]);
    expect(s.elementF1).toBe(1);
    expect(s.roleAccuracy).toBe(0);
    expect(s.score).toBeLessThan(1);
  });

  it('penalises a wrong accessible name', () => {
    const s = scoreScreenContext(
      [el({ name: toDataAtom(markUntrusted('Completely different'), { redacted: false }) })],
      [expected()],
    );
    expect(s.nameAccuracy).toBe(0);
  });

  it('penalises wrong geometry', () => {
    const s = scoreScreenContext(
      [el({ rect: rect('css-viewport', 500, 600, 100, 40) })],
      [expected()],
    );
    expect(s.geometryIou).toBe(0);
  });

  it('penalises a wrong sensitivity flag', () => {
    // Getting this wrong is how the agent ends up typing into a password field.
    const s = scoreScreenContext([el({ isSensitive: true })], [expected({ sensitive: false })]);
    expect(s.sensitivityAccuracy).toBe(0);
  });

  it('is one-to-one across many similar elements', () => {
    const found = [
      el({ ref: elementRef('e1') }),
      el({ ref: elementRef('e2') }),
      el({ ref: elementRef('e3') }),
    ];
    const s = scoreScreenContext(found, [expected()]);
    expect(s.matched).toHaveLength(1);
    expect(s.spurious).toHaveLength(2);
  });

  it('scores state extraction', () => {
    const s = scoreScreenContext(
      [el({ states: ['required'] })],
      [expected({ states: ['required'] })],
    );
    expect(s.stateAccuracy).toBe(1);
  });

  it('treats an empty page as perfect only when nothing was expected', () => {
    expect(scoreScreenContext([], []).score).toBeGreaterThan(0);
    expect(scoreScreenContext([], []).elementF1).toBe(1);
  });
});

describe('scoreScreenContext against the real pipeline', () => {
  for (const id of allFixtureIds()) {
    it(`extracts every expected element from ${id}`, () => {
      const run = runPipeline(id);
      const s = scoreScreenContext(run.context.elements, run.fixture.truth.expectedElements);
      expect(s.missing, `missing in ${id}`).toEqual([]);
      expect(s.spurious, `spurious in ${id}`).toEqual([]);
    });

    it(`reads roles, names and geometry correctly in ${id}`, () => {
      const run = runPipeline(id);
      const s = scoreScreenContext(run.context.elements, run.fixture.truth.expectedElements);
      expect(s.roleAccuracy).toBe(1);
      expect(s.nameAccuracy).toBe(1);
      expect(s.geometryIou).toBeGreaterThan(0.99);
      expect(s.sensitivityAccuracy).toBe(1);
    });
  }

  it('never sends a hidden input to the server', () => {
    // login-form carries a hidden CSRF token. It must not appear at all.
    const run = runPipeline('login-form');
    expect(JSON.stringify(run.context)).not.toContain('tok_9f2a1b7c3d4e');
  });
});
