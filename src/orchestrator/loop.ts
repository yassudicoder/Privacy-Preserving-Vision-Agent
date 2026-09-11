import type { Action } from '@/contracts/index.ts';
import { type StepDeps, type StepInput, type StepResult, resetVisionBreaker, runAgentStep } from './step.ts';

/**
 * The agent loop.
 *
 * WHAT WAS THERE BEFORE: nothing. `runAgentStep` was called exactly once per
 * click of a "Run one step" button, and nothing scheduled a second call. A
 * single step cannot complete most tasks - "search for laptop" needs a type and
 * then, usually, a look at what came back - so the prototype could demonstrate a
 * pipeline but not an agent.
 *
 * WHY IT IS BOUNDED AND STOPPABLE BY DEFAULT. This thing clicks and types on a
 * real page on the user's behalf. An unbounded loop driven by a heuristic that
 * cannot tell success from failure is not a demo, it is a way to submit a form
 * forty times. Every exit below is a deliberate stop condition, and `maxSteps`
 * is a hard ceiling that applies even when every one of them is somehow missed.
 */

/** Why the loop stopped. Every one of these is reported to the panel. */
export type StopReason =
  /** The planner said the goal is met. The only "success" ending. */
  | 'done'
  /** The planner declined to continue. */
  | 'abort'
  /** The planner wants the user. Nothing here can answer, so the loop ends. */
  | 'ask_user'
  /** A step failed. Distinguish from `done`: the task did NOT complete. */
  | 'error'
  /** The step ceiling. */
  | 'max-steps'
  /** The caller asked it to stop. */
  | 'cancelled'
  /**
   * Nothing changed twice running.
   *
   * A heuristic planner that cannot see the effect of its own action will happily
   * re-emit it. Without this the loop burns its whole budget on the same click.
   */
  | 'no-progress'
  /**
   * The same action on the same element, over and over.
   *
   * Distinct from `no-progress`, and needed because that one could not see this:
   * the page CHANGED every step. Asked to add a product to a cart, a model
   * clicked the same button on all eight steps and the cart counter went up each
   * time, so the fingerprint kept differing. It reached 10 items and only
   * `max-steps` stopped it. On a real store that is an order.
   */
  | 'repeating';

export interface LoopResult {
  readonly reason: StopReason;
  readonly steps: number;
  /** The last action planned, if any. Null when the loop never got that far. */
  readonly lastAction: Action | null;
  readonly error: string | null;
  /**
   * Actions that actually touched the page, excluding the terminal one.
   *
   * `done` means the MODEL believes the goal is met, and on a real Amazon run it
   * said so on step 1 having done nothing at all - the page had no MacBook on
   * it, there was no obvious move, and it declared success. The panel then said
   * "Done."
   *
   * A task that completes without a single action is not necessarily wrong - "am
   * I signed in?" can be answered by looking - but it is a different outcome
   * from one that acted, and reporting them identically is the panel asserting
   * something it does not know. The caller decides how to say so; the loop just
   * refuses to hide it.
   */
  readonly actionsTaken: number;
}

