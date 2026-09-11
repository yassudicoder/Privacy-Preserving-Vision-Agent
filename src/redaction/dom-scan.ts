import {
  type Detection,
  type DetectionSource,
  type DomPath,
  type PiiKind,
  type RectProvider,
  countForgedPlaceholders,
  detectionId,
  domPath,
  parseRectAttr,
  saltedHash,
  stripForgedPlaceholders,
  TEST_SALT,
} from '@/contracts/index.ts';
import { charClassOf, scanTextPatterns } from './patterns.ts';
import { UNRENDERED_ATTR } from './stamp-geometry.ts';

/**
 * DOM-side PII detection. Pure over a Document, so it runs identically in the
 * content script and in jsdom under vitest.
 *
 * Three tiers, in descending precision:
 *   1. Structural truth - input[type=password] IS a password field.
 *   2. Declared intent  - autocomplete tokens the site author wrote.
 *   3. Heuristics       - names, ids, labels, placeholders. Guessing, so low confidence.
 * Plus text-content scanning via the validated pattern bank.
 */

export interface DomScanOptions {
  readonly rectOf?: RectProvider;
  readonly salt?: string;
  readonly minConfidence?: number;
}

export interface DomScanResult {
  readonly detections: readonly Detection[];
  /** Placeholder-shaped strings the page was carrying. Always an attack, never a coincidence. */
  readonly forgeriesStripped: number;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * A sibling index for ONE non-mutating pass over a document.
 *
 * WHY IT EXISTS. `canonicalPath` and `resolveDomPath` were both quadratic in the
 * size of the page, and on a data table that is the whole page. Measured, jsdom,
 * `telemetry-*.html`:
 *
 *     rows    canonicalPath x500   resolveDomPath x200
 *      100             132 ms              634 ms
 *     1000          10,337 ms           61,412 ms
 *
 * 307 ms for a single `querySelector`. `redact()` calls it once per detection
 * group, so a 1,000-row page carrying 1,000 redactions spent 6.3 MINUTES in
 * redaction while the analysis engine that followed it took 58 ms. The
 * 10,000-row case never finished at all.
 *
 * Two causes, both removed here:
 *   - `Array.from(parent.children)` materialised a live HTMLCollection of every
 *     sibling, once per level, once per call.
 *   - `doc.querySelector('...>tr:nth-of-type(937)>td:nth-of-type(3)')` makes the
 *     CSS engine evaluate `:nth-of-type` right-to-left across every cell in the
 *     table.
 *
 * WHAT IT IS. One pass over a parent's children records the nth-of-type ordinal
 * of every child and the ordered list needed to resolve one back. The first path
 * through a 100,000-row `<tbody>` costs 100,000 steps; every later one costs a
 * map lookup. Across a scan the total is linear in the document, not quadratic.
 *
 * WHEN IT IS VALID, and this is the load-bearing part. Element ordinals change
 * when an element is ADDED or REMOVED - not when text or an attribute is
 * rewritten. An index is therefore valid exactly as long as the caller performs
 * no structural mutation, and a stale one would yield a path resolving to the
 * WRONG element: validated, executed, reported ok. So it is never a module-level
 * cache. Each caller creates one and scopes it to a pass it can show is
 * structural-mutation-free:
 *
 *   - `scanDom` - `stripForgeriesFromDoc` rewrites `Text.data` and attribute
 *     values and removes no node; nothing else in the scan writes to the DOM.
 *   - `redact` - the span-rewrite loop assigns `Text.data` and calls
 *     `setAttribute`, and nothing else. `remove-node` strategies run in a LATER
 *     loop which is passed no index and resolves uncached. CLAUDE.md already
 *     records why removals go last; this is that same ordering doing a second
 *     job.
 *
 * Every other call site passes nothing and gets the uncached walk, which is
 * still far cheaper than what it replaced.
 */
export interface DomIndex {
  readonly byParent: WeakMap<Element, Map<string, Element[]>>;
  readonly ordinal: WeakMap<Element, number>;
}

export function createDomIndex(): DomIndex {
  return { byParent: new WeakMap(), ordinal: new WeakMap() };
}

/**
 * Index one parent's children, once.
 *
 * Two groupings out of a single walk, and they are deliberately different.
 * `ordinal` counts by EXACT `tagName`, which is what `canonicalPath` has always
 * done, so a cached ordinal is identical to the one the sibling walk produces.
 * `byParent` groups by LOWERCASE tag, because that is the form the path string
 * carries and the form resolution has to match back.
 *
 * The two can disagree only for siblings whose tag names differ by case alone -
 * an HTML `<a>` beside a foreign-content `<a>` under one parent - which the HTML
 * parser cannot produce: inside `<svg>` every element is foreign, outside it
 * every element is HTML.
 */
/**
 * Below this many children, indexing costs more than it saves.
 *
 * The index turns an O(siblings) walk into a map lookup, and it pays for that
 * with a Map, an array per tag and an ordinal entry per child. On a 100,000-row
 * table the rows are ONE parent worth indexing and the cells are 100,000 parents
 * of eight children each - indexing those allocated 100,000 Maps to save eight
 * pointer steps apiece, and the 100,000-row verification died on
 * `Mark-Compact ... allocation failure` at a 4 GB heap.
 *
 * So the index is applied where the asymptotics are and skipped where they are
 * not. A parent under the threshold falls through to the walk, which is correct
 * by construction: `nthOfType` only trusts `ordinal.get`, and an unindexed
 * element is absent from it.
 */
const INDEX_MIN_CHILDREN = 32;

function indexChildren(index: DomIndex, parent: Element): Map<string, Element[]> | null {
  const cached = index.byParent.get(parent);
  if (cached !== undefined) return cached;
  if (parent.childElementCount < INDEX_MIN_CHILDREN) return null;

  const byTag = new Map<string, Element[]>();
  const exact = new Map<string, number>();
  let child: Element | null = parent.firstElementChild;
  while (child !== null) {
    const lower = child.tagName.toLowerCase();
    let list = byTag.get(lower);
    if (list === undefined) {
      list = [];
      byTag.set(lower, list);
    }
    list.push(child);
    const n = (exact.get(child.tagName) ?? 0) + 1;
    exact.set(child.tagName, n);
    index.ordinal.set(child, n);
    child = child.nextElementSibling;
  }
  index.byParent.set(parent, byTag);
  return byTag;
}

/**
 * The nth-of-type ordinal of `el` among its siblings.
 *
 * The uncached path walks `previousElementSibling` instead of materialising
 * `parent.children`: same answer, no allocation, and it never touches a live
 * HTMLCollection.
 */
function nthOfType(el: Element, index: DomIndex | undefined): number {
  const parent = el.parentElement;
  if (parent === null) return 1;

  if (index !== undefined) {
    indexChildren(index, parent);
    const n = index.ordinal.get(el);
    // An element inserted after its parent was indexed is ABSENT, not wrong.
    // Falling through to the walk keeps that case correct rather than lucky.
    if (n !== undefined) return n;
  }

  let idx = 1;
  let sib: Element | null = el.previousElementSibling;
  while (sib !== null) {
    if (sib.tagName === el.tagName) idx += 1;
    sib = sib.previousElementSibling;
  }
  return idx;
}

export function canonicalPath(el: Element, index?: DomIndex): DomPath {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur !== null) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent === null) {
      parts.unshift(tag);
      break;
    }
    parts.unshift(`${tag}:nth-of-type(${String(nthOfType(cur, index))})`);
    cur = parent;
  }
  return domPath(parts.join('>'));
}

