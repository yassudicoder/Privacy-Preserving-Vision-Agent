import type { SanitizedElement } from './context.ts';

/**
 * Is the goal under-specified for this page?
 *
 * WHY THIS IS NOT THE MODEL'S JOB. `ask_user` is plumbed end to end and the
 * prompt tells the model, in a rule and again in a closing line, to ask when the
 * goal is ambiguous. Measured against qwen2.5vl at temperature 0, on a page
 * carrying both "Add Laptop Pro to cart" and "Add Gaming Laptop to cart", with
 * the goal "add a laptop to the cart":
 *
 *   rule in the RULES block  -> {"type":"type","ref":"e14","text":"Add Laptop Pro..."}
 *   same instruction at the END -> identical
 *
 * It picks the first candidate and proceeds. Two placements, no difference. A 3B
 * model does not volunteer a question, and this project has already spent three
 * rounds learning that more prose is not the lever.
 *
 * So the detection is deterministic and runs on the client, where it needs no
 * model at all. That also puts it on the right side of the trust boundary: the
 * question is composed from the page's own accessible names, which the user is
 * about to be shown, and never from anything a server said.
 *
 * DELIBERATELY NARROW. A question the user did not need is worse than none - it
 * turns a working agent into a nag. It fires only when a goal term matches
 * SEVERAL DISTINCTLY NAMED candidates of the same role and nothing in the goal
 * picks between them.
 */

/** Words too common to distinguish anything. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'to', 'in', 'on', 'at', 'for', 'of', 'and', 'or', 'my',
  'me', 'i', 'it', 'this', 'that', 'with', 'from', 'into', 'please', 'go',
  'add', 'open', 'click', 'find', 'get', 'set', 'make', 'do', 'want', 'need',
  'buy', 'book', 'search', 'select', 'choose', 'show',
]);

/**
 * Roles a disambiguation is worth asking about.
 *
 * A heading is not something the agent acts on, so two headings sharing a word
 * are not a choice the user has to make - and a question naming them cannot be
 * used to narrow anything. A real run asked "Laptop Pro, or Gaming Laptop?"
 * because those are the HEADINGS; the buttons are called "Add Laptop Pro to
 * cart", the answer matched neither, and nothing was narrowed.
 *
 * Asking about what can be clicked keeps the question and the remedy in the same
 * vocabulary.
 */
const ACTIONABLE: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'listbox',
]);

export interface AmbiguityFinding {
  /** The goal word that matched several things. */
  readonly term: string;
  /** The distinct candidate names, in document order. */
  readonly candidates: readonly string[];
  /** A question naming the choice, ready to show the user. */
  readonly question: string;
}

export interface AmbiguityOptions {
  /** How many distinct candidates count as a choice. Two is a choice. */
  readonly minCandidates?: number;
  /** Above this many, the goal is a search rather than a selection. */
  readonly maxCandidates?: number;
}

const DEFAULT_MIN = 2;

/**
 * Above this, asking is the wrong move.
 *
 * "search for laptop" on a results page of forty laptops is not an ambiguous
 * goal, it is a goal about forty things - and a question listing forty options
 * is not a question. The narrow case this catches is a handful of near-identical
 * choices, which is where a wrong guess is both likely and expensive.
 */
const DEFAULT_MAX = 4;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Returns the one finding worth asking about, or null.
 *
 * One, not a list: the loop can carry a single question per step, and a user
 * facing three at once will answer none of them well.
 */
