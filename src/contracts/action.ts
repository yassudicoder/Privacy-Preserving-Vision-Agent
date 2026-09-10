import type { ElementRef } from './context.ts';
import type { TargetResolution, TargetSpec } from './target.ts';

/**
 * The complete action vocabulary. One action per round trip, as the problem
 * statement specifies.
 *
 * Every element-addressing action carries an `ElementRef` rather than a
 * selector. The model cannot invent a ref: `validateAction` rejects any ref that
 * was not in the context we sent. That is what stops page content from steering
 * the agent even if it manages to influence the model's output.
 */
export type Action =
  /*
   * `target` is how the MODEL names the element - see `contracts/target.ts`.
   * `validateAction` resolves it against the sent elements and fills `ref`,
   * which is then only the handle execution uses. Until resolved, `ref` is ''.
   */
  | { readonly type: 'click'; readonly ref: ElementRef; readonly target?: TargetSpec }
  | {
      readonly type: 'type';
      readonly ref: ElementRef;
      readonly text: string;
      readonly submit: boolean;
      readonly target?: TargetSpec;
    }
  | {
      readonly type: 'select';
      readonly ref: ElementRef;
      readonly option: string;
      readonly target?: TargetSpec;
    }
  | {
      readonly type: 'scroll';
      readonly direction: 'up' | 'down' | 'left' | 'right';
      readonly amountPx: number;
    }
  | { readonly type: 'key'; readonly key: 'Enter' | 'Escape' | 'Tab' | 'Backspace' }
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'wait'; readonly ms: number }
  | { readonly type: 'ask_user'; readonly question: string }
  | { readonly type: 'done'; readonly summary: string }
  | { readonly type: 'abort'; readonly reason: string };

export type ActionType = Action['type'];

export const ACTION_TYPES: readonly ActionType[] = [
  'click',
  'type',
  'select',
  'scroll',
  'key',
  'navigate',
  'wait',
  'ask_user',
  'done',
  'abort',
];

/** Actions that address an element and therefore need ref validation. */
export const REF_ACTIONS: readonly ActionType[] = ['click', 'type', 'select'];

export type ParseErrorCode =
  | 'empty-input'
  | 'no-json-found'
  | 'malformed-json'
  | 'not-an-object'
  | 'missing-type'
  | 'unknown-type'
  | 'missing-field'
  | 'bad-field-type'
  | 'out-of-range'
  | 'multiple-actions';

export type ValidationErrorCode =
  | 'unknown-ref'
  | 'sensitive-target'
  /** A question that solicits a credential. Never a legitimate ask. */
  | 'asks-for-credential'
  | 'not-typeable'
  | 'origin-not-allowed'
  | 'bad-url'
  | 'scroll-too-far'
  | 'wait-too-long'
  | 'text-too-long'
  /** The field already holds exactly this text, so typing it changes nothing. */
  | 'already-typed'
  /** The target described no element that was sent. */
  | 'no-such-target'
  /** The target described more than one sent element; the client does not choose. */
  | 'ambiguous-target'
  | 'unverified-completion';

export interface ActionError<C extends string = string> {
  readonly code: C;
  readonly detail: string;
}

export type ParseResult<T, C extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ActionError<C> };

export function parseOk<T>(value: T): ParseResult<T, never> {
  return { ok: true, value };
}

export function parseErr<C extends string>(code: C, detail: string): ParseResult<never, C> {
  return { ok: false, error: { code, detail } };
}

export interface ValidationContext {
  /** Every ref we actually sent to the server this step. */
  readonly validRefs: ReadonlySet<ElementRef>;
  /** Refs the agent may not type into without explicit user confirmation. */
  readonly sensitiveRefs: ReadonlySet<ElementRef>;
  /**
   * Refs that can actually hold typed text.
   *
   * WHY VALIDATION NEEDS ROLES. The model reliably picks the RIGHT element and
   * the WRONG verb - a real run emitted
   * `{"type":"type","ref":"e41","text":"Submit Review"}`, where "Submit Review"
   * is the accessible name of a BUTTON. `validateAction` had no role
   * information, so it passed; the content script then refused with "holds no
   * value" and the step was spent discovering in the page something the sent
   * context already knew.
   *
   * Four failed steps in one run ended in `no-progress` this way.
   */
  readonly typeableRefs: ReadonlySet<ElementRef>;
  /**
   * What each field ALREADY contains, as we sent it this step.
   *
   * WHY VALIDATION NEEDS IT. A real amazon.in run ended
   * `repeating - planned {"type":"type","ref":"e4","text":"iPhone 17"} 3 times
   * in a row`. Every one of those three steps executed successfully - the text
   * was typed, the events fired, the page changed - and the model was shown
   * `value="iPhone 17"` on that very element in the next prompt. It typed it
   * again anyway, three times, and the loop died on no-progress having done the
   * same no-op three times over.
   *
   * Typing text a field already holds cannot change the page. So this is
   * refusable from information the client already has, before a request leaves,
   * and the refusal is CORRECTABLE - the model is told the field already
   * contains that text and asked to do the next thing instead. That converts
   * three wasted steps and a failed task into one re-plan.
   *
   * Only fields whose value we could actually compare are listed. A value that
   * was redacted to a placeholder is NOT comparable - the model was shown the
   * placeholder, not the text - so those are omitted and typing into them is
   * allowed exactly as before.
   */
  readonly currentValues: ReadonlyMap<ElementRef, string>;
  /**
   * Resolves a model-written target against exactly the elements sent this
   * step. Optional so hand-built contexts stay valid; when absent every target
   * is refused as `no-such-target` - the fail-closed direction.
   */
  readonly locate?: (target: TargetSpec) => TargetResolution;
  /** Origins the agent is allowed to navigate to. */
  readonly allowedOrigins: readonly string[];
  readonly maxScrollPx: number;
  readonly maxWaitMs: number;
  readonly maxTypeChars: number;
}

export const DEFAULT_LIMITS = {
  maxScrollPx: 5000,
  maxWaitMs: 10_000,
  maxTypeChars: 1000,
} as const;

/** What the server returns, before parsing. */
export interface ActionEnvelope {
  readonly action: Action;
  readonly rationale: string;
  readonly confidence: number;
}
