/**
 * THE DETECTORS, reimplemented in about two kilobytes so this page can run them
 * on whatever the visitor types.
 *
 * THIS IS A DEMONSTRATION, NOT THE SHIPPED DETECTOR. The real one is
 * `src/redaction/patterns.ts` in the extension, has 13 validated patterns
 * against these 6, and runs over a DOM rather than a string. The page says so
 * where it says anything. On a site whose whole argument is that other people
 * overclaim, an unlabelled re-enactment is the first thing a hostile reader
 * finds.
 *
 * What IS faithful is the part that matters: these validate rather than match.
 * A pattern that only counts digits flags every order number, every invoice ID
 * and every tracking code on the page - and over-redaction is not caution, it
 * is a page the AI can no longer read. So the card check is a real Luhn and the
 * Aadhaar check is a real Verhoeff, and both are shown failing on purpose.
 */

/* ─────────────────────────────────────────────────────────────────── Luhn ── */

/**
 * Returns the running state of the Luhn checksum, digit by digit from the right.
 *
 * The steps are returned rather than just the verdict so the UI can show the
 * arithmetic happening. Hardcoding a sum would be less work and would also be
 * the single most checkable falsehood on this page.
 */
export function luhn(raw) {
  const digits = raw.replace(/\D/g, '').split('').map(Number);
  let sum = 0;
  const steps = [];
  for (let i = digits.length - 1, pos = 0; i >= 0; i--, pos++) {
    const d = digits[i];
    let add = d;
    const doubled = pos % 2 === 1;
    if (doubled) {
      add = d * 2;
      if (add > 9) add -= 9;
    }
    sum += add;
    steps.push({ index: i, digit: d, doubled, add, sum });
  }
  return { steps, sum, valid: digits.length > 0 && sum % 10 === 0 };
}

/* ──────────────────────────────────────────────────────────────── Verhoeff ── */

// The dihedral group D5 multiplication table, the permutation table, and the
// inverse table. This is the checksum the UIDAI actually specifies for Aadhaar,
// and it catches transpositions that a mod-10 sum does not.
const D5 = [
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
const PERM = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 12) return { valid: false, reason: 'not twelve digits' };
  let c = 0;
  const rev = digits.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D5[c][PERM[i % 8][rev[i]]];
  return { valid: c === 0, reason: c === 0 ? 'checksum holds' : 'checksum fails' };
}

/* ────────────────────────────────────────────────────────────── the sweep ── */

/**
 * Every rule, in the order they are applied. `validate` is what separates a
 * detector from a regex: it gets the matched text and decides whether the thing
 * that LOOKS like a card actually is one.
 */
const RULES = [
  {
    kind: 'EMAIL',
    label: 'email address',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    validate: () => ({ ok: true, note: 'valid address shape' }),
  },
  {
    kind: 'CREDIT_CARD',
    label: 'card number',
    // 13-19 digits, optionally grouped by spaces or dashes.
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => {
      const n = m.replace(/\D/g, '');
      if (n.length < 13 || n.length > 19) return { ok: false, note: 'wrong length for a card' };
      const { sum, valid } = luhn(m);
      return valid
        ? { ok: true, note: `Luhn sum ${sum}, mod 10 = 0` }
        : { ok: false, note: `Luhn sum ${sum}, mod 10 = ${sum % 10} — not a card` };
    },
  },
  {
    kind: 'AADHAAR',
    label: 'Aadhaar number',
    re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    validate: (m) => {
      const v = verhoeff(m);
      return v.valid
        ? { ok: true, note: 'Verhoeff checksum holds' }
        : { ok: false, note: `Verhoeff ${v.reason} — not an Aadhaar` };
    },
  },
  {
    kind: 'PAN',
    label: 'PAN',
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    // The fourth character encodes the holder type. Anything outside the
    // allocated set is a lookalike, not a PAN.
    validate: (m) => (
      'ABCFGHLJPTK'.includes(m[3])
        ? { ok: true, note: `holder type "${m[3]}" is allocated` }
        : { ok: false, note: `holder type "${m[3]}" is not allocated — not a PAN` }
    ),
  },
  {
    kind: 'PHONE',
    label: 'phone number',
    re: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g,
    validate: (m) => {
      const n = m.replace(/\D/g, '');
      const local = n.startsWith('91') ? n.slice(2) : n;
      return local.length === 10
        ? { ok: true, note: 'ten digits, valid leading digit' }
        : { ok: false, note: 'wrong length for a mobile number' };
    },
  },
  {
    kind: 'IP',
    label: 'IP address',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    validate: (m) => (
      m.split('.').every((o) => Number(o) <= 255)
        ? { ok: true, note: 'every octet in range' }
        : { ok: false, note: 'octet out of range — not an address' }
    ),
  },
];

/** Anything shaped like one of our own redaction markers. Always an attack. */
const FORGERY_RE = /\[\[PII:[^\]]*\]\]/g;

/**
 * Scans a string and returns every span of interest, sorted, non-overlapping.
 *
 * A span is returned whether or not it validated: the ones that FAILED are the
 * point of the whole exercise, because they are what the redactor deliberately
 * leaves alone.
 */
export function scan(text) {
  const spans = [];

  // Forgeries first. Page text is stripped of all marker shapes at ingest,
  // BEFORE the redactor mints any real ones - otherwise a hostile page could
  // print one and make the far end believe a field was protected.
  for (const m of text.matchAll(FORGERY_RE)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      kind: 'FORGERY',
      label: 'forged redaction marker',
      ok: false,
      forged: true,
      note: 'marker shape in page text — stripped at ingest, always an attack',
    });
  }

  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      const v = rule.validate(m[0]);
      spans.push({
        start,
        end,
        text: m[0],
        kind: rule.kind,
        label: rule.label,
        ok: v.ok,
        forged: false,
        note: v.note,
      });
    }
  }

  spans.sort((a, b) => a.start - b.start);

  // Ordinals are per-kind and count only what is actually redacted, exactly as
  // the real placeholder does.
  const counts = {};
  for (const s of spans) {
    if (!s.ok) continue;
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    s.ordinal = counts[s.kind];
  }
  return spans;
}

/** The session nonce. Sixteen random bytes in the extension; eight hex here. */
export const NONCE = (() => {
  const b = new Uint8Array(4);
  (globalThis.crypto ?? {}).getRandomValues?.(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('') || '9f2a1b7c';
})();

/** What a span becomes on the wire. */
export function markerFor(span) {
  return `[[PII:${span.kind}:${span.ordinal}:${NONCE}]]`;
}

/**
 * Produces the outbound text: validated detections replaced by markers, forged
 * markers removed entirely, everything else untouched.
 */
export function sanitize(text, spans) {
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start);
    if (s.forged) out += '';
    else if (s.ok) out += markerFor(s);
    else out += s.text;
    at = s.end;
  }
  return out + text.slice(at);
}