/** The grammar `canonicalPath` emits, and the only shape the fast walk handles. */
const CANONICAL_PART = /^([a-z][a-z0-9-]*):nth-of-type\((\d+)\)$/;

/**
 * Resolve a path back to its element.
 *
 * Walks the path itself rather than handing a 60-character `:nth-of-type` chain
 * to a CSS engine. Anything that is not the grammar `canonicalPath` emits -
 * including a root that is not this document's - falls back to `querySelector`,
 * so no caller loses a resolution it used to get.
 */
export function resolveDomPath(doc: Document, path: DomPath, index?: DomIndex): Element | null {
  const text = String(path);
  const walked = walkCanonical(doc, text, index);
  if (walked !== undefined) return walked;
  try {
    return doc.querySelector(text);
  } catch {
    return null;
  }
}

/** The nth element child of `parent` whose lowercased tag is `tag`, by walking. */
function nthChildByWalk(parent: Element, tag: string, want: number): Element | null {
  let seen = 0;
  let child: Element | null = parent.firstElementChild;
  while (child !== null) {
    if (child.tagName.toLowerCase() === tag) {
      seen += 1;
      if (seen === want) return child;
    }
    child = child.nextElementSibling;
  }
  return null;
}

/** `undefined` means "not a canonical path" - distinct from "no such element". */
function walkCanonical(
  doc: Document,
  text: string,
  index: DomIndex | undefined,
): Element | null | undefined {
  const root: Element | null = doc.documentElement;
  if (root === null) return undefined;
  const parts = text.split('>');
  if (parts[0] !== root.tagName.toLowerCase()) return undefined;

  let cur: Element = root;
  for (let i = 1; i < parts.length; i += 1) {
    const m = CANONICAL_PART.exec(parts[i] ?? '');
    if (m === null) return undefined;
    const tag = m[1] ?? '';
    const want = Number(m[2]);

    let next: Element | null = null;
    if (index !== undefined) {
      const byTag = indexChildren(index, cur);
      if (byTag !== null) {
        next = byTag.get(tag)?.[want - 1] ?? null;
      } else {
        next = nthChildByWalk(cur, tag, want);
      }
    } else {
      next = nthChildByWalk(cur, tag, want);
    }
    if (next === null) return null;
    cur = next;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// roles and names
// ---------------------------------------------------------------------------

const INPUT_TYPE_ROLE: Readonly<Record<string, string>> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

export function elementRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit.trim() !== '') return explicit.trim();

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'select':
      return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'img':
      return 'img';
    case 'form':
      return 'form';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'label':
      return 'label';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      return INPUT_TYPE_ROLE[type] ?? 'textbox';
    }
    default:
      return 'generic';
  }
}

