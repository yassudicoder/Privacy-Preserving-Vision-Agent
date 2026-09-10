import type { ElementRef, SanitizedContainer, SanitizedElement } from './context.ts';

/**
 * How the model names an element: by what the element IS in the page HTML it
 * was shown, never by a number we assigned.
 *
 * WHY NOT REFS. The model used to pick `e15` out of a flat row list. That made
 * the model's job "find the row" rather than "understand the page", and every
 * row carried a label that exists nowhere on the page. Now the model reads a
 * sanitized HTML outline and describes the element it wants the way a person
 * would point at it in DevTools - its tag, its attributes, its visible text,
 * and, for a control that repeats, the section it sits in:
 *
 *   {"tag":"input","name":"field-keywords"}
 *   {"tag":"button","text":"Add to cart","within":"Apple MacBook Pro"}
 *
 * THE BACKSTOP IS UNCHANGED, AND THIS IS WHERE IT NOW LIVES. `resolveTarget`
 * only ever searches the elements we SENT. A target that matches nothing is
 * refused; so is one that matches more than one - the client never picks among
 * candidates on the model's behalf. A compromised server can still only reach
 * an element the client chose to expose. The internal ref survives purely as
 * the handle execution uses to find the element in the live page.
 */
export interface TargetSpec {
  readonly tag?: string;
  readonly role?: string;
  readonly id?: string;
  /** The HTML `name` ATTRIBUTE, as in `<input name="q">` - not the visible text. */
  readonly name?: string;
  readonly type?: string;
  readonly placeholder?: string;
  readonly href?: string;
  /** `aria-label`, or the `label` a field is rendered with. */
  readonly label?: string;
  /** The element's visible text (its accessible name). */
  readonly text?: string;
  /** Text inside the section the element sits in - how repeated controls are told apart. */
  readonly within?: string;
}

export const TARGET_KEYS = [
  'tag',
  'role',
  'id',
  'name',
  'type',
  'placeholder',
  'href',
  'label',
  'text',
  'within',
] as const;

export type TargetKey = (typeof TARGET_KEYS)[number];

/**
 * A failure carries KEYS, never values - it becomes a CORRECTION, which sits
 * after the fence where the model reads it as ours, and attribute names are a
 * closed vocabulary while their values are page text.
 *
 *   differ    ambiguous: the keys whose values differ between the matches -
 *             "they differ in: id" is what the model needs to add.
 *   failedAt  no-match: the first key after which nothing was left -
 *             "none has that name" says which part of the target was wrong.
 */
export type TargetResolution =
  | { readonly ok: true; readonly ref: ElementRef }
  | {
      readonly ok: false;
      readonly reason: 'no-match' | 'ambiguous';
      readonly count: number;
      readonly differ?: readonly TargetKey[];
      readonly failedAt?: TargetKey;
    };

/** Keys that can tell two matches apart, in the order worth suggesting them. */
const DIFFERENTIATORS: readonly TargetKey[] = [
  'id', 'name', 'href', 'within', 'text', 'label', 'placeholder', 'type', 'tag',
];

function valueFor(el: SanitizedElement, key: TargetKey): string {
  switch (key) {
    case 'tag':
      return tagOf(el);
    case 'role':
      return el.role;
    case 'text':
      return normTarget(el.name?.text ?? '');
    case 'within':
      return normTarget(el.groupName?.text ?? '');
    case 'label':
      return normTarget(attrOf(el, 'aria-label') ?? '');
    default:
      return normTarget(attrOf(el, key) ?? '');
  }
}

const PLACEHOLDER_RE = /\[\[PII:([A-Z_]+)(?::\d+:[0-9a-f]*)?\]\]/gi;

/**
 * One spelling for comparison.
 *
 * Undoes the escaping the renderer applies (`&quot;` and friends), folds a
 * redaction token to its short rendered form, drops a trailing ellipsis - the
 * prompt clips long names and the model copies what it saw - then collapses
 * whitespace and case. Nothing looser: "contains" is a separate, explicit tier.
 */
