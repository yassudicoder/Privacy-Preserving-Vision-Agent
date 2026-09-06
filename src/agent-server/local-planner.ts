import type { SanitizedContext, SanitizedElement } from '@/contracts/index.ts';
import { TEXT_ROLES, goalTerms, hasEnteredText, textIntent } from './text-intent.ts';
import {
  type AgentClient,
  type PlanOutcome,
  type PlanRequest,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
} from './protocol.ts';

/**
 * An `AgentClient` that plans on-device, with no server and no network.
 *
 * WHY THIS EXISTS. The agent loop cannot be demonstrated or tested end to end
 * without something that answers `plan()`, and the real answer is a VLM behind a
 * server that does not exist yet. This is the floor: it makes the whole
 * pipeline - capture, detect, redact, sanitize, plan, parse, validate, execute -
 * runnable today, on one machine, with nothing leaving it.
 *
 * WHY THE LOGIC IS DUPLICATED FROM `server/planner.ts` RATHER THAN IMPORTED.
 * `agent-server/server/**` must never be imported by an extension context, and
 * `tests/architecture/boundaries.test.ts` enforces it. That pin was probed while
 * writing this file and found to catch `@/agent-server/server/planner.ts` but
 * NOT the relative `./server/planner.ts` that this file could have used; the pin
 * has since been fixed to resolve specifiers rather than substring-match them.
 * Even with a working pin the duplication is right: these two are MEANT to
 * diverge. The server copy becomes the VLM adapter. This copy stays a
 * dependency-free baseline, and a baseline that drifts with the thing it is
 * measuring is not a baseline.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not return a typed `Action`.
 * `PlanOutcome` carries `raw: string`, and `runAgentStep` runs `parseAction` and
 * `validateAction` over it exactly as it would over bytes from a hostile server.
 * Handing back a pre-built Action would be easy and would quietly delete the
 * runtime backstop for the local path - so the local path speaks the same wire
 * format and submits to the same checks.
 */

/** How the planner picked what it picked. Surfaced so a demo is legible. */
export interface LocalPlanTrace {
  readonly consideredElements: number;
  readonly chosenRef: string | null;
  readonly score: number;
  readonly reason: string;
}

export interface LocalPlannerOptions {
  /** Injected for tests. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** Called with the reasoning behind each plan. Optional. */
  readonly onTrace?: (trace: LocalPlanTrace) => void;
}

/** Roles this baseline is willing to CLICK. */
const ACTIONABLE = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio']);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * The text-entry branch, tried before any click.
 *
 * A goal like "search for laptop" is unsatisfiable by clicking: the field has to
 * be filled first. Before this existed the baseline would click a submit button
 * with the box still empty, report a successful action, and change nothing -
 * which is exactly what the pipeline was observed doing on a real page.
 *
 * `submit: true` is what completes the task in ONE action:
 * `executeAction` calls `form.requestSubmit()`, which needs no focus and no
 * synthetic keyboard event.
 */
function typeAction(ctx: SanitizedContext, tried: ReadonlySet<string>): string | null {
  const intent = textIntent(ctx.goal);
  if (intent === null) return null;

  /*
   * Once, and only once. Without this the baseline types the goal text into
   * every text field on the page in turn - measured: it filled a payment form's
   * expiry date and posted a product review, both with the search query.
   */
  if (hasEnteredText(ctx.history)) return null;

  const field = ctx.elements.find(
    (el) =>
      TEXT_ROLES.has(el.role) &&
      // Never type into something the redactor marked sensitive. A baseline
      // cannot judge whether a password box is safe, and it does not get to.
      !el.isSensitive &&
      !el.states.includes('disabled') &&
      !el.states.includes('readonly') &&
      !tried.has(String(el.ref)),
  );
  if (field === undefined) return null;

  return JSON.stringify({
    type: 'type',
    ref: String(field.ref),
    text: intent.text,
    submit: true,
    rationale: 'goal names text to enter and the page has a field for it',
  });
}

/**
 * Overlap between an element's accessible name and the goal.
 *
 * Deliberately crude. The point is a floor the VLM must beat, not a clever
 * heuristic that makes the comparison flattering.
 */
function score(el: SanitizedElement, goalWords: ReadonlySet<string>): number {
  const name = el.name?.text ?? '';
  const groupName = el.groupName?.text ?? '';
  if (name === '') return 0;
  let hits = 0;
  for (const w of words(name)) {
    if (goalWords.has(w)) hits += 1;
  }
  for (const w of words(groupName)) {
    if (goalWords.has(w)) hits += 2;
  }
  return hits;
}

/**
 * Refs this run has already acted on.
 *
 * Without this the baseline clicks the same best-matching button forever: the
 * page changes, the element keeps the best name, it wins again. A loop that
 * cannot make progress is worse than no loop for judging the pipeline, because
 * it looks like it is working.
 */
function alreadyTried(ctx: SanitizedContext): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const step of ctx.history) {
    if (step.ref !== null) seen.add(String(step.ref));
  }
  return seen;
}

export class LocalPlannerClient implements AgentClient {
  readonly modelId = 'local-heuristic-baseline';

  readonly #now: () => number;
  readonly #onTrace: ((trace: LocalPlanTrace) => void) | undefined;