const NAME_MAX_CHARS = 120;

/**
 * A long name, cut so that its END survives.
 *
 * This was `slice(0, 120)`, silently. On a real amazon.in results page three
 * different laptops - three ASINs - all arrived as "2026 MacBook Pro Laptop with
 * M5 Pro chip with 15-core CPU and 16-core GPU: Built for AI, 35.97 cm (14.2")
 * Liquid Retina", because the part that tells them apart - memory, storage,
 * colour - comes after character 120. Product titles put the variant LAST, so
 * the head and the tail are kept and the middle goes, marked with an ellipsis
 * so nothing reads the clipped name as the whole one. The content script calls
 * this same function for its stale-target check, so both sides clip alike.
 */
function clipName(text: string): string {
  if (text.length <= NAME_MAX_CHARS) return text;
  const head = text.slice(0, 72).replace(/\s+\S*$/, '');
  const tail = text.slice(-44).replace(/^\S*\s+/, '');
  return `${head} … ${tail}`;
}

/** Accessible name, in roughly the order the accname spec resolves them. */
/**
 * Elements whose text is never part of an accessible name.
 *
 * `<script>` and `<style>` have text content that is code, and `<template>`
 * holds an inert document fragment. All three would otherwise be concatenated
 * into a name by a flat `textContent`.
 */
const NEVER_NAMED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/**
 * Is this element excluded from the accessible name of its ancestors?
 *
 * Three signals, in decreasing portability:
 *
 *  - `aria-hidden="true"` and `hidden` are ATTRIBUTES, so they work in every
 *    context this code runs in, including a document parsed out of a string.
 *  - An inline `display:none` / `visibility:hidden` is also just an attribute
 *    to read, and it is common enough to be worth the regex.
 *  - `data-sih-unrendered` is stamped by `stampGeometry` in the CONTENT SCRIPT,
 *    where a real browser with a real stylesheet said the element has no box.
 *    That is the only one that catches a class-based `display:none`, which is
 *    how real sites hide things.
 *
 * The last is why this exists at all: on amazon.in the cart link's name came out
 * as `"Cart, shift, alt, c"` because the accesskey announcement span is hidden
 * by a CSS class, and no attribute on the element itself says so.
 */
function excludedFromName(el: Element): boolean {
  if (NEVER_NAMED.has(el.tagName)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.hasAttribute(UNRENDERED_ATTR)) return true;
  const style = el.getAttribute('style');
  if (style !== null && /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(;|$)/i.test(style)) {
    return true;
  }
  return false;
}

/**
 * The text of an element, excluding what is not part of its accessible name.
 *
 * `textContent` was used here and it is the wrong tool: it returns every
 * descendant text node with no regard for whether any of it is rendered or
 * exposed. The accessible-name spec excludes `aria-hidden` subtrees and
 * non-rendered content, and a flat concatenation includes both.
 *
 * Iterative rather than recursive: a deep DOM is attacker-controlled and a
 * recursive walk over one is a stack overflow. Bounded on output length too -
 * the caller slices anyway, and a name is not the place to build a megabyte
 * string out of a page's worth of nodes.
 */