export interface LoopOptions {
  /**
   * Hard ceiling. Low on purpose - a baseline that has not finished in this many
   * steps is not about to, and every extra step is another real interaction with
   * someone's page.
   */
  readonly maxSteps?: number;
  /**
   * Consecutive steps with no observable change before giving up.
   *
   * Two, not one: a step can legitimately produce no visible change (a focus, a
   * scroll that was already at the bottom) and still be on the right track.
   */
  readonly maxStallSteps?: number;
  /**
   * How many times the identical action may be planned in a row.
   *
   * Two, so one retry is allowed - a click that missed is worth repeating once -
   * and a third identical plan is treated as a stuck agent.
   */
  readonly maxRepeats?: number;
  /** Checked between steps. Lets the panel's Stop button end the run. */
  readonly shouldStop?: () => boolean;
  /** Between steps, so a fast loop does not hammer the page. */
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_STALL = 2;
const DEFAULT_MAX_REPEATS = 2;
/**
 * `captureVisibleTab` is quota-limited to 2/second, so a step already costs at
 * least 500 ms. This is about giving the PAGE time to react - a submitted search
 * has to navigate before the next snapshot is worth taking.
 */
const DEFAULT_DELAY_MS = 600;

/** What the loop needs beyond a single step. */
export interface LoopDeps extends StepDeps {
  /**
   * A cheap signal of whether the page changed.
   *
   * Injected rather than derived from the step: the honest source is the live
   * document, and this module must not touch one. The background passes a
   * content-script call; tests pass a counter.
   */
  readonly pageFingerprint?: (tabId: number) => Promise<string>;
  /**
   * Resolves once the tab has finished whatever the action started - a click
   * that began a navigation, a submitted search. Injected for the same reason
   * `pageFingerprint` is: the honest source is the browser, and this module
   * must not touch it. When present it replaces the fixed between-step delay.
   */
  readonly settle?: (tabId: number) => Promise<void>;
}

/** Terminal action types: the planner is telling the loop to stop. */
function terminalReason(action: Action | null): StopReason | null {
  if (action === null) return null;
  if (action.type === 'done') return 'done';
  if (action.type === 'abort') return 'abort';
  if (action.type === 'ask_user') return 'ask_user';
  return null;
}

/**
 * Runs steps until something says stop.
 *
 * `input.step` and `input.history` are advanced here rather than by the caller,
 * because the planner's loop-breaker reads history and a caller that forgot to
 * append would silently get an agent that repeats itself.
 */
export async function runAgentLoop(
  deps: LoopDeps,
  input: StepInput,
  options: LoopOptions = {},
): Promise<LoopResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxStall = options.maxStallSteps ?? DEFAULT_MAX_STALL;
  const maxRepeats = options.maxRepeats ?? DEFAULT_MAX_REPEATS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const emit = deps.emit ?? ((): void => {});

  /*
   * A NEW TASK GETS A FRESH LOOK AT THE ENVIRONMENT.
   *
   * The vision breaker is module-level and latches after three consecutive
   * failures. Until this call it had NO reachable reset anywhere in the product
   * - `resetVisionBreaker` was exported, documented as running on model load,
   * and never invoked - so once it tripped, every later step in the worker's
   * life silently skipped vision while still reporting ok. That zeroes the
   * vision half of metric 1 (25%) without any surface saying so.
   *
   * Task start is the honest trigger: it is a deliberate user action, and it is
   * the moment the thing the breaker actually tracks - a contended GPU - is most
   * likely to have changed. Single-step runs deliberately keep the latch; the
   * breaker is about not repaying a cost that is not buying anything, and
   * pressing the button repeatedly is one continuous attempt.
   */
  resetVisionBreaker();

  const history = [...(input.history ?? [])];
  let lastAction: Action | null = null;
  let stalls = 0;
  let previousFingerprint: string | null = null;
  let steps = 0;
  /**
   * How many times running the identical action has been planned.
   *
   * Keyed on type AND ref, so clicking two different buttons is progress and
   * clicking one button twice is not. This is the guard that does not depend on
   * the planner being sensible - the prompt now carries the refs it needs, but a
   * loop that acts on someone's page should not rely on a model reading it.
   */
  let lastKey: string | null = null;
  let repeats = 0;

  let actionsTaken = 0;

  const stop = (reason: StopReason, error: string | null): LoopResult => {
    emit({ type: 'loop/stopped', reason, steps, error });
    return { reason, steps, lastAction, error, actionsTaken };
  };

