import type { SanitizedElement } from './context.ts';
import type { ViewportInfo } from './geometry.ts';

/**
 * How much context may be sent, and what to shed first when it will not fit.
 *
 * WHY THIS EXISTS. A real run sent 69 elements and a screenshot and got back
 * `request (4139 tokens) exceeds the available context size (4096 tokens)`. The
 * task stopped. Nothing anywhere bounded the payload: the only limit was
 * `MAX_REQUEST_BYTES` at 2 MB, and the failing request was 3% of that.
 *
 * WHY IT LIVES IN `contracts`. `redaction` applies it and `agent-server` has to
 * render by the same two rules, and the module DAG lets both import only from
 * here. It is DATA rather than a callback for a second reason: on Chrome the
 * sanitize request crosses `postMessage` into the offscreen document, and a
 * function cannot travel.
 *
 * THE ONE HARD RULE: FILTER, NEVER RENUMBER.
 *
 * Refs are positional ordinals - `extractElements` counts interesting elements
 * in document order. If a budget COMPACTED the list, `e17` would name a
 * different element depending on what was dropped, while `extractRefPaths`
 * walked the unfiltered document and produced a path for the OLD `e17`. That
 * resolves, executes, and reports success on the wrong element. Dropping rows
 * while keeping each survivor's original ordinal makes the worst case "the
 * element is absent", which is visible, instead of "the element is wrong", which
 * is not.
 */

export interface ElementBudgetPolicy {
  /** Tokens the whole prompt may occupy, reply excluded. */
  readonly maxPromptTokens: number;
  /** Below this many elements the request is not worth making. */
  readonly minElements: number;
  /** Cap on a rendered name or value, in characters. */
  readonly maxRenderedNameChars: number;
  /** Conservative bytes-per-token for TEXT. Must UNDER-estimate tokens per byte. */
  readonly bytesPerToken: number;
  /**
   * Tokens an attached screenshot costs, as a flat reserve.
   *
   * NOT derived from its byte length. A vision model tokenises an image as
   * PATCHES; the base64 length has nothing to do with it. Dividing 53 KB of
   * base64 by a text bytes-per-token ratio produced an estimate of ~26,500
   * tokens for an image that really costs about 1,200 - so the budget believed
   * it was eight times over, shed 55 of 63 elements to its floor, and still
   * reported over budget. It made the agent nearly blind while fixing nothing.
   *
   * ~1200 covers a 768 px longest-edge JPEG at qwen2.5-VL's patch size with
   * headroom.
   */
  readonly imageTokens: number;
  /**
   * How many elements sharing one (role, name) may be sent.
   *
   * MEASURED on a storefront of 150 products: 250 rows carrying 40 distinct
   * names, of which 151 were the identical button "Add to basket". Row 151 tells
   * the model nothing row 1 did not - they are indistinguishable in the prompt,
   * so the extra 148 buy no ability to choose between them while crowding out
   * the product links that ARE distinct.
   *
   * Three rather than one, deliberately: a page with two "Next" buttons or a
   * pair of "Sign in" links is common and collapsing those to a single row would
   * hide a real choice. Three is enough to show that duplicates exist.
   *
   * The agent reaches a specific product through its distinctly-named LINK, not
   * by choosing among identical buttons - so this cap does not remove a path,
   * it removes rows that were never addressable.
   */
  readonly maxPerDuplicateName: number;
}

/**
 * Derived, not guessed.
 *
 * The Ollama model used by this project is configured with a large context
 * 32,768-token context window, so the default leaves room for real commerce
 * pages rather than forcing them into the old 4096-token floor. The prompt
 * budget is below the total window because the model also needs reply tokens
 * and protocol headroom. This is intentionally finite:
 * "unlimited" would still be rejected by the model/server context window and
 * would make failures appear nondeterministically after serialization.
 *
 * `maxRenderedNameChars: 96` against a longest observed name of 23 bytes across
 * all six fixtures - invisible on a benign page, decisive on a hostile one.
 */