function visibleTextOf(root: Element, limit = 4096): string {
  /*
   * A SEPARATE ELEMENT'S TEXT IS A SEPARATE WORD.
   *
   * `<span>1 item in cart</span><span>Cart</span>` has no whitespace between the
   * two spans in the source, so plain concatenation yields `1 item in cartCart`.
   * That is what `textContent` does and it is not what a browser reports: the
   * accessible-name computation appends a space between each node's
   * contribution, and Chrome's answer for that markup is `1 item in cart Cart`.
   *
   * Getting this wrong is not cosmetic here. The name is what the model is shown
   * and what the stale-target check compares across contexts, so a name no
   * browser would produce is one more string that cannot be matched to anything.
   *
   * The marker pops AFTER the element's children because it is pushed BEFORE
   * them onto a LIFO stack.
   */
  const CLOSE = Symbol('close');
  let out = '';
  const stack: (ChildNode | typeof CLOSE)[] = [];
  for (let i = root.childNodes.length - 1; i >= 0; i -= 1) {
    const n = root.childNodes[i];
    if (n !== undefined) stack.push(n);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node === CLOSE) {
      out += ' ';
      continue;
    }
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.nodeValue ?? '';
      if (out.length > limit) break;
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const el = node as Element;
    if (excludedFromName(el)) continue;
    out += ' ';
    stack.push(CLOSE);
    for (let i = el.childNodes.length - 1; i >= 0; i -= 1) {
      const c = el.childNodes[i];
      if (c !== undefined) stack.push(c);
    }
  }
  // Collapsed here, because the source is a tree and the joins between nodes are
  // arbitrary whitespace that no reader ever saw - plus the boundary spaces
  // added above, most of which land beside whitespace that was already there.
  return out.replace(/\s+/g, ' ').trim();
}

export function accessibleName(el: Element): string | null {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const doc = el.ownerDocument;
    const names = labelledBy
      .split(/\s+/)
      /*
       * `aria-labelledby` names a target explicitly, so a target that is itself
       * `aria-hidden` is still a legitimate label - that is the standard way to
       * put a name in the tree without showing it twice. Only the target's own
       * hidden DESCENDANTS are excluded, which is what `visibleTextOf` does.
       */
      .map((id) => {
        const t = doc.getElementById(id);
        return t === null ? '' : visibleTextOf(t);
      })
      .filter((s) => s !== '');
    if (names.length > 0) return names.join(' ');
  }

  const id = el.getAttribute('id');
  if (id !== null && id !== '') {
    const doc = el.ownerDocument;
    let label: Element | null = null;
    try {
      label = doc.querySelector(`label[for="${CSS_escape(id)}"]`);
    } catch {
      label = null;
    }
    // `visibleTextOf` here too - the last branch that still read raw
    // `textContent`, and a <label> is as likely as anything else to carry a
    // visually-hidden hint span.
    const text = label === null ? '' : visibleTextOf(label);
    if (text !== '') return text;
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel !== null) {
    const text = visibleTextOf(wrappingLabel);
    if (text !== '') return text;
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim();

  const alt = el.getAttribute('alt');
  if (alt !== null && alt.trim() !== '') return alt.trim();

  const title = el.getAttribute('title');
  if (title !== null && title.trim() !== '') return title.trim();

  const role = elementRole(el);
  if (role === 'button' || role === 'link' || role === 'heading' || role === 'label') {
    const text = visibleTextOf(el);
    if (text !== '') return clipName(text);
  }

  return null;
}

/** Minimal CSS.escape - jsdom has it, but older content-script environments may not. */
function CSS_escape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Read the current value of a form control.
 *
 * A <textarea> holds its value in a TEXT NODE, not in a @value attribute.
 * getAttribute('value') returns null on one, and setAttribute('value', '')
 * does nothing at all - so a textarea full of PII sails straight through a
 * naive drop-attribute. Every value read and write goes through this pair.
 */
export function readControlValue(el: Element): string | null {
  if (el.tagName === 'TEXTAREA') return el.textContent ?? '';
  return el.getAttribute('value');
}

export function writeControlValue(el: Element, value: string): void {
  if (el.tagName === 'TEXTAREA') {
    el.textContent = value;
    return;
  }
  el.setAttribute('value', value);
}

