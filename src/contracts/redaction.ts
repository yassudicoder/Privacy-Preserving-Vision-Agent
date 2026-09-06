import type { Brand } from './brand.ts';
import type { DetectionId, DetectionSource, DomPath, PiiKind } from './detection.ts';
import type { Rect } from './geometry.ts';

// ---------------------------------------------------------------------------
// Placeholder scheme
//
// The problem statement requires the server to be "aware of this redaction
// scheme". So the scheme is defined once, here, and both halves import it.
//
//   [[PII:CREDIT_CARD:3:9f2a1b7c]]
//        kind        ordinal  session nonce
//
// The nonce matters. Without it, a hostile page can print a placeholder-shaped
// string into its own text and make the server believe a field was redacted
// when it was not - or fabricate entries the redaction log has no record of.
// Page text is stripped of ALL placeholder shapes at ingest, and only the
// redactor mints real ones carrying the live nonce.
// ---------------------------------------------------------------------------

export type RedactionNonce = Brand<string, 'RedactionNonce'>;

/** HTML that has been through `redact()`. Not assignable from a plain string. */
export type RedactedHtml = Brand<string, 'RedactedHtml'>;

export function redactionNonce(value: string): RedactionNonce {
  return value as RedactionNonce;
}

/**
 * Matches ANY placeholder-shaped substring, whatever the nonce. Used to strip
 * forgeries.
 *
 * IT CARRIES `/g`, SO IT IS STATEFUL. `.replace()` and `.match()` are safe with
 * it - both ignore and reset `lastIndex`. `.test()` and `.exec()` are NOT: they
 * resume from wherever the previous call stopped, so a sequence of `.test()`
 * calls on a shared global regex returns true, false, true, false... regardless
 * of the input. Use `hasAnyPlaceholder` for a boolean.
 */
export const ANY_PLACEHOLDER_RE = /\[\[PII:[A-Z_]+:\d+:[0-9a-f]*\]\]/g;

/**
 * Does this text contain a placeholder? Stateless, and that is the whole point.
 *
 * `sanitize.ts` called `ANY_PLACEHOLDER_RE.test()` three times per element -
 * once each for the name, the group name and the value - on the shared global
 * regex above. The second call resumed from the first one's `lastIndex`, so for
 * every element the answers alternated: a redacted value reported
 * `redacted: false` because the name it followed had already advanced the
 * cursor, and an unredacted one reported true. `DataAtom.redacted` is what tells
 * the server which fields were protected, so roughly half of them were wrong.
 *
 * A separate non-global literal rather than a reset of the shared one: resetting
 * `lastIndex` before every use works and has to be remembered at every new call
 * site, which is the property that failed here in the first place.
 */
export function hasAnyPlaceholder(text: string): boolean {
  return /\[\[PII:[A-Z_]+:\d+:[0-9a-f]*\]\]/.test(text);
}

function kindToken(kind: PiiKind): string {
  return kind.toUpperCase().replace(/-/g, '_');
}

export function makePlaceholder(kind: PiiKind, ordinal: number, nonce: RedactionNonce): string {
  return `[[PII:${kindToken(kind)}:${ordinal}:${nonce}]]`;
}

/** Matches only placeholders minted with this session's nonce. */
export function placeholderPattern(nonce: RedactionNonce): RegExp {
  return new RegExp(`\\[\\[PII:([A-Z_]+):(\\d+):${nonce}\\]\\]`, 'g');
}

/**
 * Remove every placeholder-shaped substring from page-derived text.
 * MUST run at ingest, before the redactor inserts real placeholders.
 */
export function stripForgedPlaceholders(text: string): string {
  return text.replace(ANY_PLACEHOLDER_RE, '');
}

