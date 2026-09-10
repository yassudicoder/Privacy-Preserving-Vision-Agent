import type { Action, ElementRef } from '@/contracts/index.ts';

/**
 * Performing an action on the page.
 *
 * WHERE THIS RUNS: the content script, the only context that touches the page.
 * It lives in a module rather than in the entrypoint because this is where a
 * mistake types a password into the wrong field, and an entrypoint cannot be
 * tested.
 *
 * The resolver is injected. This module does not know how an `ElementRef` maps
 * to an element - that mapping is built at snapshot time and is the content
 * script's business. What it knows is what to do once it has an element, and,
 * just as importantly, what to do when it does not: report a miss rather than
 * throw, because a stale ref is a normal consequence of a page that moved on.
 */

export interface ExecutionEnv {
  readonly resolve: (ref: ElementRef) => Element | null;
  readonly scrollBy: (x: number, y: number) => void;
  readonly navigate: (url: string) => void;
}

export interface ExecuteOutcome {
  readonly ok: boolean;
  readonly note: string;
}

const ok = (note: string): ExecuteOutcome => ({ ok: true, note });
const miss = (note: string): ExecuteOutcome => ({ ok: false, note });

/** Elements that carry a `value` the agent can write. */
function asValueElement(
  el: Element,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  }
  return null;
}

/**
 * Fires the events a framework is actually listening for.
 *
 * Assigning `.value` updates the DOM and leaves React/Vue state untouched, so
 * the field shows the text and the app behaves as though nothing was typed.
 * That failure looks like "the agent did nothing" and is invisible in the DOM.
 */
function notifyValueChanged(el: Element): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * What actually landed in the field.
 *
 * ADAPTED FROM ego-lite (citrolabs, MIT), `page-actions.ts` - its
 * `classifyFillOutcome` / `fillOutcomeAccepted` pair. The taxonomy is theirs and
 * it is the right one; the implementation below is ours and differs where our
 * constraints do (see SELECT, and the synchronous read).
 *
 * WHY IT IS NEEDED. `execute` returned ok unconditionally: it assigned `.value`
 * and reported success without ever looking at what the field then held. So
 * typing "next Friday" into an `input[type=date]` - which the HTML spec requires
 * the browser to sanitise to the empty string, synchronously, on assignment -
 * was reported to the agent, the panel and the receipt as a successful step. The
 * loop then planned its next move on the belief that a date had been entered.
 *
 * The distinction that makes this work is that TRANSFORMED IS A SUCCESS. A field
 * that reformats what it was given - trimming, upper-casing, inserting the
 * separators in a card number - did accept the input, and refusing those would
 * make the check useless on exactly the inputs most likely to have one. Only
 * `unchanged` (the browser threw it away) and `appended` (we meant to replace and
 * it concatenated) are failures.
 */
export type FillOutcome = 'exact' | 'equivalent' | 'transformed' | 'appended' | 'unchanged';

export function fillAccepted(outcome: FillOutcome): boolean {
  return outcome === 'exact' || outcome === 'equivalent' || outcome === 'transformed';
}

/**
 * Carriage returns and zero-width characters are never a real difference.
 *
 * Written as ESCAPES, never as literal bytes - the rule `contracts/untrusted.ts`
 * and `safeText` already follow. A regex holding an actual zero-width space is
 * invisible in a diff and does not survive a copy-paste intact.
 */
function normaliseFill(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
}

function digitsOf(text: string): string {
  return text.normalize('NFKC').replace(/\D/g, '');
}

export function classifyFill(
  before: string,
  expected: string,
  actual: string,
  inputType: string,
): FillOutcome {
  const b = normaliseFill(before);
  const e = normaliseFill(expected);
  const a = normaliseFill(actual);

  if (a === e) return 'exact';

  /*
   * A number field is allowed to disagree about spelling. `1.50` and `1.5` are
   * the same number and the field is entitled to normalise; treating that as a
   * failure would refuse a correct entry.
   */
  if (inputType === 'number') {
    const na = Number(a);
    const ne = Number(e);
    if (Number.isFinite(na) && Number.isFinite(ne) && na === ne) return 'equivalent';
  }

  /*
   * A field that formats digits for the reader - card numbers, phone numbers,
   * OTP boxes - inserts spaces and dashes we never typed. Only when what we
   * asked for was digits ALONE, so this cannot quietly accept a field that
   * mangled real text.
   */
  if (e !== '' && /^\d+$/.test(e) && digitsOf(a) === digitsOf(e)) return 'equivalent';

  // We meant to replace and it concatenated. The field now holds something
  // nobody asked for, which is a failure even though it did change.
  if (b !== '' && a === b + e) return 'appended';

  if (a === b) return 'unchanged';

  return 'transformed';
}

