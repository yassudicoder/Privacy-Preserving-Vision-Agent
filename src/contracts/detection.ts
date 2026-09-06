import type { Brand } from './brand.ts';
import type { Rect } from './geometry.ts';

export type DetectionId = Brand<string, 'DetectionId'>;

/** Canonical structural path to a node, e.g. `html>body>form:nth-of-type(1)>input:nth-of-type(2)`. */
export type DomPath = Brand<string, 'DomPath'>;

export function detectionId(value: string): DetectionId {
  return value as DetectionId;
}

export function domPath(value: string): DomPath {
  return value as DomPath;
}

/**
 * What kind of sensitive thing this is. Drives the redaction strategy and the
 * per-kind breakdown the SIH rubric asks for.
 */
export type PiiKind =
  // credentials
  | 'password'
  | 'otp'
  | 'api-key'
  // financial
  | 'credit-card'
  | 'cvv'
  | 'bank-account'
  | 'ifsc'
  // government identifiers (India-first, since this is an ISRO problem statement)
  | 'aadhaar'
  | 'pan'
  | 'passport'
  | 'ssn'
  // contact + identity
  | 'email'
  | 'phone'
  | 'person-name'
  | 'postal-address'
  | 'dob'
  // network
  | 'ip-address'
  // visual-only
  | 'face'
  | 'signature'
  | 'id-document'
  // fallback
  | 'unknown-sensitive';

export const ALL_PII_KINDS: readonly PiiKind[] = [
  'password',
  'otp',
  'api-key',
  'credit-card',
  'cvv',
  'bank-account',
  'ifsc',
  'aadhaar',
  'pan',
  'passport',
  'ssn',
  'email',
  'phone',
  'person-name',
  'postal-address',
  'dob',
  'ip-address',
  'face',
  'signature',
  'id-document',
  'unknown-sensitive',
];

/** Kinds that only a pixel model can find. No DOM markup implies them. */
export const VISUAL_ONLY_KINDS: readonly PiiKind[] = ['face', 'signature', 'id-document'];

export type DetectionSource =
  /** Local vision model output. */
  | 'vision'
  /** input[type=password] and friends - highest precision signal we have. */
  | 'dom-input-type'
  /** autocomplete tokens: cc-number, cc-csc, tel, email, street-address, bday. */
  | 'dom-autocomplete'
  /** aria-label / name / id / placeholder heuristics. Lower precision. */
  | 'dom-heuristic'
  /** Text content matched a validated pattern. */
  | 'regex'
  /** Explicit user or site rule. Always wins. */
  | 'user-rule';

/**
 * Evidence for a detection. Deliberately does NOT carry the matched value - the
 * redaction log is written to disk and shown in the panel, so putting the PII in
 * it would defeat the entire exercise.
 */
export interface Evidence {
  /** Name of the rule that fired, e.g. `luhn-credit-card`. */
  readonly rule: string;
  readonly valueLength: number;
  /** Salted, session-scoped. Lets us dedupe and correlate without storing the value. */
  readonly valueHash: string;
}

export interface Detection {
  readonly id: DetectionId;
  readonly kind: PiiKind;
  readonly source: DetectionSource;
  /** 0..1. Used for ranking, thresholding and one-to-one match tie-breaks. */
  readonly confidence: number;
  /** Null when the element has no layout yet (jsdom, display:none, off-screen). */
  readonly rect: Rect<'css-viewport'> | null;
  /** Null for pure-pixel detections with no DOM counterpart. */
  readonly domPath: DomPath | null;
  /** Which attribute held the value: 'value', 'placeholder', 'alt', 'title', or null for text. */
  readonly attr: string | null;
  /**
   * Index within the parent's childNodes of the text node this span refers to.
   * An element can hold several text nodes, so the path alone is ambiguous.
   * Null for attribute matches and whole-element detections.
   */
  readonly nodeIndex: number | null;
  /** Character span within that text node, when the match is a substring. */
  readonly textSpan: { readonly start: number; readonly end: number } | null;
  readonly evidence: Evidence;
}

/** A detection that came from the pixel model. Always has a rect, never a DOM path. */
export interface VisionDetection {
  readonly id: DetectionId;
  readonly kind: PiiKind;
  readonly source: 'vision';
  readonly confidence: number;
  readonly rect: Rect<'css-viewport'>;
  /** Raw model label before mapping to a PiiKind. Kept for debugging and benchmarks. */
  readonly label: string;
  readonly evidence: Evidence;
}

export function visionToDetection(v: VisionDetection): Detection {
  return {
    id: v.id,
    kind: v.kind,
    source: 'vision',
    confidence: v.confidence,
    rect: v.rect,
    domPath: null,
    attr: null,
    nodeIndex: null,
    textSpan: null,
    evidence: v.evidence,
  };
}

export function isVisualOnly(kind: PiiKind): boolean {
  return VISUAL_ONLY_KINDS.includes(kind);
}
