import {
  type AnalysisResult,
  type BakedScreenshot,
  type Detection,
  type ElementRef,
  type ElementState,
  type ExecutedStep,
  type Clarification,
  type RectProvider,
  type RedactionLog,
  type SanitizedContext,
  type SanitizedContextShape,
  type SanitizedElement,
  type ValidationContext,
  type ViewportInfo,
  ANY_PLACEHOLDER_RE,
  hasAnyPlaceholder,
  DEFAULT_LIMITS,
  elementRef,
  markUntrusted,
  rect,
  toDataAtom,
  userText,
  applyElementBudget,
  narrowByClarification,
  type ElementBudgetPolicy,
  TYPEABLE_ROLES,
  HTML_ATTR_NAMES,
  resolveTarget,
  type HtmlAttrName,
  type SanitizedAttr,
  type SanitizedContainer,
} from '@/contracts/index.ts';
import {
  accessibleName,
  attributeRectProvider,
  canonicalPath,
  createDomIndex,
  type DomIndex,
  elementRole,
  readControlValue,
} from './dom-scan.ts';
import { sanitizeUrl } from './redact.ts';
import { scanTextPatterns } from './patterns.ts';
import { UNRENDERED_ATTR } from './stamp-geometry.ts';

/**
 * Building the payload that leaves the machine.
 *
 * This file is the ONLY place allowed to mint a `SanitizedContext`.
 * `tests/architecture/boundaries.test.ts` fails the build if anything else
 * casts to that type, and the type is nominal so an object literal will not do.
 */

/**
 * Roles worth sending. Interactive controls plus headings and images: enough for
 * the server to reason about what is on screen and what can be acted on,
 * without shipping every <div> on the page.
 */
const INTERESTING_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
  'heading',
  'img',
  // Menus, tabs and switches are controls too, and were invisible without these.
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
]);

const ZERO_RECT = rect('css-viewport', 0, 0, 0, 0);

function statesOf(el: Element): ElementState[] {
  const states: ElementState[] = [];
  if (el.hasAttribute('disabled')) states.push('disabled');
  if (el.hasAttribute('checked') || el.getAttribute('aria-checked') === 'true') states.push('checked');
  if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') states.push('required');
  if (el.hasAttribute('readonly')) states.push('readonly');
  if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
  if (el.hasAttribute('autofocus')) states.push('focused');
  return states;
}

/**
 * How far left of the viewport counts as "parked", not "scrolled".
 *
 * The rects here are `css-viewport` - `getBoundingClientRect()` - so a NEGATIVE
 * Y is completely normal: it means the page is scrolled past that element, and
 * below-fold content has a large positive Y. Neither says anything about
 * whether a control is real, so this test is deliberately HORIZONTAL ONLY.
 *
 * A large negative X is different. `left: -9999px` is the oldest visually-hidden
 * idiom there is, and it is what real sites still use for skip links, keyboard
 * shortcut menus and screen-reader-only text.
 *
 * 5,000 px, and the size of the number is the whole design. The competing risk
 * is a HORIZONTALLY SCROLLED CAROUSEL, whose earlier slides are genuinely
 * reachable content sitting at negative X - the horizontal analogue of the
 * below-fold content this deliberately keeps. A carousel three or four slides in
 * is a few thousand pixels left at most; the hiding idiom is an order of
 * magnitude further out. Anything between the two is ambiguous, and this errs
 * towards KEEPING it, because dropping a real control is a worse failure than
 * carrying a hidden one: the first makes a task impossible, the second only
 * makes a list longer.
 */
const OFFSCREEN_LEFT_PX = -5000;

function isHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.tagName === 'INPUT' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') return true;
  const style = el.getAttribute('style') ?? '';
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;

  /*
   * THE TWO A STYLESHEET CAN DO AND AN ATTRIBUTE CANNOT SAY.
   *
   * Everything above reads the element's own markup, which is all this function
   * could ever see: extraction runs against a `DOMParser` document with no CSS
   * and no layout. Real sites hide things with CLASSES, so all of it misses the
   * common case.
   *
   * Measured on amazon.in. The extracted list carried TWO links both named from
   * their own `aria-label`: `#nav-cart` ("1 item in cart") and
   * `#nav-assist-cart` ("Cart, shift, alt, c"), the latter an entry in Amazon's
   * keyboard-shortcut menu parked at x = -9,966. Nothing in the markup of that
   * element says it is hidden. So the agent saw two differently-named links to
   * one destination, could not tell them apart, and stopped to ask the user
   * which they meant - a question with no useful answer:
   *
   *   needs an answer: Which one did you mean - Cart, shift, alt, c, or 1 item in cart?
   *
   * The evidence DOES survive the parse, and was simply never consulted: the
   * content script stamps every element's real rect onto the clone, and marks
   * the ones the browser gave no box at all. Both are read here.
   *
   * FAIL-OPEN, and that is why the geometry is read through the same attribute
   * `attributeRectProvider` uses rather than through an injected provider: with
   * no stamp there is no evidence and the element stays. `interestingElements`
   * is the ONE gate both extraction walks share, so whatever this decides,
   * `extractElements` and `extractRefPaths` decide identically - which is what
   * keeps a ref naming the same element on both sides of the wire.
   */
  if (el.hasAttribute(UNRENDERED_ATTR)) return true;
  const r = attributeRectProvider(el);
  if (r !== null && r.x + r.width <= OFFSCREEN_LEFT_PX) return true;

  return false;
}

/** Strip any placeholder not carrying this session's nonce. Belt and braces. */
function dropForeignPlaceholders(text: string, nonce: string): string {
  return text.replace(ANY_PLACEHOLDER_RE, (match) => (match.includes(`:${nonce}]]`) ? match : ''));
}

export interface ExtractOptions {
  readonly rectOf?: RectProvider;
  readonly nonce: string;
}

/**
 * Turn a redacted document into the element list the server sees.
 * Runs AFTER redact(), so every value read here is already redacted.
 */
/**
 * The elements a ref can be assigned to, in the order refs are assigned.
 *
 * Shared by `extractElements` and `extractRefPaths` so the two cannot drift.
 * If they numbered differently, a ref would name one element to the server and
 * a different one to the content script - and the click would land somewhere
 * nobody chose.
 */
function* interestingElements(doc: Document): Generator<Element> {
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (!INTERESTING_ROLES.has(elementRole(el))) continue;
    if (isHidden(el)) continue;
    yield el;
  }
}

/**
 * The product card (or similar container) an element sits in, if one is
 * identifiable - so several identical "Add to cart" buttons can be told apart.
 *
 * WHY IT TAKES A CACHE. This walks every ancestor of every interesting element
 * and, at each level, computed the accessible name of EVERY descendant anchor
 * before picking the first non-empty one. Elements in the same card share their
 * ancestors, so the same container was re-scanned once per button in it, and
 * `accessibleName` was called for anchors whose answer was thrown away.
 *
 * Measured with the shipped function on synthetic documents: 74 ms at 2,355
 * nodes, 6,502 ms at 18,805. Roughly 8x the nodes for 88x the time - the same
 * quadratic shape as `canonicalPath` and `mergeDetections`, in the stage that
 * runs immediately after them, and a real shopping page is at the far end of
 * that curve.
 *
 * Two changes, both preserving the exact result:
 *   - `firstNamed` stops at the first anchor with a name instead of naming all
 *     of them first. `.map(accessibleName).find(nonEmpty)` did the whole list.
 *   - `cache` is keyed by CONTAINER, so a card with twelve controls in it is
 *     scanned once rather than twelve times.
 *
 * The cache lives for one `buildSanitizedContext` pass over one document that
 * nothing mutates, which is the same validity argument `DomIndex` makes.
 */
type GroupCache = Map<Element, string | null>;

/** First descendant matching `selector` that has a non-empty accessible name. */
function firstNamed(container: Element, selector: string): string | null {
  const nodes = container.querySelectorAll(selector);
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const text = accessibleName(node) ?? '';
    if (text.trim() !== '') return text.trim().slice(0, 160);
  }
  return null;
}

