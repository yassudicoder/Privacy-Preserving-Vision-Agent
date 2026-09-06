// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ALL_PII_KINDS, unsafeUnwrap } from '@/contracts/index.ts';
import {
  allFixtureIds,
  loadFixture,
  parseFixture,
  resolveBenign,
  resolveTruth,
} from '@/harness/index.ts';

/**
 * Fixture integrity.
 *
 * A broken fixture makes every score downstream meaningless while still
 * reporting a number, which is worse than failing. These run first.
 */

describe('fixture set', () => {
  it('has fixtures', () => {
    expect(allFixtureIds().length).toBeGreaterThanOrEqual(5);
  });

  it('includes a zero-PII control', () => {
    // Without one, precision is never actually tested.
    expect(allFixtureIds()).toContain('benign-docs');
    expect(loadFixture('benign-docs').truth.sensitive).toEqual([]);
  });

  it('includes a hostile fixture', () => {
    expect(allFixtureIds()).toContain('injection');
  });
});

describe.each(allFixtureIds())('fixture %s', (id) => {
  const fixture = loadFixture(id);

  it('declares the schema version and matching id', () => {
    expect(fixture.truth.schemaVersion).toBe(1);
    expect(fixture.truth.id).toBe(id);
    expect(fixture.truth.description.length).toBeGreaterThan(20);
  });

  it('declares a viewport', () => {
    const vp = fixture.truth.viewport;
    expect(vp.cssWidth).toBeGreaterThan(0);
    expect(vp.cssHeight).toBeGreaterThan(0);
    expect(vp.devicePixelRatio).toBeGreaterThan(0);
  });

  it('uses only known PII kinds', () => {
    for (const item of fixture.truth.sensitive) {
      expect(ALL_PII_KINDS, `${item.id} has unknown kind ${item.kind}`).toContain(item.kind);
    }
    for (const box of fixture.visionBoxes) {
      expect(ALL_PII_KINDS).toContain(box.kind);
    }
  });

  it('resolves every truth selector against the document', () => {
    const doc = parseFixture(fixture);
    expect(() => resolveTruth(doc, fixture.truth)).not.toThrow();
  });

  it('resolves every benign selector against the document', () => {
    const doc = parseFixture(fixture);
    expect(() => resolveBenign(doc, fixture.truth)).not.toThrow();
  });

  it('resolves every expectedElement selector against the document', () => {
    const doc = parseFixture(fixture);
    for (const e of fixture.truth.expectedElements) {
      expect(doc.querySelector(e.selector), `${e.id}: "${e.selector}" matches nothing`).not.toBeNull();
    }
  });

  it('gives every out-of-scope truth item a written justification', () => {
    // mustRedact:false excludes an item from recall. That has to be argued for,
    // not just asserted, or it becomes a way to make numbers look better.
    for (const item of fixture.truth.sensitive) {
      if (!item.mustRedact) {
        expect(item.note, `${item.id} is out of scope without a note`).toBeTruthy();
        expect((item.note ?? '').length).toBeGreaterThan(30);
      }
    }
  });

  it('actually contains every literal it claims', () => {
    const html = unsafeUnwrap(fixture.html, 'test-fixture');
    for (const item of fixture.truth.sensitive) {
      if (item.literal === undefined) continue;
      expect(html, `${item.id}: literal not present in the fixture`).toContain(item.literal);
    }
  });

  it('carries a test rect on every element it expects to be located', () => {
    const doc = parseFixture(fixture);
    for (const e of fixture.truth.expectedElements) {
      if (e.rect === undefined) continue;
      const el = doc.querySelector(e.selector);
      expect(el?.getAttribute('data-test-rect'), `${e.id} has no data-test-rect`).toBeTruthy();
    }
  });

  it('agrees with the data-test-rect it declares', () => {
    // jsdom has no layout, so a drifting rect would silently break geometry
    // scoring in a way nothing else would catch.
    const doc = parseFixture(fixture);
    for (const e of fixture.truth.expectedElements) {
      if (e.rect === undefined) continue;
      const attr = doc.querySelector(e.selector)?.getAttribute('data-test-rect') ?? '';
      const [x, y, w, h] = attr.split(',').map(Number);
      expect([x, y, w, h], `${e.id} rect mismatch`).toEqual([
        e.rect.x,
        e.rect.y,
        e.rect.width,
        e.rect.height,
      ]);
    }
  });

  it('has vision boxes in CSS viewport space', () => {
    for (const box of fixture.visionBoxes) {
      expect(box.rect.space).toBe('css-viewport');
      expect(box.confidence).toBeGreaterThan(0);
      expect(box.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('is inert and offline', () => {
    // Fixtures must not execute or fetch anything, or the tests measure the
    // network. Note this checks src/href attributes specifically: the injection
    // fixture deliberately contains an off-site URL in its PROSE, which is the
    // payload under test and must stay there.
    const html = unsafeUnwrap(fixture.html, 'test-fixture');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    const remoteRefs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => m[1] ?? '')
      .filter((url) => /^(?:https?:)?\/\//i.test(url));
    expect(remoteRefs).toEqual([]);
  });
});