export function executeAction(action: Action, env: ExecutionEnv): ExecuteOutcome {
  switch (action.type) {
    case 'click': {
      const el = env.resolve(action.ref);
      if (el === null) return miss(`click: ref ${String(action.ref)} no longer resolves`);
      (el as HTMLElement).click();
      return ok(`clicked ${String(action.ref)}`);
    }

    case 'type': {
      const el = env.resolve(action.ref);
      if (el === null) return miss(`type: ref ${String(action.ref)} no longer resolves`);

      const field = asValueElement(el);
      if (field === null) {
        return miss(`type: ref ${String(action.ref)} (${el.tagName}) holds no value`);
      }

      // `.value` is correct for textarea too - it is `setAttribute('value')`
      // that silently does nothing there. That bug already leaked PII past
      // redaction once on the read path; it does not get to return here.
      const before = field.value;
      field.value = action.text;
      notifyValueChanged(field);

      /*
       * READ BACK, SYNCHRONOUSLY, BEFORE REPORTING ANYTHING.
       *
       * The spec sanitisation this exists to catch happens ON ASSIGNMENT, so a
       * synchronous read sees it. What a synchronous read CANNOT see is a
       * framework that resets the field in a later task - ego-lite polls five
       * times at 50 ms for exactly that, and it can because its fill is already
       * async over CDP. `executeAction` is synchronous and making it async would
       * ripple through the content script and its callers for a case we have not
       * measured. Stated here rather than silently narrowed.
       */
      const inputType =
        field.tagName === 'INPUT' ? (field.getAttribute('type') ?? 'text').toLowerCase() : '';
      const outcome = classifyFill(before, action.text, field.value, inputType);

      /*
       * A SELECT IS HELD TO A HIGHER BAR, and this is ours rather than ego-lite's.
       *
       * Its value comes from a closed set: assigning an option that does not
       * exist silently yields the empty string. That reads as `transformed` -
       * the value changed, just not to what was asked - which the taxonomy
       * accepts, and accepting it here would report "selected" for an option the
       * page never offered. There is no legitimate transformation of a value
       * that had to be chosen from a list.
       */
      if (field.tagName === 'SELECT' && outcome !== 'exact' && outcome !== 'equivalent') {
        return miss(
          `type: ${String(action.ref)} is a <select> and "${action.text}" is not one of its ` +
            `options (it now reads "${field.value}")`,
        );
      }

      if (!fillAccepted(outcome)) {
        return miss(
          outcome === 'unchanged'
            ? `type: ${String(action.ref)} did not accept "${action.text}" - the field still ` +
              `reads "${field.value}"${inputType === '' ? '' : ` (input type=${inputType})`}`
            : `type: ${String(action.ref)} appended rather than replaced - it now reads ` +
              `"${field.value}"`,
        );
      }

      if (action.submit) {
        const form = field.closest('form');
        if (form === null) return ok(`typed into ${String(action.ref)}; no form to submit`);
        // requestSubmit runs validation and fires submit; form.submit() skips
        // both, which is not what "press enter in this field" means.
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return ok(`typed into ${String(action.ref)} and submitted`);
      }
      return ok(`typed into ${String(action.ref)}`);
    }

    case 'select': {
      const el = env.resolve(action.ref);
      if (el === null) return miss(`select: ref ${String(action.ref)} no longer resolves`);
      if (el.tagName !== 'SELECT') return miss(`select: ref ${String(action.ref)} is not a <select>`);

      const sel = el as HTMLSelectElement;
      const wanted = action.option;
      const options = Array.from(sel.options);
      // Value first, then visible label: the model sees labels, the DOM keys on
      // values, and either may be what it meant.
      const match =
        options.find((o) => o.value === wanted) ??
        options.find((o) => o.text.trim() === wanted.trim());

      if (match === undefined) {
        // Deliberately does NOT fall back to the first option. Silently picking
        // something would let the loop proceed believing a choice it never made.
        return miss(`select: no option matching "${wanted}"`);
      }

      sel.value = match.value;
      notifyValueChanged(sel);
      return ok(`selected "${wanted}"`);
    }

    case 'scroll': {
      const amount = Math.max(0, action.amountPx);
      const [x, y] =
        action.direction === 'up'
          ? [0, -amount]
          : action.direction === 'down'
            ? [0, amount]
            : action.direction === 'left'
              ? [-amount, 0]
              : [amount, 0];
      env.scrollBy(x, y);
      return ok(`scrolled ${action.direction} ${String(amount)}px`);
    }

    case 'key': {
      // To the focused element, or the body when nothing has focus - the same
      // place a real keypress would land.
      const target: EventTarget = document.activeElement ?? document.body;
      const init = { key: action.key, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return ok(`pressed ${action.key}`);
    }

    case 'navigate': {
      // Injected, so the one call that leaves the page has exactly one call
      // site and can be tested. validateAction has already checked the origin.
      env.navigate(action.url);
      return ok(`navigating to ${action.url}`);
    }

    // These are decisions, not DOM operations. They succeed here without
    // touching the page; returning false would make the loop read a normal
    // "done" as a failure.
    case 'wait':
      return ok(`wait ${String(action.ms)}ms is handled by the orchestrator`);
    case 'done':
      return ok(`done: ${action.summary}`);
    case 'ask_user':
      return ok(`ask_user: ${action.question}`);
    case 'abort':
      return ok(`abort: ${action.reason}`);
  }
}
