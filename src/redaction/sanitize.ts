import {
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
} from '@/contracts/index.ts';
import {
  accessibleName,
  attributeRectProvider,
  canonicalPath,
  elementRole,
  readControlValue,
} from './dom-scan.ts';
import { sanitizeUrl } from './redact.ts';

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

function isHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.tagName === 'INPUT' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') return true;
  const style = el.getAttribute('style') ?? '';
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
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

function nearbyGroupName(el: Element): string | null {
  let current: Element | null = el.parentElement;
  while (current !== null && current.tagName !== 'BODY') {
    const marker = `${current.id} ${current.getAttribute('class') ?? ''} ${current.getAttribute('data-testid') ?? ''}`;
    const semanticContainer =
      ['ARTICLE', 'LI', 'SECTION', 'ASIDE'].includes(current.tagName) ||
      current.getAttribute('role') === 'group' ||
      current.getAttribute('role') === 'article' ||
      /(?:product|listing|result|card|tile|item)/i.test(marker);
    if (semanticContainer) {
      const heading = Array.from(current.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .map((node) => accessibleName(node) ?? '')
        .find((text) => text.trim() !== '');
      if (heading !== undefined) return heading.trim().slice(0, 160);
      const link = Array.from(current.querySelectorAll('a'))
        .map((node) => accessibleName(node) ?? '')
        .find((text) => text.trim() !== '');
      if (link !== undefined) return link.trim().slice(0, 160);
    }
    const nearbyLink = Array.from(current.querySelectorAll('a'))
      .map((node) => accessibleName(node) ?? '')
      .find((text) => text.trim() !== '');
    if (nearbyLink !== undefined && current.querySelectorAll('*').length <= 40) {
      return nearbyLink.trim().slice(0, 160);
    }
    current = current.parentElement;
  }
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
export function extractRefPaths(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  let n = 0;
  for (const el of interestingElements(doc)) {
    n += 1;
    map.set(`e${String(n)}`, String(canonicalPath(el)));
  }
  return map;
}

export function extractElements(
  doc: Document,
  detections: readonly Detection[],
  opts: ExtractOptions,
): SanitizedElement[] {
  const rectOf = opts.rectOf ?? attributeRectProvider;
  const sensitivePaths = new Set(
    detections.filter((d) => d.domPath !== null).map((d) => String(d.domPath)),
  );

  const out: SanitizedElement[] = [];
  let n = 0;

  for (const el of interestingElements(doc)) {
    const role = elementRole(el);
    n += 1;
    const path = String(canonicalPath(el));
    const rawName = accessibleName(el);
    const rawValue = readControlValue(el);
    const rawGroupName = nearbyGroupName(el);

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
    });
  }

  return out;
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
  const elements = extractElements(input.doc, input.detections, {
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
    schemaVersion: 1,
    taskId: input.taskId,
    step: input.step,
    goal: input.goal,
    url: sanitizeUrl(input.url),
    title: toDataAtom(markUntrusted(dropForeignPlaceholders(rawTitle, nonce)), { redacted: false }),
    viewport: input.viewport,
    elements: budgeted.kept,
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
  for (const el of ctx.elements) {
    validRefs.add(el.ref);
    if (el.isSensitive) sensitiveRefs.add(el.ref);
    // Derived from the role we ALREADY sent the model, so the rule the server
    // is held to is the same information the server was given.
    if (TYPEABLE_ROLES.has(el.role)) typeableRefs.add(el.ref);
  }
  return {
    validRefs,
    sensitiveRefs,
    typeableRefs,
    allowedOrigins,
    maxScrollPx: DEFAULT_LIMITS.maxScrollPx,
    maxWaitMs: DEFAULT_LIMITS.maxWaitMs,
    maxTypeChars: DEFAULT_LIMITS.maxTypeChars,
  };
}

/** Convenience for tests and the panel: the goal as an inert atom. */
export { userText };
