import type { PiiKind } from '@/contracts/index.ts';

/**
 * Text pattern bank.
 *
 * Precision is 20% of the score and false positives cost as much as misses, so
 * anything with a checksum gets its checksum verified. A bare 12-digit number is
 * not an Aadhaar; a bare 16-digit number is not a card. Format-only matches are
 * emitted with visibly lower confidence so the caller can threshold them.
 *
 * Pure. No DOM, no globals, no state.
 */

export interface PatternMatch {
  readonly kind: PiiKind;
  /** Which rule fired. Lands in the redaction log as evidence. */
  readonly rule: string;
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly confidence: number;
}

export type CharClass = 'numeric' | 'alpha' | 'alphanumeric' | 'mixed' | 'unknown';

export function charClassOf(value: string): CharClass {
  if (value.length === 0) return 'unknown';
  const hasDigit = /\d/.test(value);
  const hasAlpha = /[a-zA-Z]/.test(value);
  const hasOther = /[^a-zA-Z0-9]/.test(value);
  if (hasOther) return 'mixed';
  if (hasDigit && hasAlpha) return 'alphanumeric';
  if (hasDigit) return 'numeric';
  if (hasAlpha) return 'alpha';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------

/** Luhn (mod 10). Validates credit card numbers. */
export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.length < 12 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    const ch = clean.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let d = ch;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Verhoeff tables. Aadhaar uses Verhoeff, not Luhn - using the wrong one
// produces a detector that is confidently wrong about a billion identifiers.
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff (dihedral) checksum. Validates Aadhaar numbers. */
export function verhoeffValid(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.length !== 12) return false;
  let c = 0;
  const reversed = clean.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    const digit = Number(reversed[i]);
    if (!Number.isInteger(digit)) return false;
    const pRow = VERHOEFF_P[i % 8];
    const dRow = VERHOEFF_D[c];
    if (pRow === undefined || dRow === undefined) return false;
    const p = pRow[digit];
    if (p === undefined) return false;
    const next = dRow[p];
    if (next === undefined) return false;
    c = next;
  }
  return c === 0;
}

/** PAN: 5 letters, 4 digits, 1 letter. The 4th letter encodes the holder type. */
const PAN_HOLDER_TYPES = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

export function panValid(value: string): boolean {
  const v = value.toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) return false;
  const holder = v[3];
  return holder !== undefined && PAN_HOLDER_TYPES.has(holder);
}

export function ipv4Valid(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/** SSN prefixes that were never issued. Cheap precision win. */
export function ssnValid(value: string): boolean {
  const clean = value.replace(/[^0-9]/g, '');
  if (clean.length !== 9) return false;
  const area = clean.slice(0, 3);
  const group = clean.slice(3, 5);
  const serial = clean.slice(5);
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  return group !== '00' && serial !== '0000';
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

interface Rule {
  readonly kind: PiiKind;
  readonly rule: string;
  readonly re: RegExp;
  readonly confidence: number;
  readonly validate?: (value: string) => boolean;
  /** Bump confidence when validation passes. */
  readonly validatedConfidence?: number;
}

const RULES: readonly Rule[] = [
  {
    kind: 'email',
    rule: 'email-rfc-lite',
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    confidence: 0.93,
  },
  {
    kind: 'credit-card',
    rule: 'luhn-credit-card',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 0.35,
    validate: luhnValid,
    validatedConfidence: 0.97,
  },
  {
    kind: 'aadhaar',
    rule: 'verhoeff-aadhaar',
    re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    confidence: 0.4,
    validate: verhoeffValid,
    validatedConfidence: 0.97,
  },
  {
    kind: 'pan',
    rule: 'pan-format',
    re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    confidence: 0.5,
    validate: panValid,
    validatedConfidence: 0.94,
  },
  {
    kind: 'ifsc',
    rule: 'ifsc-format',
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    confidence: 0.88,
  },
  {
    kind: 'passport',
    rule: 'passport-in',
    re: /\b[A-PR-WY][0-9]{7}\b/g,
    confidence: 0.55,
  },
  {
    kind: 'ssn',
    rule: 'ssn-us',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.5,
    validate: ssnValid,
    validatedConfidence: 0.93,
  },
  {
    kind: 'phone',
    rule: 'phone-in-e164',
    re: /(?:\+91[ -]?)?\b[6-9]\d{9}\b/g,
    confidence: 0.82,
  },
  {
    kind: 'phone',
    rule: 'phone-intl',
    re: /\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}/g,
    confidence: 0.7,
  },
  {
    kind: 'ip-address',
    rule: 'ipv4',
    re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    confidence: 0.4,
    validate: ipv4Valid,
    validatedConfidence: 0.85,
  },
  {
    kind: 'api-key',
    rule: 'api-key-prefixed',
    re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 0.95,
  },
  {
    kind: 'dob',
    rule: 'date-dmy',
    re: /\b(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19|20)\d{2}\b/g,
    confidence: 0.45,
  },
  {
    kind: 'bank-account',
    rule: 'account-long-digits',
    re: /\b\d{9,18}\b/g,
    confidence: 0.3,
  },
];

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

function overlaps(a: PatternMatch, b: PatternMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Resolve overlaps. Higher confidence wins; on a tie the longer match wins.
 * A Luhn-valid 16-digit card must beat the generic long-digits account rule.
 */
export function dedupeMatches(matches: readonly PatternMatch[]): PatternMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return a.start - b.start;
  });
  const kept: PatternMatch[] = [];
  for (const m of sorted) {
    if (!kept.some((k) => overlaps(k, m))) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Scan plain text for PII. Callers pass unwrapped text with the 'regex-scan'
 * reason - the text is inspected here and never forwarded anywhere.
 */
export function scanTextPatterns(text: string, minConfidence = 0): PatternMatch[] {
  const found: PatternMatch[] = [];

  for (const rule of RULES) {
    // Fresh RegExp per scan: the shared literals carry /g and therefore lastIndex.
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const value = m[0];
      const start = m.index;
      let confidence = rule.confidence;

      if (rule.validate !== undefined) {
        const passed = rule.validate(value);
        if (!passed) {
          // Drop entirely rather than emit a low-confidence guess: a
          // checksum-failing "card number" is simply not a card number.
          m = re.exec(text);
          continue;
        }
        confidence = rule.validatedConfidence ?? rule.confidence;
      }

      if (confidence >= minConfidence) {
        found.push({
          kind: rule.kind,
          rule: rule.rule,
          start,
          end: start + value.length,
          value,
          confidence,
        });
      }

      // Zero-length guard: a pathological pattern would otherwise spin forever.
      if (re.lastIndex === start) re.lastIndex = start + 1;
      m = re.exec(text);
    }
  }

  return dedupeMatches(found);
}