// ---------------------------------------------------------------------------
// signal tables
// ---------------------------------------------------------------------------

const INPUT_TYPE_PII: Readonly<Record<string, PiiKind>> = {
  password: 'password',
  email: 'email',
  tel: 'phone',
};

const AUTOCOMPLETE_PII: Readonly<Record<string, PiiKind>> = {
  'cc-number': 'credit-card',
  'cc-csc': 'cvv',
  'cc-name': 'person-name',
  'current-password': 'password',
  'new-password': 'password',
  'one-time-code': 'otp',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  name: 'person-name',
  'given-name': 'person-name',
  'family-name': 'person-name',
  'additional-name': 'person-name',
  'street-address': 'postal-address',
  'address-line1': 'postal-address',
  'address-line2': 'postal-address',
  'address-level1': 'postal-address',
  'address-level2': 'postal-address',
  'postal-code': 'postal-address',
  bday: 'dob',
  'bday-day': 'dob',
  'bday-month': 'dob',
  'bday-year': 'dob',
};

/** Keyword heuristics. Anchored to word boundaries - "pan" must not match "company". */
const KEYWORD_RULES: readonly { readonly re: RegExp; readonly kind: PiiKind; readonly confidence: number }[] = [
  { re: /\b(aadhaar|aadhar|uidai)\b/i, kind: 'aadhaar', confidence: 0.78 },
  { re: /\bpan\s*(card|number|no)\b|\bpan\b(?=\s*[:=])/i, kind: 'pan', confidence: 0.75 },
  { re: /\bpassport\b/i, kind: 'passport', confidence: 0.75 },
  { re: /\b(ssn|social\s*security)\b/i, kind: 'ssn', confidence: 0.78 },
  { re: /\b(cvv|cvc|security\s*code)\b/i, kind: 'cvv', confidence: 0.82 },
  { re: /\b(card\s*number|cardnumber|credit\s*card|debit\s*card)\b/i, kind: 'credit-card', confidence: 0.8 },
  { re: /\b(otp|one[\s-]*time[\s-]*(code|password))\b/i, kind: 'otp', confidence: 0.8 },
  { re: /\bifsc\b/i, kind: 'ifsc', confidence: 0.85 },
  { re: /\b(account\s*(number|no)|acct\s*no)\b/i, kind: 'bank-account', confidence: 0.7 },
  { re: /\b(dob|date\s*of\s*birth|birth\s*date)\b/i, kind: 'dob', confidence: 0.75 },
  { re: /\b(street|address\s*line|postal\s*code|pin\s*code|zip)\b/i, kind: 'postal-address', confidence: 0.65 },
  { re: /\b(mobile|phone|contact\s*number)\b/i, kind: 'phone', confidence: 0.7 },
  { re: /\b(e-?mail)\b/i, kind: 'email', confidence: 0.72 },
  { re: /\b(api[\s_-]*key|secret|token)\b/i, kind: 'api-key', confidence: 0.7 },
  { re: /\b(full\s*name|first\s*name|last\s*name|surname)\b/i, kind: 'person-name', confidence: 0.6 },
];

const IMG_VISUAL_RULES: readonly { readonly re: RegExp; readonly kind: PiiKind; readonly confidence: number }[] = [
  { re: /\b(passport|aadhaar|aadhar|licen[sc]e|id\s*card|id\s*proof)\b/i, kind: 'id-document', confidence: 0.8 },
  { re: /\bsignature\b/i, kind: 'signature', confidence: 0.8 },
  { re: /\b(profile\s*(photo|picture)|avatar|headshot|selfie)\b/i, kind: 'face', confidence: 0.65 },
  /*
   * A PHOTOGRAPHED CARD, which no model available to this project can find.
   *
   * The text rules have had a `credit-card` entry all along, so a card NUMBER in
   * the DOM is caught. This array did not, so `<img alt="photo of my debit
   * card">` produced a detection from neither channel: not from text, because
   * there is no number to match, and not from vision, because COCO contains no
   * credit card and no face detector finds one either. It fell straight through.
   *
   * One regex closes more real coverage here than any model on the Hub, at zero
   * bytes and zero milliseconds.
   *
   * DELIBERATELY NARROW. `\bcard\b` alone would take "business card", "gift
   * card", "loyalty card" and "card sorting", and metric 3 scores precision of
   * redaction at 20%. Bare "visa" is excluded for the same reason - a visa is a
   * travel document far more often than it is a payment card - while
   * "mastercard" and "rupay" are unambiguous enough to stand alone.
   */
  {
    re: /\b(credit|debit|bank|payment|atm)[\s_-]*card\b|\bcard[\s_-]*(front|back|scan)\b|\b(mastercard|rupay)\b/i,
    kind: 'credit-card',
    confidence: 0.8,
  },
];

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Remove placeholder-shaped strings the page authored. Runs BEFORE redaction
 * inserts real ones, so a page cannot forge a redaction the log has no record of.
 */