export function detectAmbiguity(
  goal: string,
  elements: readonly SanitizedElement[],
  options: AmbiguityOptions = {},
): AmbiguityFinding | null {
  const min = options.minCandidates ?? DEFAULT_MIN;
  const max = options.maxCandidates ?? DEFAULT_MAX;
  const terms = words(goal);
  if (terms.length === 0) return null;

  /*
   * IF ANY PART OF THE GOAL IS ABSENT FROM THE PAGE, THERE IS NOTHING TO
   * DISAMBIGUATE.
   *
   * A real run on amazon.in, goal "add macbook pro to cart", produced:
   *
   *   Which one did you mean - Cart, shift, alt, c, or 0 items in cart?
   *
   * `macbook` matched nothing - the homepage has no MacBook - so the loop fell
   * through to `cart`, which appears all over the nav, and asked about the cart
   * link and the cart counter. No answer to that question helps.
   *
   * The user named something the page does not contain. That is not an
   * ambiguity, it is a page the agent has not navigated to yet, and the right
   * move is to go and find it. Asking about whatever incidental word DID match
   * is worse than silence: it stops the task to pose a question with no useful
   * answer.
   *
   * Cheap and total - one pass over the actionable names.
   */
  const pageWords = new Set<string>();
  for (const el of elements) {
    if (!ACTIONABLE.has(el.role)) continue;
    for (const w of words(el.name?.text ?? '')) pageWords.add(w);
  }
  if (terms.some((t) => !pageWords.has(t))) return null;

  for (const term of terms) {
    /*
     * Grouped by ROLE as well as name. Two buttons called different things are
     * a choice; a button and a heading that happen to share a word are not - the
     * heading is not something the agent would act on.
     */
    const byRole = new Map<string, Map<string, true>>();
    for (const el of elements) {
      if (!ACTIONABLE.has(el.role)) continue;
      const name = (el.name?.text ?? '').trim();
      if (name === '') continue;
      if (!words(name).includes(term)) continue;
      const group = byRole.get(el.role) ?? new Map<string, true>();
      group.set(name, true);
      byRole.set(el.role, group);
    }

    for (const [, names] of byRole) {
      /*
       * Only the candidates that match the GOAL best.
       *
       * A real run asked "View details for Laptop Pro, or Add Laptop Pro to
       * cart, or View details for Gaming Laptop, or Add Gaming Laptop to cart?"
       * - four options across two different actions, when the goal said "add
       * ... to cart" and only two of them do that. The extra pair made the
       * question unreadable AND made the answer ambiguous, because "Gaming
       * Laptop" then matched two candidates equally.
       *
       * Scoring by shared goal words keeps the choice on the axis the user is
       * actually being asked about.
       */
      const all = [...names.keys()];
      const scoredByGoal = all.map((n) => ({
        n,
        hits: words(n).filter((w) => terms.includes(w)).length,
      }));
      const bestGoal = Math.max(...scoredByGoal.map((x) => x.hits));
      const distinct = scoredByGoal.filter((x) => x.hits === bestGoal).map((x) => x.n);
      if (distinct.length < min || distinct.length > max) continue;

      /*
       * Does the goal already pick one?
       *
       * The test is whether some goal word appears in exactly ONE candidate -
       * not whether each candidate shares SOME word with the goal. "add laptop
       * pro to cart" against "Add Laptop Pro to cart" and "Add Gaming Laptop to
       * cart": both contain `cart`, so a looser check calls both decided and
       * asks anyway. `pro` is the word that actually decides, because only one
       * candidate has it.
       */
      const decisive = terms.some((t) => {
        if (t === term) return false;
        const holders = distinct.filter((n) => words(n).includes(t));
        return holders.length === 1;
      });
      if (decisive) continue;

      return {
        term,
        candidates: distinct,
        question:
          `Which one did you mean - ${distinct.slice(0, max).join(', or ')}?`,
      };
    }
  }

  return null;
}

/**
 * Remove the candidates the user did NOT choose.
 *
 * WHY THIS IS NOT DONE BY TELLING THE MODEL. The answer reaches the prompt - a
 * probe confirmed the ANSWERS block is present - and qwen2.5vl at temperature 0
 * returns the identical action either way:
 *
 *   answered "Gaming Laptop" -> {"type":"type","ref":"e14","text":"Laptop Pro"}
 *   answered "Laptop Pro"    -> {"type":"type","ref":"e14","text":"Laptop Pro"}
 *
 * A conversation whose answer changes nothing is worse than no conversation: it
 * looks like it works. So the answer CONSTRAINS rather than instructs, which is
 * the same principle the ref allowlist already rests on - the model may only
 * address elements we sent it, so the way to stop it choosing wrongly is not to
 * send the wrong ones.
 *
 * NARROW BY CONSTRUCTION. It only ever removes siblings of a group the user was
 * actually asked about, and only when the answer names exactly one of them. An
 * answer that matches none, or several, leaves the page untouched - guessing
 * which one was meant is how a clarification turns into a wrong click with the
 * user's own words as cover.
 */
