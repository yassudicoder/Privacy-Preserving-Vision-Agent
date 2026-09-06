import type { SanitizedContext } from '@/contracts/index.ts';
import { TEXT_ROLES, goalTerms, hasEnteredText, textIntent } from '../text-intent.ts';

/**
 * Server-side planning.
 *
 * No model is loaded in this scaffold - the brief is explicit that the server is
 * out of scope for this session. What exists is the interface the real VLM
 * adapter will implement, plus two planners with no dependencies so the harness
 * can run a full end-to-end loop today and measure latency against a known
 * baseline tomorrow.
 */

export interface Planner {
  readonly id: string;
  /**
   * `correction` is set only on a RE-PLAN, after this client refused the
   * planner's previous reply. Baseline planners may ignore it; a model-backed
   * one should show it to the model.
   */
  plan(ctx: SanitizedContext, correction?: string): Promise<{ raw: string; serverMs: number }>;
}

/** Replays a fixed script. What fixture-driven end-to-end tests run against. */
export class ScriptedPlanner implements Planner {
  readonly id = 'scripted';
  #step = 0;
  readonly #script: readonly string[];

  constructor(script: readonly string[]) {
    this.#script = script;
  }

  plan(ctx: SanitizedContext): Promise<{ raw: string; serverMs: number }> {
    void ctx;
    const raw = this.#script[this.#step] ?? '{"type":"done","summary":"script exhausted"}';
    this.#step += 1;
    return Promise.resolve({ raw, serverMs: 0 });
  }

  reset(): void {
    this.#step = 0;
  }
}

/**
 * A dependency-free baseline: pick the interactive element whose accessible name
 * best overlaps the goal, then click it.
 *
 * Not intelligence - a floor. When the real VLM lands, anything it does worse
 * than this is a regression, and that is a more useful bar than "it responded".
 */
export class HeuristicPlanner implements Planner {
  readonly id = 'heuristic-baseline';

  plan(ctx: SanitizedContext): Promise<{ raw: string; serverMs: number }> {
    const started = performance.now();
    /*
     * Stopwords removed. Measured on a real page: with a plain length filter,
     * "for" survived and the goal "search for laptop" scored a news headline
     * ending "...Depart For?" as highly as the search button - and the headline
     * won, because the loop takes the first element to reach the best score.
     */
    const goalWords = goalTerms(ctx.goal);

    /*
     * TEXT ENTRY FIRST, mirroring LocalPlannerClient. Neither baseline could
     * emit a `type` action at all, so a goal naming text to enter was
     * unsatisfiable in principle: the field was in the context and both planners
     * filtered it out by role, leaving a click on an empty form as the best
     * available move.
     */
    const intent = textIntent(ctx.goal);
    if (intent !== null && hasEnteredText(ctx.history)) {
      /*
       * Entered once, and that is the goal met as far as this baseline can tell.
       * Falling through to the click scan is what let it fill a payment form's
       * expiry date and post a product review with the search query.
       */
      return Promise.resolve({
        raw: '{"type":"done","summary":"text entered and submitted"}',
        serverMs: performance.now() - started,
      });
    }
    if (intent !== null) {
      const tried = new Set(ctx.history.filter((h) => h.ref !== null).map((h) => String(h.ref)));
      const field = ctx.elements.find(
        (el) =>
          TEXT_ROLES.has(el.role) &&
          !el.isSensitive &&
          !el.states.includes('disabled') &&
          !el.states.includes('readonly') &&
          !tried.has(String(el.ref)),
      );
      if (field !== undefined) {
        return Promise.resolve({
          raw: JSON.stringify({
            type: 'type',
            ref: String(field.ref),
            text: intent.text,
            submit: true,
            rationale: 'goal names text to enter and the page has a field for it',
          }),
          serverMs: performance.now() - started,
        });
      }
    }

    /*
     * The already-tried set, which this copy was missing while its client twin
     * had it. Without it a multi-step run re-clicks the same best-matching
     * element forever: the page changes, that element keeps the best name, it
     * wins again.
     */
    const triedRefs = new Set(ctx.history.filter((h) => h.ref !== null).map((h) => String(h.ref)));

    /*
     * The best score already acted on. A candidate that scores worse is not
     * progress - see the local planner for the measurement that motivated this:
     * "Open Laptop Pro" opened five different products.
     */
    let bestActed = 0;
    for (const el of ctx.elements) {
      if (triedRefs.has(String(el.ref))) {
        const name = (el.name?.text ?? '').toLowerCase();
        let hits = 0;
        for (const w of name.split(/[^a-z0-9]+/)) if (goalWords.has(w)) hits += 1;
        bestActed = Math.max(bestActed, hits);
      }
    }

    let best: { ref: string; score: number } | null = null;
    for (const el of ctx.elements) {
      if (el.role !== 'button' && el.role !== 'link') continue;
      if (el.isSensitive) continue;
      if (el.states.includes('disabled')) continue;
      if (triedRefs.has(String(el.ref))) continue;
      const name = (el.name?.text ?? '').toLowerCase();
      if (name === '') continue;
      let score = 0;
      for (const w of name.split(/[^a-z0-9]+/)) {
        if (goalWords.has(w)) score += 1;
      }
      if (score <= bestActed) continue;
      if (best === null || score > best.score) best = { ref: String(el.ref), score };
    }

    const raw =
      best === null || best.score === 0
        ? '{"type":"done","summary":"no element matched the goal"}'
        : JSON.stringify({
            type: 'click',
            ref: best.ref,
            rationale: 'name overlaps the goal',
            confidence: Math.min(1, best.score / 3),
          });

    return Promise.resolve({ raw, serverMs: performance.now() - started });
  }
}