export function countForgedPlaceholders(text: string): number {
  return text.match(ANY_PLACEHOLDER_RE)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export type RedactionStrategy =
  /** Solid fill over the pixels. Irreversible. Default for faces and ID documents. */
  | 'blackout'
  /** Box blur over the pixels. Keeps layout legible; weaker guarantee than blackout. */
  | 'blur'
  /** Downsample the region into blocks. Between blur and blackout. */
  | 'pixelate'
  /** Replace characters with a mask, preserving length. Useful for shape-sensitive fields. */
  | 'mask-chars'
  /** Substitute a [[PII:...]] token the server can reason about. Default for text. */
  | 'placeholder'
  /** Delete the node entirely. For things the server has no business seeing at all. */
  | 'remove-node'
  /** Drop one attribute, keep the node. E.g. strip @value from an input. */
  | 'drop-attribute';

/**
 * Intent per kind, not the final operation.
 *
 * Note that credentials are `drop-attribute`, not `remove-node`. Deleting the
 * password field would destroy the very structural fact the server needs -
 * "there is a password field here, focused, required" - and visual context
 * accuracy is 25% of the score against redaction precision's 20%. Stripping the
 * value keeps the structure and leaks nothing. `resolveStrategy` in
 * redaction/strategies.ts maps this intent onto whatever is actually applicable
 * at the detection's location.
 */
export const DEFAULT_STRATEGY: Readonly<Record<PiiKind, RedactionStrategy>> = {
  password: 'drop-attribute',
  otp: 'drop-attribute',
  'api-key': 'placeholder',
  'credit-card': 'placeholder',
  cvv: 'drop-attribute',
  'bank-account': 'placeholder',
  ifsc: 'placeholder',
  aadhaar: 'placeholder',
  pan: 'placeholder',
  passport: 'placeholder',
  ssn: 'placeholder',
  email: 'placeholder',
  phone: 'placeholder',
  'person-name': 'placeholder',
  'postal-address': 'placeholder',
  dob: 'placeholder',
  'ip-address': 'placeholder',
  face: 'blur',
  signature: 'blackout',
  'id-document': 'blackout',
  'unknown-sensitive': 'placeholder',
};

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

export interface RedactionEntry {
  readonly detectionId: DetectionId;
  readonly kind: PiiKind;
  readonly source: DetectionSource;
  readonly strategy: RedactionStrategy;
  /** False when the detection was found but the edit could not be applied. */
  readonly applied: boolean;
  readonly target: {
    readonly domPath: DomPath | null;
    readonly rect: Rect<'css-viewport'> | null;
    readonly attr: string | null;
  };
  /** The token substituted in, when strategy is 'placeholder'. */
  readonly placeholder: string | null;
  /** Length and character mix of what was removed. Lets the server reason about shape. */
  readonly preservedShape: {
    readonly length: number;
    readonly charClass: 'numeric' | 'alpha' | 'alphanumeric' | 'mixed' | 'unknown';
  } | null;
  readonly confidence: number;
  readonly reason: string;
}

export interface RedactionSummary {
  readonly byKind: Readonly<Partial<Record<PiiKind, number>>>;
  readonly bySource: Readonly<Partial<Record<DetectionSource, number>>>;
  readonly nodesRemoved: number;
  readonly attributesDropped: number;
  readonly placeholdersInserted: number;
  readonly pixelOpsQueued: number;
  /** Placeholder forgeries found in page text and stripped at ingest. */
  readonly forgeriesStripped: number;
}

export interface RedactionLog {
  readonly schemaVersion: 1;
  readonly frameId: string;
  /** Origin + path shape only. Query and fragment are dropped, they leak. */
  readonly url: string;
  readonly nonce: RedactionNonce;
  readonly createdAt: number;
  readonly entries: readonly RedactionEntry[];
  readonly summary: RedactionSummary;
  /**
   * 'none'  - every detection was applied
   * 'low'   - some low-confidence detections were below threshold and left alone
   * 'unknown' - an edit failed, or a vision box could not be attached to anything
   */
  readonly residualRisk: 'none' | 'low' | 'unknown';
}

// ---------------------------------------------------------------------------
// Pixel redaction
// ---------------------------------------------------------------------------

/**
 * A pending pixel edit. `redact()` produces these; it cannot apply them itself
 * because it only has HTML. `bakeRedactions()` in redaction/canvas-redact.ts
 * applies them to the frame.
 */
export interface PixelRedactionOp {
  readonly detectionId: DetectionId;
  readonly kind: PiiKind;
  readonly strategy: Extract<RedactionStrategy, 'blackout' | 'blur' | 'pixelate'>;
  /** Device pixels, because that is the space the screenshot buffer is in. */
  readonly rect: Rect<'device-px'>;
  readonly intensity: number;
}

declare const BAKED: unique symbol;

/**
 * A screenshot whose redactions have actually been applied to the pixels.
 * Only `bakeRedactions()` can produce one, so `buildSanitizedContext` cannot be
 * handed an un-baked frame with `redactionsBaked: true` asserted by hand.
 */
export type BakedScreenshot = {
  readonly base64: string;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
  readonly opsApplied: number;
  readonly opsRequested: number;
  /**
   * Ops that were requested but lay entirely outside the captured viewport.
   *
   * A screenshot shows the viewport; the DOM scan reads the whole document. PII
   * below the fold is redacted in the text and was never in the picture, so no
   * pixel op could apply to it and none needed to. That is SAFE, and it looks
   * identical to a coordinate bug unless it is counted separately.
   */
  readonly opsOutsideFrame: number;
} & { readonly [BAKED]: true };

export function emptySummary(): RedactionSummary {
  return {
    byKind: {},
    bySource: {},
    nodesRemoved: 0,
    attributesDropped: 0,
    placeholdersInserted: 0,
    pixelOpsQueued: 0,
    forgeriesStripped: 0,
  };
}