export function stripForgeriesFromDoc(doc: Document): number {
  let count = 0;
  const walker = doc.createTreeWalker(doc.documentElement, 0x00000004 /* SHOW_TEXT */);
  const dirty: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const text = node as Text;
    const found = countForgedPlaceholders(text.data);
    if (found > 0) {
      count += found;
      dirty.push(text);
    }
    node = walker.nextNode();
  }
  for (const text of dirty) {
    text.data = stripForgedPlaceholders(text.data);
  }

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const found = countForgedPlaceholders(attr.value);
      if (found > 0) {
        count += found;
        el.setAttribute(attr.name, stripForgedPlaceholders(attr.value));
      }
    }
  }
  return count;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Reset the id counter so test output is stable across runs. */
export function resetDetectionIds(): void {
  counter = 0;
}

function makeDetection(args: {
  kind: PiiKind;
  source: DetectionSource;
  confidence: number;
  el: Element;
  attr: string | null;
  nodeIndex: number | null;
  textSpan: { start: number; end: number } | null;
  value: string;
  rule: string;
  salt: string;
  rectOf: RectProvider;
  index: DomIndex;
}): Detection {
  return {
    id: detectionId(nextId('d')),
    kind: args.kind,
    source: args.source,
    confidence: args.confidence,
    rect: args.rectOf(args.el),
    domPath: canonicalPath(args.el, args.index),
    attr: args.attr,
    nodeIndex: args.nodeIndex,
    textSpan: args.textSpan,
    evidence: {
      rule: args.rule,
      valueLength: args.value.length,
      valueHash: saltedHash(args.value, args.salt),
    },
  };
}

/** Default rect provider: real layout in a browser, the fixture attribute in jsdom. */
export const attributeRectProvider: RectProvider = (el) =>
  parseRectAttr(el.getAttribute('data-test-rect'), 'css-viewport');

