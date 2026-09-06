/**
 * The untrusted-data boundary.
 *
 * Anything read off a web page is DATA. It is never an instruction to the agent
 * or to the server. This module makes that a compile-time property rather than
 * a convention:
 *
 *   - Every value that originates in page content is `Untrusted<T>`.
 *   - `Untrusted<string>` cannot be passed anywhere a `string` is expected.
 *   - The only way out is `unsafeUnwrap(value, reason)`, which forces the caller
 *     to name one of a fixed set of reasons. Grep for it to audit every escape.
 *   - The only value that may cross the network boundary is a `DataAtom`, which
 *     is structurally quoted and length-capped by `toDataAtom`.
 */

const UNTRUSTED: unique symbol = Symbol('untrusted-page-data');

/**
 * A value that came from a web page. Data, never instruction.
 *
 * This is a real wrapper, NOT `T & { brand }`. An intersection would still be
 * assignable to `T`, so `wantsString(pageText)` would compile and the guarantee
 * would be decorative. Wrapping means page text simply is not a string until
 * someone calls `unsafeUnwrap` and names a reason.
 *
 * Two properties fall out of holding the payload behind a module-private symbol:
 *   - No property access can reach it from outside this file.
 *   - JSON.stringify() of an Untrusted value yields `{}`, because symbol keys
 *     are not serialised. Page text cannot leak by being accidentally included
 *     in a payload; it has to be deliberately unwrapped first.
 */
export interface Untrusted<T> {
  readonly [UNTRUSTED]: T;
}

/** Tag a value as page-derived. Call this at every DOM read site. */
export function markUntrusted<T>(value: T): Untrusted<T> {
  return { [UNTRUSTED]: value };
}

/**
 * The complete set of legitimate reasons to look at raw page text.
 * Adding a member here is a security decision, not a convenience.
 */
export type UnwrapReason =
  /** Feed it to a PII regex. The text is inspected, never executed or forwarded. */
  | 'regex-scan'
  /** Hand it to DOMParser. Produces a Document, still untrusted. */
  | 'dom-parse'
  /** Render into the local panel as inert textContent. Never innerHTML. */
  | 'render-as-inert-text'
  /** Compute a salted hash for the redaction log. The raw value is discarded. */
  | 'hash-for-log'
  /**
   * Cross an extension messaging boundary. chrome.runtime messaging is
   * JSON-serialised, so the wrapper cannot survive the hop. The receiving side
   * must call markUntrusted() again immediately - this is the one place the
   * brand is carried by convention rather than by the compiler.
   */
  | 'ipc-transfer'
  /** Test fixtures only. */
  | 'test-fixture';

/**
 * The only way to read page text. Every call site is an auditable decision, and
 * `tests/architecture/boundaries.test.ts` pins the exact list of files allowed
 * to contain one.
 */
export function unsafeUnwrap<T>(value: Untrusted<T>, reason: UnwrapReason): T {
  void reason;
  return value[UNTRUSTED];
}

// ---------------------------------------------------------------------------
// DataAtom - the only page-derived shape allowed to cross the network boundary
// ---------------------------------------------------------------------------

/**
 * Sequences that would let page text break out of the prompt's data fence and
 * be read as instructions. Neutralised on the way into a DataAtom.
 */
export const FENCE_TOKENS: readonly string[] = [
  '<<<PAGE_DATA',
  'PAGE_DATA>>>',
  '```',
  '<instructions>',
  '</instructions>',
  '<|im_start|>',
  '<|im_end|>',
  '<|system|>',
  '[INST]',
  '[/INST]',
];

export const MAX_ATOM_CHARS = 512;

/**
 * Codepoint ranges that are invisible or direction-altering. Bidi overrides and
 * zero-width joiners are a documented way to smuggle instructions past a human
 * reviewer, so they are removed rather than merely escaped.
 *
 * Written as ranges instead of a regex literal so the source stays readable and
 * free of escape sequences.
 */
const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
];

const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f], // zero-width space .. right-to-left mark
  [0x202a, 0x202e], // bidi embedding / override
  [0x2060, 0x2064], // word joiner .. invisible plus
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Strip control and invisible characters, collapse whitespace and defang fence
 * tokens. Redaction placeholders are preserved - the server needs to see them.
 */
export function neutralize(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (inRanges(cp, CONTROL_RANGES)) {
      out += ' ';
    } else if (inRanges(cp, INVISIBLE_RANGES)) {
      // dropped entirely
    } else {
      out += ch;
    }
  }
  for (const token of FENCE_TOKENS) {
    if (!out.includes(token)) continue;
    // Interpose a visible separator so the server's fence parser can no longer
    // match the token, while the text stays readable in the panel.
    out = out.split(token).join(token.split('').join('·'));
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Page-derived text that has been redacted, quoted and capped. */
export interface DataAtom {
  readonly kind: 'page-data';
  readonly text: string;
  /** True when a redaction placeholder was substituted into this text. */
  readonly redacted: boolean;
  /** True when the text hit the character cap and was cut. */
  readonly truncated: boolean;
}

/**
 * The single constructor for network-bound page text.
 * Takes `Untrusted<string>` so it is impossible to call on anything else.
 */
export function toDataAtom(
  value: Untrusted<string>,
  opts: { readonly redacted: boolean; readonly maxChars?: number },
): DataAtom {
  const raw = unsafeUnwrap(value, 'render-as-inert-text');
  const cleaned = neutralize(raw);
  const limit = opts.maxChars ?? MAX_ATOM_CHARS;
  const truncated = cleaned.length > limit;
  return {
    kind: 'page-data',
    text: truncated ? `${cleaned.slice(0, limit)}...` : cleaned,
    redacted: opts.redacted,
    truncated,
  };
}

/** A DataAtom built from text the USER typed (a goal), not from the page. */
export function userText(text: string): DataAtom {
  return { kind: 'page-data', text: neutralize(text), redacted: false, truncated: false };
}

export function isDataAtom(v: unknown): v is DataAtom {
  return typeof v === 'object' && v !== null && (v as DataAtom).kind === 'page-data';
}