export const DEFAULT_BUDGET_POLICY: ElementBudgetPolicy = {
  maxPromptTokens: 30_000,
  minElements: 8,
  maxRenderedNameChars: 96,
  bytesPerToken: 2.0,
  imageTokens: 1200,
  maxPerDuplicateName: 3,
};

export interface DroppedElement {
  readonly ref: string;
  readonly role: string;
}

/**
 * What the budget did. Travels in the context so the panel, the prompt and the
 * scorers all see it - CLAUDE.md forbids bounding coverage silently.
 */
export interface BudgetReport {
  /** Elements the page actually offered. */
  readonly available: number;
  /** Elements sent. */
  readonly sent: number;
  readonly estimatedTokens: number;
  readonly tokenBudget: number;
  readonly dropped: readonly DroppedElement[];
  readonly namesTruncated: number;
  readonly geometryOmitted: boolean;
  readonly screenshotDropped: boolean;
  /** Rows removed because they duplicated a (role, name) already sent. */
  readonly duplicatesCollapsed: number;
}

export function emptyBudgetReport(count: number): BudgetReport {
  return {
    available: count,
    sent: count,
    estimatedTokens: 0,
    tokenBudget: 0,
    dropped: [],
    namesTruncated: 0,
    geometryOmitted: false,
    screenshotDropped: false,
    duplicatesCollapsed: 0,
  };
}

/** Everything in the prompt that is not an element row. Measured, not guessed. */
const SCAFFOLDING_BYTES = 1500;