export function narrowByClarification(
  elements: readonly SanitizedElement[],
  clarifications: readonly {
    readonly question: string;
    readonly answer: string;
    readonly candidates?: readonly string[];
  }[],
  goal: string,
  options: AmbiguityOptions = {},
): readonly SanitizedElement[] {
  let current = elements;

  for (const c of clarifications) {
    /*
     * The group is recovered from the GOAL, because `detectAmbiguity` is
     * deterministic - the same goal over the same page yields the same
     * candidates that produced the question in the first place.
     *
     * Not from the question's TEXT: that failed on the first real run, where the
     * question named "Laptop Pro" while the button is "Add Laptop Pro to cart",
     * so the answer matched no element and nothing was narrowed. Recorded
     * candidates are honoured when a caller has them; the goal is what makes it
     * work without plumbing them through every layer.
     */
    const finding: AmbiguityFinding | null =
      c.candidates !== undefined && c.candidates.length > 1
        ? { term: '', candidates: c.candidates, question: c.question }
        : (detectAmbiguity(goal, current, options) ?? findGroup(current, c, options));
    if (finding === null) continue;

    const answer = words(c.answer);
    if (answer.length === 0) continue;

    /*
     * Matched on DISTINCTIVE words - the ones that actually separate the
     * candidates - not on raw overlap.
     *
     * Every candidate in a group shares the goal term by construction, so
     * counting raw hits gives "Gaming Laptop" a point for `laptop` against all
     * of them. What distinguishes "Add Gaming Laptop to cart" from "Add Laptop
     * Pro to cart" is `gaming` versus `pro`, and those are the words an answer
     * has to speak to.
     */
    const wordSets = finding.candidates.map((n) => words(n));
    const common = new Set(
      (wordSets[0] ?? []).filter((w) => wordSets.every((ws) => ws.includes(w))),
    );
    const kept = finding.candidates.filter((_name, i) => {
      const distinctive = (wordSets[i] ?? []).filter((w) => !common.has(w));
      return distinctive.some((w) => answer.includes(w));
    });

    // No candidate spoken to, or all of them: the answer did not choose, and
    // guessing which was meant is how a clarification becomes a wrong click
    // wearing the user's own words.
    if (kept.length === 0 || kept.length === finding.candidates.length) continue;

    const keepSet = new Set(kept);
    const losers = new Set(finding.candidates.filter((n) => !keepSet.has(n)));
    // A FILTER, never a renumbering - the same rule the budget follows, and for
    // the same reason: `extractRefPaths` walks the unfiltered document.
    current = current.filter((el) => !losers.has((el.name?.text ?? '').trim()));
  }

  return current;
}

/**
 * Recovers the candidate group from a question already asked.
 *
 * `detectAmbiguity` is keyed on the GOAL; here the text to hand is the question,
 * which names the candidates directly. Reading them back out of it means a
 * clarification keeps working after the page shifts under it.
 */
function findGroup(
  elements: readonly SanitizedElement[],
  c: { readonly question: string },
  options: AmbiguityOptions,
): AmbiguityFinding | null {
  const max = options.maxCandidates ?? DEFAULT_MAX;
  const named = elements
    .map((el) => (el.name?.text ?? '').trim())
    .filter((n) => n !== '' && c.question.includes(n));
  const distinct = [...new Set(named)];
  if (distinct.length < 2 || distinct.length > max) return null;
  return { term: '', candidates: distinct, question: c.question };
}