function nearbyGroupName(el: Element, cache: GroupCache): string | null {
  let current: Element | null = el.parentElement;
  /*
   * Ancestors visited on the way to an answer all get the SAME answer, so they
   * are filled in together at the end. Without this the cache only ever helps
   * siblings, and the deep ancestors - the ones with the most descendants to
   * scan - are re-walked for every element on the page.
   */
  const visited: Element[] = [];

  while (current !== null && current.tagName !== 'BODY') {
    const hit = cache.get(current);
    if (hit !== undefined) {
      for (const seen of visited) cache.set(seen, hit);
      return hit;
    }
    visited.push(current);

    const marker = `${current.id} ${current.getAttribute('class') ?? ''} ${current.getAttribute('data-testid') ?? ''}`;
    const semanticContainer =
      ['ARTICLE', 'LI', 'SECTION', 'ASIDE'].includes(current.tagName) ||
      current.getAttribute('role') === 'group' ||
      current.getAttribute('role') === 'article' ||
      /(?:product|listing|result|card|tile|item)/i.test(marker);

    if (semanticContainer) {
      const heading = firstNamed(current, 'h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (heading !== null) {
        for (const seen of visited) cache.set(seen, heading);
        return heading;
      }
      const link = firstNamed(current, 'a');
      if (link !== null) {
        for (const seen of visited) cache.set(seen, link);
        return link;
      }
    }

    /*
     * The small-container fallback. The size check runs FIRST now: it is one
     * `querySelectorAll` length against a constant, where naming the anchors is
     * an accessible-name computation per anchor. Doing the cheap disqualifying
     * test second meant paying the expensive one on every large ancestor - which
     * on a real page is most of them.
     */
    if (current.querySelectorAll('*').length <= 40) {
      const nearbyLink = firstNamed(current, 'a');
      if (nearbyLink !== null) {
        for (const seen of visited) cache.set(seen, nearbyLink);
        return nearbyLink;
      }
    }
    current = current.parentElement;
  }

  for (const seen of visited) cache.set(seen, null);
  return null;
}

/**
 * ref -> DOM path, for the refs `extractElements` will assign to this document.
 *
 * WHY THIS EXISTS: `SanitizedElement` carries no path, deliberately - the server
 * has no business knowing the page's DOM structure. But the content script has
 * to turn the ref the model chose back into an element, and `e7` alone cannot
 * do that. So the mapping stays on the client, alongside the context rather than
 * inside it.
 *
 * The path is computed against the document passed in, which is the REDACTED
 * one. Redaction can remove nodes, so a path may not resolve against the live
 * page. That degrades to a reported miss in `executeAction`, never to a click on
 * the wrong element.
 */
// ---------------------------------------------------------------------------
// Structure: the tag, a closed set of attributes, and the enclosing containers
// ---------------------------------------------------------------------------

const TAG_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_ATTR_CHARS = 120;

/** Tags that group controls, where the boundary means something to a reader. */
const CONTAINER_TAGS = new Set([
  'FORM', 'NAV', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'SECTION', 'ARTICLE',
  'DIALOG', 'FIELDSET', 'MENU', 'UL', 'OL', 'LI', 'TABLE', 'TR',
]);

/** The same, for markup that says it with a role instead of a tag. */
const CONTAINER_ROLES = new Set([
  'form', 'search', 'navigation', 'banner', 'contentinfo', 'main', 'complementary',
  'region', 'article', 'dialog', 'alertdialog', 'menu', 'menubar', 'list', 'listitem',
  'group', 'toolbar', 'tablist', 'tabpanel', 'grid', 'row', 'radiogroup', 'tree',
]);

function tagNameOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  return TAG_NAME_RE.test(tag) ? tag : 'div';
}

function explicitRole(el: Element): string | null {
  const first = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  return /^[a-z][a-z-]{0,40}$/.test(first) ? first : null;
}

function isContainer(el: Element): boolean {
  if (CONTAINER_TAGS.has(el.tagName)) return true;
  const role = explicitRole(el);
  return role !== null && CONTAINER_ROLES.has(role);
}

/**
 * `href` cut to origin + path, or a bare scheme.
 *
 * Query strings and fragments are where session ids, search terms and emails
 * travel, which is why the redaction log already drops them from the PAGE url
 * (`sanitizeUrl`). A same-origin link keeps its path only. `javascript:` and
 * in-page `#` anchors carry nothing a planner can act on, so they are not sent.
 */