  for (let i = 0; i < maxSteps; i += 1) {
    // Checked BEFORE the step, so Stop takes effect without one more click on
    // someone's page.
    if (options.shouldStop?.() === true) return stop('cancelled', null);

    steps += 1;
    emit({ type: 'loop/step', step: steps, maxSteps });

    const result: StepResult = await runAgentStep(
      { ...deps, emit },
      { ...input, step: steps, history },
    );

    if (!result.ok) {
      // A failed step ends the run. Retrying blindly would repeat whatever went
      // wrong, and the stage name is already the most useful thing to report.
      return stop('error', `${result.stage}: ${result.error}`);
    }

    const { action, error } = result.outcome;
    lastAction = action;

    if (action !== null) {
      history.push({
        step: steps,
        actionType: action.type,
        ref: 'ref' in action ? action.ref : null,
        /*
         * Resolved HERE, against the context this step actually sent.
         *
         * Not later from a ref: refs are positional ordinals renumbered every
         * step, so by the next step this one may name a different element.
         */
        name:
          ('ref' in action
            ? (result.outcome.context.elements.find((e) => e.ref === action.ref)?.name?.text ??
              null)
            : null),
        ok: error === null,
        note: error ?? '',
      });
    }

    const terminal = terminalReason(action);
    if (terminal !== null) return stop(terminal, null);

    // Counted only past the terminal check, so `done` and `ask_user` - which
    // touch nothing - are never mistaken for work.
    actionsTaken += 1;

    /*
     * Repeating itself. Checked BEFORE the fingerprint, because a repeated
     * action often DOES change the page - the cart count went up every time -
     * which is exactly why the stall detector could not see it.
     */
    /*
     * The WHOLE action, not just type and ref.
     *
     * Keying on `type:ref` treated every ref-less action alike, so scrolling
     * down and scrolling up hashed the same and looked like repetition. The
     * question this guard asks is "did the planner just say the identical
     * thing", and the identical thing is the whole object.
     */
    const key = action === null ? null : JSON.stringify(action);
    if (key !== null && key === lastKey) {
      repeats += 1;
      if (repeats >= maxRepeats) {
        return stop('repeating', `planned ${key} ${String(repeats + 1)} times in a row`);
      }
    } else {
      repeats = 0;
    }
    lastKey = key;

    /*
     * Did anything actually happen? The planner cannot tell, and the step
     * reports its own success rather than the page's. Comparing a fingerprint
     * across steps is the only signal here that comes from the DOM.
     */
    /*
     * LET THE PAGE ARRIVE BEFORE JUDGING IT.
     *
     * On amazon.in a click opened the product and the page check ran at once:
     * "the page did NOT change". The next step captured the OLD page, the model
     * clicked the same link again, and that click "failed" against a document
     * already being replaced - one wasted step and a false report, on the run
     * that went on to succeed. Settling first makes the page check about the
     * page the action produced.
     */
    if (deps.settle !== undefined && action !== null) await deps.settle(input.tabId);

    if (deps.pageFingerprint !== undefined) {
      const fingerprint = await deps.pageFingerprint(input.tabId);
      const hadBaseline = previousFingerprint !== null;
      const changed = !hadBaseline || fingerprint !== previousFingerprint;
      /*
       * POST-ACTION VERIFICATION, reported rather than only counted.
       *
       * This comparison already existed and already drove `no-progress`; what it
       * did not do was SAY anything. So a step where the model reported success
       * and the page did not move looked, in the panel, exactly like a step where
       * both were true - the distinction only surfaced two stalls later as a stop
       * reason, by which point it reads as the loop giving up rather than as the
       * action having done nothing.
       *
       * Stated as `changed`/`unchanged`, never as `verified`. A DOM fingerprint
       * proves that something moved, not that the right thing moved; on a page
       * with a clock in the header it moves every step regardless. The receipt
       * carries the same wording for the same reason.
       *
       * THE FIRST STEP EMITS NOTHING. It has no baseline: the fingerprint is
       * taken AFTER the action, and no earlier one exists to compare it with. An
       * earlier version reported it as `changed`, which is a verification claim
       * about a comparison that never happened - the receipt would say "the page
       * changed after the action" for step 1 whatever the action did, including
       * nothing. `not-checked` is what the receipt shows instead, which is what
       * actually happened.
       *
       * The stall counter is unaffected: it was already the case that a first
       * step could not stall, because `previousFingerprint === null` took the
       * reset branch.
       */
      if (hadBaseline) emit({ type: 'page/verified', step: steps, changed });
      if (!changed) {
        stalls += 1;
        if (stalls >= maxStall) return stop('no-progress', null);
      } else {
        stalls = 0;
      }
      previousFingerprint = fingerprint;
    }

    if (options.shouldStop?.() === true) return stop('cancelled', null);
    // `settle` already waited for the page; a fixed delay on top would be paid twice.
    if (delayMs > 0 && deps.settle === undefined) await sleep(delayMs);
  }

  return stop('max-steps', null);
}
