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
      field.value = action.text;
      notifyValueChanged(field);

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