/** Truncate for rendering, marking that it happened. */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars - 1)}…`, truncated: true };
}

/**
 * Bytes one element will occupy in the prompt.
 *
 * A HAND-MIRROR of `renderElement`, and deliberately so. It cannot be injected:
 * this runs inside `buildSanitizedContext`, which on Chrome executes across a
 * `postMessage` boundary a function cannot cross. The duplication is pinned by a
 * test that renders a real element and compares the two.
 */
export function estimateElementBytes(
  el: SanitizedElement,
  opts: { withGeometry: boolean; maxNameChars: number },
): number {
  const nameText = capText(el.name?.text ?? '', opts.maxNameChars).text;
  let n = `ref=${String(el.ref)} role=${el.role} name="${nameText}"`.length;
  if (el.groupName != null) n += ` group="${capText(el.groupName.text ?? '', opts.maxNameChars).text}"`.length;
  if (el.value !== null && el.value !== undefined) {
    n += ` value="${capText(el.value.text ?? '', opts.maxNameChars).text}"`.length;
  }
  if (opts.withGeometry && el.rect !== null) n += ' box=[0000,0000,0000,0000]'.length;
  if (el.states.length > 0) n += ` states=${el.states.join('|')}`.length;
  if (el.isSensitive) n += ' SENSITIVE'.length;
  return n + 1; // newline
}

/**
 * How much this element is worth keeping. Higher survives longer.
 *
 * Deterministic, with document order as the final tie-break - which is what
 * makes the kept set identical across two steps on an unchanged page. A budget
 * that churned its own selection would reintroduce the instability that not
 * renumbering was meant to avoid.
 */
/** Does this element's box intersect the viewport at all? */
function isOnScreen(el: SanitizedElement, viewport: ViewportInfo | null): boolean {
  if (viewport === null || el.rect === null) return false;
  return (
    el.rect.y < viewport.cssHeight &&
    el.rect.y + el.rect.height > 0 &&
    el.rect.x < viewport.cssWidth
  );
}

export function rankElement(
  el: SanitizedElement,
  goalTerms: ReadonlySet<string>,
  viewport: ViewportInfo | null,
): number {
  let score: number;
  switch (el.role) {
    case 'textbox':
    case 'searchbox':
    case 'combobox':
    case 'spinbutton':
      score = 4;
      break;
    case 'button':
    case 'checkbox':
    case 'radio':
    case 'listbox':
    case 'slider':
      score = 3;
      break;
    case 'link':
      score = 2;
      break;
    case 'heading':
      score = 1;
      break;
    default:
      score = 0;
  }

  if (
    (el.role === 'searchbox' || el.role === 'textbox') &&
    isOnScreen(el, viewport) &&
    goalTerms.size > 0
  ) {
    score += 4;
  }

  // The planner scores on the same affinity, so the budget keeps what the
  // planner would have reached for.
  const name = (el.name?.text ?? '').toLowerCase();
  const groupName = (el.groupName?.text ?? '').toLowerCase();
  if (name !== '') {
    for (const term of goalTerms) {
      if (term.length > 2 && name.includes(term)) {
        score += 2;
        break;
      }
    }
  }
  for (const term of goalTerms) {
    if (term.length > 2 && groupName.includes(term)) {
      score += 3;
      break;
    }
  }

  /*
   * AN UNNAMED ELEMENT CANNOT BE CHOSEN DELIBERATELY.
   *
   * `ref=e50 role=link name=""` gives the model nothing to reason about, and
   * once the budget drops geometry there is no other handle either. The
   * storefront measurement had 31 such rows among 250 - pure cost.
   *
   * Penalised rather than excluded: it is still a real element, and on a page
   * with few enough elements to fit, sending it costs nothing.
   */
  if ((el.name?.text ?? '') === '') score -= 2;

  if (el.states.some((s) => s === 'required' || s === 'invalid' || s === 'focused')) score += 1;

  // Below the fold is in the DOM scan but not in the screenshot, so it is the
  // cheapest thing to lose when an image is attached.
  if (isOnScreen(el, viewport)) score += 1;

  return score;
}

export interface ApplyBudgetOptions {
  readonly goalTerms: ReadonlySet<string>;
  readonly viewport: ViewportInfo | null;
  /** False when no screenshot is attached, which removes `box=` from every row. */
  readonly withGeometry: boolean;
  /** Whether a screenshot is attached. Its COST is `policy.imageTokens`. */
  readonly hasImage: boolean;
}

export interface ApplyBudgetResult {
  readonly kept: readonly SanitizedElement[];
  readonly report: BudgetReport;
}

/**
 * Shed until it fits, cheapest harm first.
 *
 * Names are capped by the renderer regardless. Geometry goes when there is no
 * image to correlate it against. Only then are elements dropped, lowest rank
 * first, and never below `minElements` - a context with two elements is not a
 * degraded request, it is a request about a page nobody looked at.
 */
export function applyElementBudget(
  all: readonly SanitizedElement[],
  policy: ElementBudgetPolicy,
  opts: ApplyBudgetOptions,
): ApplyBudgetResult {
  let namesTruncated = 0;
  for (const el of all) {
    if ((el.name?.text ?? '').length > policy.maxRenderedNameChars) namesTruncated += 1;
  }

  /*
   * COLLAPSE DUPLICATES FIRST, before anything competes for space.
   *
   * Rows sharing a (role, name) are indistinguishable IN THE PROMPT - the model
   * has no way to tell the 40th "Add to basket" from the 1st, so the 40th buys
   * no choice it did not already have. Measured on a 150-product storefront: 250
   * rows carrying 40 distinct names, 151 of them one identical button, while
   * distinct product links were being dropped to make room for them.
   *
   * Done before ranking, not as part of it: a rank is a preference and this is
   * an observation about information content. Ranking duplicates lower would
   * still let 151 of them outrank a heading.
   *
   * On-screen survivors are preferred, then document order - so the cap keeps
   * the ones a user is looking at. Ordinals are untouched, as everywhere else
   * here: this is a filter, never a renumbering.
   */
  const seen = new Map<string, number>();
  const ordered = all.map((el, i) => ({ el, i }));
  const onScreenFirst = [...ordered].sort((a, b) => {
    const aOn = isOnScreen(a.el, opts.viewport) ? 0 : 1;
    const bOn = isOnScreen(b.el, opts.viewport) ? 0 : 1;
    return aOn === bOn ? a.i - b.i : aOn - bOn;
  });
  const collapsed = new Set<number>();
  for (const { el, i } of onScreenFirst) {
    const key = `${el.role} ${el.name?.text ?? ''}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > policy.maxPerDuplicateName) collapsed.add(i);
  }
  const duplicatesCollapsed = collapsed.size;
  const survivors = ordered.filter((o) => !collapsed.has(o.i)).map((o) => o.el);

  const sizeOf = (el: SanitizedElement, withGeometry: boolean): number =>
    estimateElementBytes(el, { withGeometry, maxNameChars: policy.maxRenderedNameChars });

  const total = (els: readonly SanitizedElement[], withGeometry: boolean): number =>
    els.reduce((n, el) => n + sizeOf(el, withGeometry), 0);

  /*
   * TEXT is estimated from bytes; the IMAGE is a flat token reserve.
   *
   * Mixing the two was a real bug: base64 length divided by a text
   * bytes-per-token ratio valued one screenshot at ~26,500 tokens, and the
   * budget dropped 55 of 63 elements chasing a number that was never real.
   */
  const textTokens = (bytes: number): number => Math.ceil(bytes / policy.bytesPerToken);

  let withGeometry = opts.withGeometry;
  let geometryOmitted = false;
  let hasImage = opts.hasImage;
  let screenshotDropped = false;

  const tokensNow = (): number =>
    textTokens(SCAFFOLDING_BYTES + total(survivors, withGeometry)) +
    (hasImage ? policy.imageTokens : 0);

  // 1. Geometry, whose only consumer is a model correlating refs to pixels.
  if (tokensNow() > policy.maxPromptTokens && withGeometry) {
    withGeometry = false;
    geometryOmitted = true;
  }

  /*
   * 2. THE SCREENSHOT, before any element.
   *
   * An image is a flat ~1200 tokens; an element is roughly 15. Dropping the
   * picture buys back what eighty elements would, and the benchmark measured
   * screenshot-on and screenshot-off scoring identically. Losing eighty
   * elements to keep one image is the wrong trade every time.
   */
  if (tokensNow() > policy.maxPromptTokens && hasImage) {
    hasImage = false;
    screenshotDropped = true;
  }

  /*
   * Sorted by rank ASCENDING to choose victims, but the survivors are put back
   * into their original order afterwards. The ordinal in `ref` is never touched
   * either way - it was minted over the full walk and stays attached to its
   * element.
   */
  const order = survivors.map((el, i) => ({ el, i, rank: rankElement(el, opts.goalTerms, opts.viewport) }));
  const victims = [...order].sort((a, b) => (a.rank === b.rank ? b.i - a.i : a.rank - b.rank));

  const removed = new Set<number>();
  let bytes = SCAFFOLDING_BYTES + total(survivors, withGeometry);
  const imageCost = hasImage ? policy.imageTokens : 0;
  for (const v of victims) {
    if (textTokens(bytes) + imageCost <= policy.maxPromptTokens) break;
    if (survivors.length - removed.size <= policy.minElements) break;
    removed.add(v.i);
    bytes -= sizeOf(v.el, withGeometry);
  }

  const kept = order.filter((o) => !removed.has(o.i)).map((o) => o.el);
  const dropped = order
    .filter((o) => removed.has(o.i))
    .map((o) => ({ ref: String(o.el.ref), role: o.el.role }));

  return {
    kept,
    report: {
      available: all.length,
      sent: kept.length,
      estimatedTokens: textTokens(bytes) + imageCost,
      tokenBudget: policy.maxPromptTokens,
      dropped,
      namesTruncated,
      geometryOmitted,
      screenshotDropped,
      duplicatesCollapsed,
    },
  };
}
