import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Untrusted, markUntrusted, unsafeUnwrap } from '@/contracts/index.ts';
import { canonicalPath } from '@/redaction/index.ts';
import type { Fixture, GroundTruth, ResolvedGroundTruthItem } from './types.ts';

/**
 * Fixture loading. Node-only: this reaches the filesystem, so nothing in the
 * extension bundle may import it. The architecture test enforces that.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function allFixtureIds(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.replace(/\.html$/, ''))
    .sort();
}

export function loadFixture(id: string): Fixture {
  const html = readFileSync(join(FIXTURE_DIR, `${id}.html`), 'utf8');
  const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.truth.json`), 'utf8')) as GroundTruth;
  const visionBoxes = JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${id}.vision.json`), 'utf8'),
  ) as Fixture['visionBoxes'];

  if (truth.id !== id) {
    throw new Error(`fixture ${id}: truth.json declares id "${truth.id}"`);
  }
  return { id, html: markUntrusted(html), truth, visionBoxes };
}

export function loadAllFixtures(): Fixture[] {
  return allFixtureIds().map(loadFixture);
}

/** Parse a fixture. Requires a DOM, so jsdom-environment tests only. */
export function parseFixture(fixture: Fixture): Document {
  return new DOMParser().parseFromString(
    unsafeUnwrap(fixture.html, 'test-fixture'),
    'text/html',
  );
}

/**
 * Resolve every truth locator to a canonical DOM path.
 *
 * Done once at load rather than inside the scorer so a typo in a selector fails
 * loudly here instead of silently deflating recall later.
 */
export function resolveTruth(doc: Document, truth: GroundTruth): ResolvedGroundTruthItem[] {
  return truth.sensitive.map((item) => {
    const el = doc.querySelector(item.locator.selector);
    if (el === null) {
      throw new Error(
        `fixture ${truth.id}: truth item "${item.id}" selector "${item.locator.selector}" matches nothing`,
      );
    }
    return { ...item, domPath: canonicalPath(el) };
  });
}

/** Canonical paths of everything the fixture declares benign. */
export function resolveBenign(doc: Document, truth: GroundTruth): string[] {
  return truth.benign.flatMap((b) => {
    const el = doc.querySelector(b.selector);
    if (el === null) {
      throw new Error(
        `fixture ${truth.id}: benign selector "${b.selector}" matches nothing`,
      );
    }
    return [String(canonicalPath(el))];
  });
}

/** Every literal that must not survive into anything we transmit. */
export function truthLiterals(truth: GroundTruth): { id: string; literal: string }[] {
  const out: { id: string; literal: string }[] = [];
  for (const item of truth.sensitive) {
    if (item.mustRedact && item.literal !== undefined) {
      out.push({ id: item.id, literal: item.literal });
    }
  }
  return out;
}

export function fixtureHtml(fixture: Fixture): Untrusted<string> {
  return fixture.html;
}