export function scanDom(doc: Document, opts: DomScanOptions = {}): DomScanResult {
  const salt = opts.salt ?? TEST_SALT;
  const rectOf = opts.rectOf ?? attributeRectProvider;
  const minConfidence = opts.minConfidence ?? 0;
  const out: Detection[] = [];

  const push = (d: Detection): void => {
    if (d.confidence >= minConfidence) out.push(d);
  };

  /*
   * ONE INDEX FOR THE WHOLE SCAN, created AFTER the forgery strip.
   *
   * Valid because nothing below this line changes the shape of the document:
   * `stripForgeriesFromDoc` rewrites `Text.data` and attribute values and
   * removes no node, and every loop that follows only READS. See `DomIndex`
   * for what would make it stale and why that would be a wrong-element bug
   * rather than a slow one.
   */
  const forgeriesStripped = stripForgeriesFromDoc(doc);
  const index = createDomIndex();

  // --- tier 0: explicit author or user declaration ------------------------
  for (const el of Array.from(doc.querySelectorAll('[data-sensitive],[data-pii]'))) {
    const declared = el.getAttribute('data-pii') ?? el.getAttribute('data-sensitive') ?? '';
    const kind = (declared.trim() === '' ? 'unknown-sensitive' : declared.trim()) as PiiKind;
    push(
      makeDetection({
        kind,
        source: 'user-rule',
        confidence: 1,
        el,
        attr: null,
        nodeIndex: null,
        textSpan: null,
        value: el.getAttribute('value') ?? el.textContent ?? '',
        rule: 'declared-sensitive',
        salt,
        rectOf,
        index,
      }),
    );
  }

  // --- tier 1: structural truth -------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('input'))) {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    const kind = INPUT_TYPE_PII[type];
    if (kind !== undefined) {
      push(
        makeDetection({
          kind,
          source: 'dom-input-type',
          confidence: type === 'password' ? 0.99 : 0.9,
          el,
          attr: 'value',
          nodeIndex: null,
          textSpan: null,
          value: el.getAttribute('value') ?? '',
          rule: `input-type-${type}`,
          salt,
          rectOf,
          index,
        }),
      );
    }
  }

  // --- tier 2: declared intent --------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('[autocomplete]'))) {
    const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    for (const token of tokens) {
      const kind = AUTOCOMPLETE_PII[token];
      if (kind === undefined) continue;
      push(
        makeDetection({
          kind,
          source: 'dom-autocomplete',
          confidence: 0.88,
          el,
          attr: 'value',
          nodeIndex: null,
          textSpan: null,
          value: readControlValue(el) ?? '',
          rule: `autocomplete-${token}`,
          salt,
          rectOf,
          index,
        }),
      );
      break;
    }
  }

  // --- tier 3: heuristics on names, labels, placeholders ------------------
  for (const el of Array.from(doc.querySelectorAll('input,textarea,select'))) {
    const haystack = [
      el.getAttribute('name') ?? '',
      el.getAttribute('id') ?? '',
      el.getAttribute('placeholder') ?? '',
      accessibleName(el) ?? '',
    ].join(' ');
    if (haystack.trim() === '') continue;

    for (const rule of KEYWORD_RULES) {
      if (!rule.re.test(haystack)) continue;
      push(
        makeDetection({
          kind: rule.kind,
          source: 'dom-heuristic',
          confidence: rule.confidence,
          el,
          attr: 'value',
          nodeIndex: null,
          textSpan: null,
          value: readControlValue(el) ?? '',
          rule: `keyword-${rule.kind}`,
          salt,
          rectOf,
          index,
        }),
      );
      break;
    }
  }

  // --- images that announce themselves as identity material ---------------
  for (const el of Array.from(doc.querySelectorAll('img'))) {
    const haystack = [
      el.getAttribute('alt') ?? '',
      el.getAttribute('title') ?? '',
      el.getAttribute('src') ?? '',
      el.getAttribute('class') ?? '',
    ].join(' ');
    for (const rule of IMG_VISUAL_RULES) {
      if (!rule.re.test(haystack)) continue;
      push(
        makeDetection({
          kind: rule.kind,
          source: 'dom-heuristic',
          confidence: rule.confidence,
          el,
          attr: 'src',
          nodeIndex: null,
          textSpan: null,
          value: el.getAttribute('src') ?? '',
          rule: `img-${rule.kind}`,
          salt,
          rectOf,
          index,
        }),
      );
      break;
    }
  }

  // --- attribute values that carry PII directly ---------------------------
  /*
   * `aria-label` is here because `accessibleName` reads it FIRST. Without it,
   * PII in an aria-label became the element's `name` UNREDACTED and only the
   * outbound content gate caught it - fail-closed, so nothing leaked, but a
   * single gate stood between that PII and the wire, and a hostile aria-label
   * aborted every step. Scanning it redacts it at the source, exactly as the
   * other four are. Benign labels are untouched: `scanTextPatterns` matches only
   * validated PII shapes (Luhn, etc.), not ordinary text like "Search Amazon.in".
   */
  const VALUE_ATTRS = ['value', 'placeholder', 'alt', 'title', 'aria-label'] as const;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    for (const attr of VALUE_ATTRS) {
      const raw = el.getAttribute(attr);
      if (raw === null || raw === '') continue;
      for (const match of scanTextPatterns(raw)) {
        push(
          makeDetection({
            kind: match.kind,
            source: 'regex',
            confidence: match.confidence,
            el,
            attr,
            nodeIndex: null,
            textSpan: { start: match.start, end: match.end },
            value: match.value,
            rule: match.rule,
            salt,
            rectOf,
            index,
          }),
        );
      }
    }
  }

  // --- text content --------------------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    const children = Array.from(el.childNodes);
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node === undefined || node.nodeType !== 3) continue;
      const data = (node as Text).data;
      if (data.trim() === '') continue;
      for (const match of scanTextPatterns(data)) {
        push(
          makeDetection({
            kind: match.kind,
            source: 'regex',
            confidence: match.confidence,
            el,
            attr: null,
            nodeIndex: i,
            textSpan: { start: match.start, end: match.end },
            value: match.value,
            rule: match.rule,
            salt,
            rectOf,
            index,
          }),
        );
      }
    }
  }

  return { detections: out, forgeriesStripped };
}

export { charClassOf };