function safeHref(raw: string): string | null {
  const v = raw.trim();
  if (v === '' || v.startsWith('#')) return null;
  const lower = v.toLowerCase();
  if (lower.startsWith('mailto:')) return 'mailto:';
  if (lower.startsWith('tel:')) return 'tel:';
  let url: URL;
  try {
    url = new URL(v, 'https://same-origin.invalid/');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === 'https://same-origin.invalid' ? url.pathname : `${url.origin}${url.pathname}`;
}

/**
 * The attributes worth sending, read off the REDACTED element.
 *
 * DROPPED, NOT REDACTED, when any PII pattern matches. The redactor rewrites
 * text and value/placeholder/alt/title; an email in an `id` or a path would
 * otherwise ride out on an attribute nothing else inspects. The outbound
 * content gate would catch it and refuse the whole step - dropping one
 * attribute here costs the model one hint instead of costing the user a step.
 * Scanned at confidence 0, stricter than the gate, so the gate can never fire
 * on something this let through.
 */
function safeAttrs(
  el: Element,
  keys: readonly HtmlAttrName[],
  nonce: string,
  accessibleNameText: string | null = null,
): SanitizedAttr[] {
  const out: SanitizedAttr[] = [];
  for (const key of keys) {
    const raw = el.getAttribute(key);
    if (raw === null) continue;
    // Already the element's text, which is sent anyway. 822 bytes of
    // duplicated product titles on one amazon.in page at an 8k budget.
    if (key === 'aria-label' && accessibleNameText !== null && collapse(raw) === collapse(accessibleNameText)) {
      continue;
    }
    // A UUID or hash names nothing a reader - or a model - can use.
    if (key === 'id' && MACHINE_ID_RE.test(raw)) continue;
    const cut = key === 'href' ? safeHref(raw) : raw.trim();
    if (cut === null || cut === '') continue;
    const text = dropForeignPlaceholders(cut, nonce);
    if (text === '') continue;
    if (scanTextPatterns(text.replace(ANY_PLACEHOLDER_RE, ' ')).length > 0) continue;
    out.push({
      key,
      value: toDataAtom(markUntrusted(text), {
        redacted: hasAnyPlaceholder(text),
        maxChars: MAX_ATTR_CHARS,
      }),
    });
  }
  return out;
}

const CONTAINER_ATTRS: readonly HtmlAttrName[] = ['id', 'name', 'aria-label'];

/** A generated id: a UUID fragment, a long hex hash, or a long number. Generic, not per-site. */
const MACHINE_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}|\d{5,}/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The nearest enclosing container of each element, registering containers as
 * they are met - outermost first, so every `parent` index already exists.
 *
 * Memoised per ancestor: N elements cost O(N) walks rather than O(N x depth),
 * which is the difference that mattered for `nearbyGroupName` on the
 * 100,000-row tables.
 */
function createContainerIndex(nonce: string): {
  readonly containers: SanitizedContainer[];
  readonly nearest: (el: Element) => number | null;
} {
  const containers: SanitizedContainer[] = [];
  const memo = new Map<Element, number | null>();
  const nearest = (el: Element): number | null => {
    const path: Element[] = [];
    let current: Element | null = el.parentElement;
    let found: number | null = null;
    while (current !== null && current.tagName !== 'BODY' && current.tagName !== 'HTML') {
      const hit = memo.get(current);
      if (hit !== undefined) {
        found = hit;
        break;
      }
      path.push(current);
      current = current.parentElement;
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const node = path[i];
      if (node === undefined) continue;
      if (isContainer(node)) {
        containers.push({
          tag: tagNameOf(node),
          role: explicitRole(node),
          attrs: safeAttrs(node, CONTAINER_ATTRS, nonce),
          parent: found,
        });
        found = containers.length - 1;
      }
      memo.set(node, found);
    }
    return found;
  };
  return { containers, nearest };
}

export function extractRefPaths(doc: Document, index?: DomIndex): Map<string, string> {
  const map = new Map<string, string>();
  const idx = index ?? createDomIndex();
  let n = 0;
  for (const el of interestingElements(doc)) {
    n += 1;
    map.set(`e${String(n)}`, String(canonicalPath(el, idx)));
  }
  return map;
}

