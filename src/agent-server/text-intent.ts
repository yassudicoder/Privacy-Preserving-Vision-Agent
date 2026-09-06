/**
 * Reading a text-entry intent out of a user goal.
 *
 * WHY THIS EXISTS. Both baseline planners could emit only `click` or `done`,
 * and their candidate filters admitted only `button`/`link`. A goal like
 * "search for laptop" was therefore unsatisfiable in principle: the search field
 * WAS in the sanitized context (`searchbox` is in `INTERESTING_ROLES`), the
 * whole pipeline ran, and the planner discarded the one element the task needed.
 * The best it could do was click a submit button with the field still empty,
 * which reports as a successful action and changes nothing on the page.
 *
 * WHAT THIS IS NOT. It is not an understanding of the goal, and it is not
 * hardcoded to any particular task - "laptop" appears nowhere in this file. It
 * strips a leading imperative and treats the remainder as the text to enter.
 * That is a BASELINE: a floor the VLM must beat, and the thing that makes the
 * pipeline demonstrable without one.
 *
 * SHARED between the client baseline and the server baseline, which are
 * otherwise deliberately duplicated. This half is a pure string function with no
 * planner state, so a single copy cannot drift into a boundary violation.
 */

/**
 * Verbs that mean "put this text somewhere".
 *
 * Ordered longest-first where prefixes overlap, so "look up" wins over "look".
 */
const ENTRY_VERBS = [
  'search for',
  'search',
  'look up',
  'look for',
  'find',
  'type',
  'enter',
  'query',
  'fill in',
  'fill',
];

/**
 * Words too common to indicate anything.
 *
 * Without this, "for" (three characters, so it survives a length filter) scores
 * a hit against any element whose name happens to contain it. Measured on a real
 * page: goal "search for laptop" scored a news headline ending "...Depart For?"
 * as highly as the search button, and the headline won because it came first.
 */
export const STOPWORDS = new Set([
  'for',
  'the',
  'and',
  'with',
  'your',
  'you',
  'into',
  'this',
  'that',
  'from',
  'all',
  'any',
  'get',
  'set',
  'new',
]);

/** Goal words worth scoring against: long enough, and not a stopword. */
export function goalTerms(goal: string): Set<string> {
  return new Set(
    goal
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export interface TextIntent {
  /** The text to enter. Never empty. */
  readonly text: string;
}

/**
 * Reads "search for laptop" as "put `laptop` in a field".
 *
 * Returns null when the goal names no entry verb, or names one with nothing
 * after it - "search" alone says what to do and not what to type, and inventing
 * a query would be worse than declining.
 */
export function textIntent(goal: string): TextIntent | null {
  const trimmed = goal.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();

  for (const verb of ENTRY_VERBS) {
    if (!lower.startsWith(verb)) continue;
    const rest = trimmed.slice(verb.length).trim();
    // Strip a connective the verb list did not already absorb: "search: laptop",
    // "find me laptops".
    const text = rest.replace(/^(for|me|a|an|the|:)\s+/i, '').replace(/^["']|["']$/g, '').trim();
    if (text === '') return null;
    return { text };
  }
  return null;
}

/** Roles that hold typed text. */
export const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * Whether this run has already entered text successfully.
 *
 * ONE TEXT ENTRY PER GOAL. The per-ref dedup is not enough: having typed into
 * the search box, the baseline would find the NEXT untried text field and type
 * into that one too. Observed on a real page - "search for laptop" typed
 * `laptop` into the search box (correctly, and the search ran), then into a
 * payment form's EXPIRY DATE field, then posted it as a product review, then
 * spent its remaining budget clicking.
 *
 * That is not untidy, it is harmful: an agent that sprays the goal text into
 * every field it can reach will eventually reach one that matters. A goal naming
 * text to enter is satisfied by entering it once.
 */
export function hasEnteredText(
  history: readonly { readonly actionType: string; readonly ok: boolean }[],
): boolean {
  return history.some((h) => h.actionType === 'type' && h.ok);
}

