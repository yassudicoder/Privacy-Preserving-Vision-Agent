import type { BudgetReport } from './budget.ts';
import type { Brand } from './brand.ts';
import type { Rect, ViewportInfo } from './geometry.ts';
import type { BakedScreenshot, RedactionNonce, RedactionSummary } from './redaction.ts';
import type { DataAtom } from './untrusted.ts';

/**
 * An opaque handle to an element on the page. The server may only name elements
 * we handed it. This is the runtime half of the untrusted-data rule: even if a
 * hostile page convinces the model to emit an instruction, the model has no
 * vocabulary for naming a target we did not choose to expose.
 */
export type ElementRef = Brand<string, 'ElementRef'>;

export function elementRef(value: string): ElementRef {
  return value as ElementRef;
}

export type ElementState = 'disabled' | 'checked' | 'focused' | 'required' | 'readonly' | 'invalid';

export interface SanitizedElement {
  readonly ref: ElementRef;
  /** ARIA role, explicit or implied. 'button' | 'textbox' | 'link' | 'checkbox' | ... */
  readonly role: string;
  /** Accessible name. Page-derived, therefore a DataAtom. Null when unnamed. */
  readonly name: DataAtom | null;
  /** Short page-derived identity from the nearest meaningful card or section. */
  readonly groupName?: DataAtom | null;
  /** Current value, already redacted. Null for elements that hold no value. */
  readonly value: DataAtom | null;
  readonly rect: Rect<'css-viewport'>;
  readonly states: readonly ElementState[];
  /** True when this element holds or collects PII. The agent may not type into it unattended. */
  readonly isSensitive: boolean;
}

declare const SANITIZED: unique symbol;

export interface SanitizedContextShape {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly step: number;
  /** The user's goal. Comes from the USER, never from the page. */
  readonly goal: string;
  /** Origin + path shape. Query and fragment stripped. */
  readonly url: string;
  readonly title: DataAtom;
  readonly viewport: ViewportInfo;
  readonly elements: readonly SanitizedElement[];
  /** Null unless the benchmark said sending pixels is worth it for this session. */
  readonly screenshot: BakedScreenshot | null;
  readonly redactionSummary: RedactionSummary;
  readonly nonce: RedactionNonce;
  readonly history: readonly ExecutedStep[];
  /**
   * Questions the agent asked and the answers the USER gave.
   *
   * These are user-authored, exactly as `goal` is, so they belong in the
   * instruction region rather than behind the data fence. The QUESTION came from
   * the model and is echoed back for continuity; the ANSWER is the only new
   * information, and it is the reason the task can continue at all.
   *
   * Without this, an `ask_user` is a dead end: the loop stops, the panel shows a
   * question, and there is nowhere for the reply to go.
   */
  readonly clarifications: readonly Clarification[];
  /**
   * What the element budget did.
   *
   * Required, so every construction site is forced to state what it dropped -
   * CLAUDE.md forbids bounding coverage silently. It carries refs, roles and
   * counts, never page text, so it is safe to send.
   */
  readonly budget: BudgetReport;
}

/** One question the agent asked, and what the user replied. */
export interface Clarification {
  /**
   * From the MODEL. Untrusted in the same sense a server response is: neutralise
   * before rendering it anywhere a person will read it, and never treat it as an
   * instruction to this client.
   */
  readonly question: string;
  /** From the USER. Never from the page and never from the server. */
  readonly answer: string;
  /**
   * The options the user was choosing between, recorded when the question was
   * asked.
   *
   * Carried rather than re-derived from the question text: on the first real run
   * the question named "Laptop Pro" while the button was "Add Laptop Pro to
   * cart", so matching the answer back to an element found nothing and the
   * answer changed nothing.
   */
  readonly candidates?: readonly string[];
}

export interface ExecutedStep {
  readonly step: number;
  readonly actionType: string;
  readonly ref: ElementRef | null;
  /**
   * The element's accessible name AS IT WAS WHEN THE ACTION RAN.
   *
   * Required, not optional, because the alternative is a silent lie.
   *
   * Refs are POSITIONAL ORDINALS - `extractElements` numbers the interesting
   * elements in document order from a counter that restarts every step. So a ref
   * identifies an element only within the step that minted it. The prompt used
   * to render history by looking each old ref up in the CURRENT element list,
   * which is correct exactly until the page changes: a search that inserts two
   * results shifts every later ordinal, and step 1's `e40` is then labelled with
   * whatever element now sits at position 40. A truthful ref beside a wrong name
   * is worse than no name, because the model has no way to tell.
   *
   * Capturing it here means history says what was actually done, and nothing
   * downstream has to resolve a stale ref against a moved page.
   */
  readonly name: string | null;
  readonly ok: boolean;
  readonly note: string;
}

/**
 * The ONLY payload allowed to leave the client.
 *
 * Nominally typed: an object literal of the right shape is not assignable to it.
 * `redaction/sanitize.ts` is the sole place permitted to mint one, and
 * `tests/architecture/boundaries.test.ts` fails the build if anything else casts
 * to this type.
 */
export type SanitizedContext = SanitizedContextShape & { readonly [SANITIZED]: true };

/** Policy for whether pixels are sent at all. An OUTPUT of the model benchmark. */
export interface SessionPolicy {
  readonly sendScreenshot: boolean;
  readonly source: 'benchmark' | 'fallback' | 'user-override';
  readonly benchmarkId: string | null;
  readonly rationale: string;
}

/**
 * Roles `type` can act on.
 *
 * Lives here so the PROMPT and the VALIDATOR read the same set. They were
 * derived independently before: `validationContextFor` built `typeableRefs` from
 * this list while the prompt only stated the rule in prose, and a model that
 * mis-read the prose got a refusal it could not see coming from the element row.
 */
export const TYPEABLE_ROLES: ReadonlySet<string> = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
]);