export function extractElements(
  doc: Document,
  detections: readonly Detection[],
  opts: ExtractOptions,
): SanitizedElement[] {
  return extractPage(doc, detections, opts).elements;
}

/**
 * The sent elements AND the structure they sit in. Same walk, same order and
 * same ref numbering as before - `extractRefPaths` must still agree element for
 * element - with each element now also carrying its tag, its safe attributes
 * and the index of its nearest container.
 */
export function extractPage(
  doc: Document,
  detections: readonly Detection[],
  opts: ExtractOptions,
): { readonly elements: SanitizedElement[]; readonly containers: SanitizedContainer[] } {
  const rectOf = opts.rectOf ?? attributeRectProvider;
  const structure = createContainerIndex(opts.nonce);
  const sensitivePaths = new Set(
    detections.filter((d) => d.domPath !== null).map((d) => String(d.domPath)),
  );

  const out: SanitizedElement[] = [];
  /*
   * Scoped to this ONE pass over this ONE document, for the same reason
   * `DomIndex` is: it caches an answer derived from document structure, and
   * nothing below this line mutates the document. A pass-scoped cache cannot go
   * stale; a module-level one would.
   */
  const groupCache: GroupCache = new Map();
  /*
   * THE SAME INDEX `redact()` USES, in the stage right after it.
   *
   * `canonicalPath` walks `previousElementSibling` to find an element's
   * nth-of-type ordinal, and this loop calls it once per interesting element -
   * then `extractRefPaths` calls it again for the same elements. On a page whose
   * rows are siblings of one another (a search-results list, a table) the walk
   * is O(row index), so the pair is quadratic in the number of rows. Measured on
   * a 1,200-row flat page: 497 ms before, and the cost is almost all here.
   *
   * Valid for the same reason it is valid in `scanDom`: this pass READS the
   * document and never changes its shape.
   */
  const pathIndex = createDomIndex();
  let n = 0;

  for (const el of interestingElements(doc)) {
    const role = elementRole(el);
    n += 1;
    const path = String(canonicalPath(el, pathIndex));
    const rawName = accessibleName(el);
    const rawValue = readControlValue(el);
    const rawGroupName = nearbyGroupName(el, groupCache);

    const nameText = rawName === null ? null : dropForeignPlaceholders(rawName, opts.nonce);
    const valueText = rawValue === null ? null : dropForeignPlaceholders(rawValue, opts.nonce);

    out.push({
      ref: elementRef(`e${n}`),
      role,
      name:
        nameText === null || nameText === ''
          ? null
          : toDataAtom(markUntrusted(nameText), {
              redacted: hasAnyPlaceholder(nameText),
            }),
      groupName:
        rawGroupName === null || rawGroupName === ''
          ? null
          : toDataAtom(markUntrusted(dropForeignPlaceholders(rawGroupName, opts.nonce)), {
              redacted: hasAnyPlaceholder(rawGroupName),
            }),
      value:
        valueText === null
          ? null
          : toDataAtom(markUntrusted(valueText), {
              redacted: hasAnyPlaceholder(valueText),
            }),
      rect: rectOf(el) ?? ZERO_RECT,
      states: statesOf(el),
      isSensitive: sensitivePaths.has(path),
      tag: tagNameOf(el),
      attrs: safeAttrs(el, HTML_ATTR_NAMES, opts.nonce, rawName),
      container: structure.nearest(el),
    });
  }

  return { elements: out, containers: structure.containers };
}

/**
 * Only the containers some SENT element sits in, renumbered, with every
 * `parent` and `container` index rewritten to match.
 *
 * Without this a page of a thousand list items would ship a thousand
 * containers whose elements the budget had already dropped. Refs are NOT
 * touched - they are execution handles and must keep naming the same element.
 */
function pruneContainers(
  kept: readonly SanitizedElement[],
  containers: readonly SanitizedContainer[],
): { readonly elements: readonly SanitizedElement[]; readonly containers: readonly SanitizedContainer[] } {
  const used = new Set<number>();
  for (const el of kept) {
    let k = el.container ?? null;
    while (k !== null && !used.has(k)) {
      used.add(k);
      k = containers[k]?.parent ?? null;
    }
  }
  const order = [...used].sort((a, b) => a - b);
  const remap = new Map(order.map((old, i) => [old, i]));
  const at = (k: number | null | undefined): number | null =>
    k === null || k === undefined ? null : (remap.get(k) ?? null);
  return {
    elements: kept.map((el) => (el.container === undefined ? el : { ...el, container: at(el.container) })),
    containers: order.map((old) => {
      const c = containers[old] ?? { tag: 'div', role: null, attrs: [], parent: null };
      return { ...c, parent: at(c.parent) };
    }),
  };
}

