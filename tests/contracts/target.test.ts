import { describe, expect, it } from 'vitest';
import {
  elementRef,
  markUntrusted,
  rect,
  resolveTarget,
  toDataAtom,
  type HtmlAttrName,
  type SanitizedContainer,
  type SanitizedElement,
  type TargetSpec,
} from '@/contracts/index.ts';

/**
 * The model names an element by what it IS in the page HTML - tag, attributes,
 * visible text, and the section it sits in - and the client resolves that
 * against the elements it sent. Never by a ref, and never by picking one of
 * several matches on the model's behalf.
 */

const atom = (text: string) => toDataAtom(markUntrusted(text), { redacted: false });

function el(
  ref: string,
  tag: string,
  role: string,
  name: string,
  opts: { attrs?: Partial<Record<HtmlAttrName, string>>; container?: number; group?: string } = {},
): SanitizedElement {
  return {
    ref: elementRef(ref),
    role,
    name: name === '' ? null : atom(name),
    groupName: opts.group === undefined ? null : atom(opts.group),
    value: null,
    rect: rect('css-viewport', 0, 0, 10, 10),
    states: [],
    isSensitive: false,
    tag,
    attrs: Object.entries(opts.attrs ?? {}).map(([key, value]) => ({
      key: key as HtmlAttrName,
      value: atom(value ?? ''),
    })),
    container: opts.container ?? null,
  };
}

// <main> > [<form role=search>, <li> MacBook card, <li> Dell card]
const CONTAINERS: SanitizedContainer[] = [
  { tag: 'main', role: null, attrs: [], parent: null },
  { tag: 'form', role: 'search', attrs: [], parent: 0 },
  { tag: 'li', role: null, attrs: [], parent: 0 },
  { tag: 'li', role: null, attrs: [], parent: 0 },
];

const PAGE: SanitizedElement[] = [
  el('e1', 'input', 'textbox', 'Search Amazon.in', {
    attrs: { type: 'text', name: 'field-keywords', placeholder: 'Search Amazon.in' },
    container: 1,
  }),
  el('e2', 'input', 'button', 'Go', { attrs: { type: 'submit' }, container: 1 }),
  el('e3', 'h2', 'heading', 'Apple MacBook Pro M4 14-inch', { container: 2 }),
  el('e4', 'a', 'link', 'Apple MacBook Pro M4 14-inch', { attrs: { href: '/dp/MAC' }, container: 2 }),
  el('e5', 'a', 'link', '', { attrs: { href: '/dp/MAC' }, container: 2 }),
  el('e6', 'button', 'button', 'Add to cart', { container: 2 }),
  el('e7', 'h2', 'heading', 'Dell XPS 13', { container: 3 }),
  el('e8', 'button', 'button', 'Add to cart', { container: 3 }),
];

const resolve = (t: TargetSpec) => resolveTarget(t, PAGE, CONTAINERS);
const refOf = (t: TargetSpec): string | null => {
  const r = resolve(t);
  return r.ok ? String(r.ref) : null;
};

describe('the model names an element from the HTML, and the client resolves it', () => {
  it('by an attribute copied off the tag', () => {
    expect(refOf({ tag: 'input', name: 'field-keywords' })).toBe('e1');
    expect(refOf({ placeholder: 'Search Amazon.in' })).toBe('e1');
  });

  it('by visible text, which for <input type=submit> is its value', () => {
    expect(refOf({ tag: 'input', text: 'Go' })).toBe('e2');
  });

  it('REFUSES a repeated control named without its section, rather than picking one', () => {
    expect(resolve({ tag: 'button', text: 'Add to cart' })).toMatchObject({
      ok: false,
      reason: 'ambiguous',
      count: 2,
    });
  });

  it('says which KEYS tell the matches apart - never their values', () => {
    const r = resolve({ tag: 'button', text: 'Add to cart' });
    expect(r.ok === false && r.differ).toEqual(['within']);
    const dupes = [
      el('e1', 'input', 'searchbox', 'Search', { attrs: { id: 'searchInput', name: 'search' } }),
      el('e2', 'input', 'searchbox', 'Search', { attrs: { name: 'search' } }),
    ];
    const w = resolveTarget({ tag: 'input', name: 'search' }, dupes);
    expect(w.ok === false && w.differ).toEqual(['id']);
    expect(JSON.stringify(w)).not.toContain('searchInput');
  });

  it('names the key that emptied the pool when nothing matches', () => {
    // The model's habit: a name from its prior ("q") or from the prompt's example.
    const r = resolve({ tag: 'input', name: 'q' });
    expect(r).toMatchObject({ ok: false, reason: 'no-match', failedAt: 'name' });
    expect(resolve({ tag: 'textarea' })).toMatchObject({ failedAt: 'tag' });
  });

  it('tells repeated controls apart by the text of their OWN section', () => {
    expect(refOf({ tag: 'button', text: 'Add to cart', within: 'MacBook Pro' })).toBe('e6');
    expect(refOf({ tag: 'button', text: 'Add to cart', within: 'Dell XPS' })).toBe('e8');
  });

  it('does not let a shared ancestor answer `within` for every candidate', () => {
    // <main> holds both products. Tested against main, "Apple" would match both
    // buttons; tested against each button's own card, it matches one.
    expect(refOf({ tag: 'button', text: 'Add to cart', within: 'Apple' })).toBe('e6');
  });

  it('falls back to the section heading heuristic (groupName) on unmarked div soup', () => {
    const soup = [
      el('e1', 'button', 'button', 'Add to cart', { group: 'Laptop Pro' }),
      el('e2', 'button', 'button', 'Add to cart', { group: 'Gaming Laptop' }),
    ];
    const r = resolveTarget({ text: 'Add to cart', within: 'gaming' }, soup, []);
    expect(r.ok && String(r.ref)).toBe('e2');
  });

  it('says no-match when nothing sent fits', () => {
    expect(resolve({ tag: 'button', text: 'Buy now' })).toMatchObject({ ok: false, reason: 'no-match', count: 0 });
  });

  it('accepts several links to ONE destination - that is one action, not a guess', () => {
    // A product's image and its title are two links to the same URL.
    expect(refOf({ tag: 'a', href: '/dp/MAC' })).toBe('e4');
  });

  it('prefers exact text, and only falls back to "contains" when nothing is exact', () => {
    expect(refOf({ tag: 'a', text: 'MacBook Pro' })).toBe('e4');
    // The model copies a name the prompt clipped with an ellipsis.
    expect(refOf({ tag: 'a', text: 'Apple MacBook Pro M4…' })).toBe('e4');
  });

  it('matches a redaction token in its short rendered form, and unescapes what the renderer escaped', () => {
    const page = [
      el('e1', 'button', 'button', 'Email [[PII:EMAIL:1:ab12cd34]] again'),
      el('e2', 'button', 'button', 'Say "hi"'),
    ];
    expect(resolveTarget({ text: 'Email [[PII:EMAIL]] again' }, page).ok).toBe(true);
    const quoted = resolveTarget({ text: 'Say &quot;hi&quot;' }, page);
    expect(quoted.ok && String(quoted.ref)).toBe('e2');
  });

  it('only ever resolves among the elements it was given', () => {
    const r = resolveTarget({ tag: 'input', name: 'field-keywords' }, PAGE.slice(1), CONTAINERS);
    expect(r.ok).toBe(false);
  });
});