export function normTarget(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(PLACEHOLDER_RE, (_m: string, kind: string) => `[[pii:${kind.toLowerCase()}]]`)
    .replace(/(?:…|\.\.\.)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** For elements built without a tag (hand-made in tests): the tag their role implies. */
const TAG_FOR_ROLE: Readonly<Record<string, string>> = {
  link: 'a',
  button: 'button',
  textbox: 'input',
  searchbox: 'input',
  checkbox: 'input',
  radio: 'input',
  combobox: 'select',
  listbox: 'select',
  spinbutton: 'input',
  slider: 'input',
  img: 'img',
};

/** Tags rendered with no content and no closing tag. Shared by renderer and budget. */
export const VOID_TAGS: ReadonlySet<string> = new Set(['input', 'img', 'br', 'hr', 'area', 'source']);

export function tagOf(el: SanitizedElement): string {
  return el.tag ?? TAG_FOR_ROLE[el.role] ?? 'div';
}

/**
 * The role a tag already implies. Shared by the renderer, which writes `role=`
 * only when it says something the tag does not, and by the budget estimate,
 * which must count exactly what the renderer writes.
 */
export function impliedRole(tag: string, type: string | null): string | null {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  switch (tag) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'img':
      return 'img';
    case 'input': {
      const t = (type ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    default:
      return null;
  }
}

export function attrOf(el: SanitizedElement, key: string): string | null {
  const hit = el.attrs?.find((a) => a.key === key);
  return hit === undefined ? null : hit.value.text;
}

/** Container indices from the element outward. Bounded: `parent` is data that crossed a boundary. */
export function containerChain(
  el: SanitizedElement,
  containers: readonly SanitizedContainer[],
): number[] {
  const out: number[] = [];
  let k = el.container ?? null;
  while (k !== null && out.length < 64 && !out.includes(k)) {
    out.push(k);
    k = containers[k]?.parent ?? null;
  }
  return out;
}

function matchesAttributes(el: SanitizedElement, t: TargetSpec): boolean {
  const given = (v: string | undefined): v is string => v !== undefined && normTarget(v) !== '';

  if (given(t.tag) && normTarget(tagOf(el)) !== normTarget(t.tag)) return false;
  if (given(t.role) && normTarget(el.role) !== normTarget(t.role)) return false;

  for (const key of ['id', 'name', 'type', 'placeholder', 'href'] as const) {
    const want = t[key];
    if (!given(want)) continue;
    // An <input> with no type attribute IS a text input; the model may say so.
    const have = attrOf(el, key) ?? (key === 'type' && tagOf(el) === 'input' ? 'text' : null);
    if (have === null || normTarget(have) !== normTarget(want)) return false;
  }

  if (given(t.label)) {
    const want = normTarget(t.label);
    const aria = attrOf(el, 'aria-label');
    const matchesAria = aria !== null && normTarget(aria) === want;
    if (!matchesAria && normTarget(el.name?.text ?? '') !== want) return false;
  }
  return true;
}

/** Normalised text of every sent element under each container, plus the container's own label. */
function textUnderContainers(
  elements: readonly SanitizedElement[],
  containers: readonly SanitizedContainer[],
): Map<number, string> {
  const parts = new Map<number, string[]>();
  const add = (k: number, text: string | null): void => {
    if (text === null || text === '') return;
    const list = parts.get(k) ?? [];
    list.push(normTarget(text));
    parts.set(k, list);
  };
  containers.forEach((c, k) => {
    for (const a of c.attrs) add(k, a.value.text);
  });
  for (const el of elements) {
    for (const k of containerChain(el, containers)) {
      add(k, el.name?.text ?? null);
      add(k, attrOf(el, 'aria-label'));
    }
  }
  return new Map([...parts].map(([k, list]) => [k, list.join(' | ')]));
}

/**
 * The one element `target` names among those sent, or why there is not one.
 *
 * Tiers, each deterministic:
 *   1. attributes - tag, role, id, name, type, placeholder, href, label: EXACT
 *   2. text       - exact first; only if nothing is exact, "contains"
 *   3. within     - the candidate's OWN section contains that text
 *
 * "Own section" is the largest enclosing container that holds no OTHER
 * remaining candidate. For three "Add to cart" buttons in three product cards
 * that is each button's card, so `within` is tested against that card's text
 * and never against `<main>`, which contains all three products and would match
 * every button. The element's `groupName` (the card-heading heuristic) counts
 * too, for pages whose cards are unmarked divs.
 *
 * MORE THAN ONE IS A REFUSAL, with one exception that is not a guess: several
 * links with the same href go to the same place, so any of them is the action
 * the model asked for. Amazon renders the image and the title of a product as
 * two links to one URL.
 */
export function resolveTarget(
  target: TargetSpec,
  elements: readonly SanitizedElement[],
  containers: readonly SanitizedContainer[] = [],
): TargetResolution {
  let pool = elements.filter((el) => matchesAttributes(el, target));

  if (target.text !== undefined && normTarget(target.text) !== '') {
    const want = normTarget(target.text);
    const exact = pool.filter((el) => normTarget(el.name?.text ?? '') === want);
    pool =
      exact.length > 0
        ? exact
        : pool.filter((el) => {
            const have = normTarget(el.name?.text ?? '');
            return have !== '' && have.includes(want);
          });
  }

  if (target.within !== undefined && normTarget(target.within) !== '') {
    const want = normTarget(target.within);
    const regions = ownRegionTexts(pool, elements, containers);
    pool = pool.filter((el) => (regions.get(el) ?? '').includes(want));
  }

  const first = pool[0];
  if (pool.length === 1 && first !== undefined) return { ok: true, ref: first.ref };
  if (pool.length === 0 || first === undefined) {
    const failedAt = firstFailingKey(target, elements);
    return failedAt === null
      ? { ok: false, reason: 'no-match', count: 0 }
      : { ok: false, reason: 'no-match', count: 0, failedAt };
  }

  const hrefs = new Set(pool.map((el) => (tagOf(el) === 'a' ? attrOf(el, 'href') : null)));
  const [only] = [...hrefs];
  if (hrefs.size === 1 && only !== null && only !== undefined && only !== '') {
    return { ok: true, ref: first.ref };
  }
  // `within` differs when each match's OWN section says something different -
  // the same test the within filter applies, so the hint and the fix agree.
  const regions = ownRegionTexts(pool, elements, containers);
  const differ = DIFFERENTIATORS.filter(
    (key) =>
      new Set(pool.map((el) => (key === 'within' ? (regions.get(el) ?? '') : valueFor(el, key)))).size > 1,
  );
  return { ok: false, reason: 'ambiguous', count: pool.length, differ };
}

/**
 * The text of each candidate's OWN section: its `groupName`, plus everything
 * sent inside the largest enclosing container that holds no OTHER candidate.
 * For three "Add to cart" buttons in three product cards that is each card;
 * never `<main>`, which holds all three and would match every button.
 */
function ownRegionTexts(
  pool: readonly SanitizedElement[],
  elements: readonly SanitizedElement[],
  containers: readonly SanitizedContainer[],
): Map<SanitizedElement, string> {
  const chains = new Map(pool.map((el) => [el, containerChain(el, containers)] as const));
  const under = new Map<number, number>();
  for (const chain of chains.values()) {
    for (const k of chain) under.set(k, (under.get(k) ?? 0) + 1);
  }
  const texts = textUnderContainers(elements, containers);
  const out = new Map<SanitizedElement, string>();
  for (const el of pool) {
    let region: number | null = null;
    for (const k of chains.get(el) ?? []) {
      if ((under.get(k) ?? 0) !== 1) break;
      region = k;
    }
    out.set(el, `${normTarget(el.groupName?.text ?? '')} | ${region === null ? '' : (texts.get(region) ?? '')}`);
  }
  return out;
}

/** Narrows one key at a time, in TARGET_KEYS order, and names the key that emptied the pool. */
function firstFailingKey(target: TargetSpec, elements: readonly SanitizedElement[]): TargetKey | null {
  let pool = elements;
  for (const key of ['tag', 'role', 'id', 'name', 'type', 'placeholder', 'href', 'label'] as const) {
    const want = target[key];
    if (want === undefined || normTarget(want) === '') continue;
    const next = pool.filter((el) => matchesAttributes(el, { [key]: want }));
    if (next.length === 0) return key;
    pool = next;
  }
  if (target.text !== undefined && normTarget(target.text) !== '') {
    const want = normTarget(target.text);
    const next = pool.filter((el) => normTarget(el.name?.text ?? '').includes(want));
    if (next.length === 0) return 'text';
  }
  return target.within !== undefined ? 'within' : null;
}

/**
 * A target, for the panel and the server log.
 *
 * `values: false` names the KEYS only - the server log must not carry page text,
 * and a target's values were copied off the page by the model.
 */
export function describeTarget(t: TargetSpec, opts: { readonly values: boolean }): string {
  const tag = (t.tag ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 16) || '*';
  const keys = TARGET_KEYS.filter((k) => k !== 'tag' && t[k] !== undefined);
  if (!opts.values) return `<${tag}>${keys.length > 0 ? ` [${keys.join(',')}]` : ''}`;
  const clip = (s: string): string => (s.length > 40 ? `${s.slice(0, 37)}...` : s);
  return `<${tag}${keys.map((k) => ` ${k}="${clip(t[k] ?? '')}"`).join('')}>`;
}