export interface BuildContextInput {
  readonly doc: Document;
  readonly log: RedactionLog;
  readonly detections: readonly Detection[];
  readonly viewport: ViewportInfo;
  readonly url: string;
  readonly taskId: string;
  readonly step: number;
  /** From the USER. Never from the page. */
  readonly goal: string;
  readonly screenshot: BakedScreenshot | null;
  readonly rectOf?: RectProvider;
  readonly history?: readonly ExecutedStep[];
  /** Q&A already exchanged with the user. From the user, never from the page. */
  readonly clarifications?: readonly Clarification[];
  /**
   * REQUIRED. An optional policy lets a new call site silently reintroduce the
   * unbounded path, which is the same reasoning `StepDeps.dom` is required for.
   */
  readonly budget: ElementBudgetPolicy;
  /**
   * What the local analysis engine computed over this same redacted document.
   *
   * Passed IN rather than computed here, so `redaction` never has to know how
   * statistics work and `analysis` never has to know how a context is minted.
   * Null when analysis did not run, which is the default - a page with no table
   * pays nothing for this feature.
   */
  readonly analysis?: AnalysisResult | null;
}

/**
 * The sole producer of SanitizedContext.
 *
 * Note the screenshot parameter: it is a `BakedScreenshot`, which only
 * `bakeRedactions()` can mint. There is no way to hand this function a raw frame
 * and claim its redactions were applied.
 */
export function buildSanitizedContext(input: BuildContextInput): SanitizedContext {
  const nonce = String(input.log.nonce);
  const { elements, containers } = extractPage(input.doc, input.detections, {
    nonce,
    ...(input.rectOf !== undefined ? { rectOf: input.rectOf } : {}),
  });

  /*
   * FILTERED HERE, AND NEVER RENUMBERED.
   *
   * `extractElements` above numbered the FULL walk, and `extractRefPaths` walks
   * the same full document - so the budget may remove rows but must never
   * compact the ordinals. If it did, `e17` would name one element to the model
   * and resolve to a different one in the page: validated, executed, reported
   * ok, and wrong.
   *
   * Applied here rather than in `renderPrompt` because `validationContextFor`
   * builds the ref allowlist from this same list. Trimming at render time would
   * leave the allowlist a superset of what was actually sent, and "the model may
   * only address elements we sent it" is the runtime backstop against a
   * compromised server.
   */
  /*
   * THE USER'S ANSWER REMOVES THE OTHER CANDIDATES.
   *
   * Before budgeting, so the narrowing frees room rather than competing for it -
   * and before the prompt, because the model was measured to ignore the answer
   * entirely: same ref returned whether the reply was "Gaming Laptop" or "Laptop
   * Pro". Constraining is the lever; instructing is not.
   */
  const narrowed = narrowByClarification(elements, input.clarifications ?? [], input.goal);

  const budgeted = applyElementBudget(narrowed, input.budget, {
    goalTerms: new Set(
      input.goal
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    ),
    viewport: input.viewport,
    withGeometry: input.screenshot !== null,
    hasImage: input.screenshot !== null,
  });

  const rawTitle = input.doc.title ?? '';
  const shape: SanitizedContextShape = {
    analysis: input.analysis ?? null,
    schemaVersion: 1,
    taskId: input.taskId,
    step: input.step,
    goal: input.goal,
    url: sanitizeUrl(input.url),
    title: toDataAtom(markUntrusted(dropForeignPlaceholders(rawTitle, nonce)), { redacted: false }),
    viewport: input.viewport,
    ...pruneContainers(budgeted.kept, containers),
    /*
     * THE BUDGET'S DECISION IS ACTED ON, not merely recorded.
     *
     * `applyElementBudget` sheds the screenshot as its SECOND escalation lever
     * and sets `screenshotDropped: true`. That flag used to change only the token
     * ESTIMATE: this line still assigned `input.screenshot`, and `VlmPlanner`
     * still sent an image part for any non-null screenshot, so the image went
     * anyway.
     *
     * Two consequences, and the second is the worse one. The token accounting was
     * wrong in the direction that OVERFILLS the window - the same class of bug
     * `renderPrompt`'s geometry comment records fixing, where an estimate assumed
     * a lever had taken effect and it had not. And `budget.screenshotDropped` is
     * exactly the field a reviewer reads to confirm "no image was sent this
     * step", so it said the opposite of what happened.
     *
     * Honouring it here rather than at the send site keeps one answer to "was
     * there an image": the context either carries one or it does not.
     */
    screenshot: budgeted.report.screenshotDropped ? null : input.screenshot,
    redactionSummary: input.log.summary,
    nonce: input.log.nonce,
    history: input.history ?? [],
    clarifications: input.clarifications ?? [],
    budget: budgeted.report,
  };

  // The single sanctioned cast in the codebase. Everything upstream of here is
  // what makes it true.
  return shape as SanitizedContext;
}