  constructor(options: LocalPlannerOptions = {}) {
    this.#now = options.now ?? ((): number => performance.now());
    this.#onTrace = options.onTrace;
  }

  plan(request: PlanRequest, signal: AbortSignal): Promise<PlanOutcome> {
    const started = this.#now();

    if (signal.aborted) {
      // Retryable: the caller gave up, the planner did not fail.
      return Promise.resolve({
        ok: false,
        error: { protocolVersion: PROTOCOL_VERSION, error: 'aborted', retryable: true },
      });
    }

    /*
     * The size guard runs on the local path too. It costs nothing here, but it
     * means an oversize context is caught in development rather than on the
     * first day a real server is wired in - the local path should exercise the
     * same rails, not a shortcut around them.
     */
    const bytes = JSON.stringify(request.context).length;
    if (bytes > MAX_REQUEST_BYTES) {
      return Promise.resolve({
        ok: false,
        error: {
          protocolVersion: PROTOCOL_VERSION,
          error: `context is ${bytes} bytes, over the ${MAX_REQUEST_BYTES} limit`,
          retryable: false,
        },
      });
    }

    const ctx = request.context;
    // Stopwords removed: "for" is three characters, so a plain length filter
    // kept it, and it then scored a hit against any element name containing it.
    const goalWords = goalTerms(ctx.goal);
    const tried = alreadyTried(ctx);

    /*
     * TEXT ENTRY FIRST. When the goal names text to enter and the page has a
     * field for it, filling that field is the action - clicking anything else is
     * at best premature.
     */
    /*
     * A goal that named text to enter, and the text has been entered. There is
     * nothing further this baseline can infer, and clicking on afterwards is how
     * it ended up filling unrelated forms.
     */
    if (textIntent(ctx.goal) !== null && hasEnteredText(ctx.history)) {
      this.#onTrace?.({
        consideredElements: ctx.elements.length,
        chosenRef: null,
        score: 0,
        reason: 'text entered and submitted',
      });
      return Promise.resolve({
        ok: true,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          raw: JSON.stringify({ type: 'done', summary: 'text entered and submitted' }),
          modelId: this.modelId,
          serverMs: this.#now() - started,
        },
      });
    }

    const typed = typeAction(ctx, tried);
    if (typed !== null) {
      this.#onTrace?.({
        consideredElements: ctx.elements.length,
        chosenRef: (JSON.parse(typed) as { ref: string }).ref,
        score: 1,
        reason: 'goal names text to enter',
      });
      return Promise.resolve({
        ok: true,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          raw: typed,
          modelId: this.modelId,
          serverMs: this.#now() - started,
        },
      });
    }

    /*
     * The best score this run has ALREADY acted on.
     *
     * Without it the baseline works down the list: for "Open Laptop Pro" it
     * clicked Laptop Pro's View Details (scoring on both words), then Gaming
     * Laptop's (scoring on one), then three more - five products opened for a
     * goal naming one. The per-ref dedup does not help, because each is a
     * different ref.
     *
     * A candidate that scores WORSE than something already clicked is not
     * progress, and this baseline has no way to tell whether more clicking helps.
     * So it only acts on a strict improvement, and otherwise reports done.
     */
    let bestActed = 0;
    for (const el of ctx.elements) {
      if (tried.has(String(el.ref))) bestActed = Math.max(bestActed, score(el, goalWords));
    }

    let best: { ref: string; score: number } | null = null;
    let considered = 0;

    for (const el of ctx.elements) {
      if (!ACTIONABLE.has(el.role)) continue;
      /*
       * Sensitive elements are skipped outright. This baseline has no way to
       * know whether typing into a redacted field is safe, and the project's
       * position is that an unattended agent does not get to decide that.
       */
      if (el.isSensitive) continue;
      if (el.states.includes('disabled')) continue;
      considered += 1;
      if (tried.has(String(el.ref))) continue;

      const s = score(el, goalWords);
      if (s === 0) continue;
      // Strictly better than anything already acted on, or it is not progress.
      if (s <= bestActed) continue;
      if (best === null || s > best.score) best = { ref: String(el.ref), score: s };
    }

    const trace: LocalPlanTrace =
      best === null
        ? {
            consideredElements: considered,
            chosenRef: null,
            score: 0,
            reason:
              considered === 0
                ? 'no actionable, non-sensitive elements in the context'
                : 'no untried element name overlapped the goal',
          }
        : {
            consideredElements: considered,
            chosenRef: best.ref,
            score: best.score,
            reason: `name overlaps the goal on ${best.score} word(s)`,
          };
    this.#onTrace?.(trace);

    /*
     * EXACTLY ONE balanced JSON object. `parseAction` rejects a string
     * containing more than one, so the rationale has to be a key inside the
     * action rather than a second object beside it.
     */
    const raw =
      best === null
        ? JSON.stringify({ type: 'done', summary: trace.reason })
        : JSON.stringify({
            type: 'click',
            ref: best.ref,
            rationale: trace.reason,
            confidence: Math.min(1, best.score / 3),
          });

    return Promise.resolve({
      ok: true,
      response: {
        protocolVersion: PROTOCOL_VERSION,
        raw,
        modelId: this.modelId,
        serverMs: this.#now() - started,
      },
    });
  }
}