/**
 * Re-brands a SanitizedContext that crossed a message boundary.
 *
 * KEPT IN THIS FILE DELIBERATELY. `boundaries.test.ts` pins the files allowed to
 * contain `as SanitizedContext` and expects exactly this one, so putting the
 * cast anywhere else fails that test - which is the point of it. It is also NOT
 * exported from `redaction/index.ts`: minting a context stays inside this
 * module, and only `createRemoteDomPipeline` needs it.
 *
 * WHAT THIS DOES NOT GUARANTEE: that the value ever went through
 * `buildSanitizedContext`. JSON strips the nominal marker, so on Chrome - where
 * sanitize runs in the offscreen document because the service worker has no
 * DOM - the brand must be restored on arrival. `receiveBakedScreenshot` makes
 * the same trade for the same reason. The in-process path keeps the real
 * compile-time mint.
 */
export function receiveSanitizedContext(shape: SanitizedContextShape): SanitizedContext {
  return { ...shape } as SanitizedContext;
}

/** Derive the guard rails the action validator needs from what we actually sent. */
/**
 * Roles that can hold typed text.
 *
 * Matches what `asValueElement` accepts in the executor: anything else refuses
 * with "holds no value". Kept here rather than in execution because the DAG
 * forbids redaction -> execution, and because this is the list the model is
 * shown.
 */
export function validationContextFor(
  ctx: SanitizedContext,
  allowedOrigins: readonly string[],
): ValidationContext {
  const validRefs = new Set<ElementRef>();
  const sensitiveRefs = new Set<ElementRef>();
  const typeableRefs = new Set<ElementRef>();
  const currentValues = new Map<ElementRef, string>();
  for (const el of ctx.elements) {
    validRefs.add(el.ref);
    if (el.isSensitive) sensitiveRefs.add(el.ref);
    // Derived from the role we ALREADY sent the model, so the rule the server
    // is held to is the same information the server was given.
    if (TYPEABLE_ROLES.has(el.role)) typeableRefs.add(el.ref);
    /*
     * Only what the model was actually shown, and only when it is comparable.
     *
     * A REDACTED value reached the model as a placeholder, not as text, so the
     * model asking to type the real thing is not a repeat of anything - it never
     * saw the real thing. Comparing against a placeholder would refuse a
     * legitimate first attempt, which is the one failure mode worse than the
     * loop this prevents.
     */
    const value = el.value;
    if (value !== null && !value.redacted && !value.truncated) {
      currentValues.set(el.ref, value.text);
    }
  }
  return {
    validRefs,
    sensitiveRefs,
    typeableRefs,
    currentValues,
    // Model-written targets resolve against exactly what was sent - nothing else.
    locate: (target) => resolveTarget(target, ctx.elements, ctx.containers ?? []),
    allowedOrigins,
    maxScrollPx: DEFAULT_LIMITS.maxScrollPx,
    maxWaitMs: DEFAULT_LIMITS.maxWaitMs,
    maxTypeChars: DEFAULT_LIMITS.maxTypeChars,
  };
}

/** Convenience for tests and the panel: the goal as an inert atom. */
export { userText };
