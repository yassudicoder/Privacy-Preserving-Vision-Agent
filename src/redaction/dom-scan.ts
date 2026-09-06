import {
  type Detection,
  type DetectionSource,
  type DomPath,
  type PiiKind,
  type RectProvider,
  countForgedPlaceholders,
  detectionId,
  domPath,
  parseRectAttr,
  saltedHash,
  stripForgedPlaceholders,
  TEST_SALT,
} from '@/contracts/index.ts';
import { charClassOf, scanTextPatterns } from './patterns.ts';

/**
 * DOM-side PII detection. Pure over a Document, so it runs identically in the
 * content script and in jsdom under vitest.
 *
 * Three tiers, in descending precision:
 *   1. Structural truth - input[type=password] IS a password field.
 *   2. Declared intent  - autocomplete tokens the site author wrote.
 *   3. Heuristics       - names, ids, labels, placeholders. Guessing, so low confidence.
 * Plus text-content scanning via the validated pattern bank.
 */

export interface DomScanOptions {
  readonly rectOf?: RectProvider;
  readonly salt?: string;
  readonly minConfidence?: number;
}

export interface DomScanResult {
  readonly detections: readonly Detection[];
  /** Placeholder-shaped strings the page was carrying. Always an attack, never a coincidence. */
  readonly forgeriesStripped: number;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export function canonicalPath(el: Element): DomPath {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur !== null) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent === null) {
      parts.unshift(tag);
      break;
    }
    let idx = 1;
    for (const sib of Array.from(parent.children)) {
      if (sib === cur) break;
      if (sib.tagName === cur.tagName) idx++;
    }
    parts.unshift(`${tag}:nth-of-type(${idx})`);
    cur = parent;
  }
  return domPath(parts.join('>'));
}

export function resolveDomPath(doc: Document, path: DomPath): Element | null {
  try {
    return doc.querySelector(String(path));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// roles and names
// ---------------------------------------------------------------------------

const INPUT_TYPE_ROLE: Readonly<Record<string, string>> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

export function elementRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit.trim() !== '') return explicit.trim();

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'select':
      return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'img':
      return 'img';
    case 'form':
      return 'form';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'label':
      return 'label';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      return INPUT_TYPE_ROLE[type] ?? 'textbox';
    }
    default:
      return 'generic';
  }
}

/** Accessible name, in roughly the order the accname spec resolves them. */
export function accessibleName(el: Element): string | null {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const doc = el.ownerDocument;
    const names = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? '')
      .filter((s) => s !== '');
    if (names.length > 0) return names.join(' ');
  }

  const id = el.getAttribute('id');
  if (id !== null && id !== '') {
    const doc = el.ownerDocument;
    let label: Element | null = null;
    try {
      label = doc.querySelector(`label[for="${CSS_escape(id)}"]`);
    } catch {
      label = null;
    }
    const text = label?.textContent?.trim();
    if (text !== undefined && text !== '') return text;
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel !== null) {
    const text = wrappingLabel.textContent?.trim();
    if (text !== undefined && text !== '') return text;
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim();

  const alt = el.getAttribute('alt');
  if (alt !== null && alt.trim() !== '') return alt.trim();

  const title = el.getAttribute('title');
  if (title !== null && title.trim() !== '') return title.trim();

  const role = elementRole(el);
  if (role === 'button' || role === 'link' || role === 'heading' || role === 'label') {
    const text = el.textContent?.trim();
    if (text !== undefined && text !== '') return text.slice(0, 120);
  }

  return null;
}

/** Minimal CSS.escape - jsdom has it, but older content-script environments may not. */
function CSS_escape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Read the current value of a form control.
 *
 * A <textarea> holds its value in a TEXT NODE, not in a @value attribute.
 * getAttribute('value') returns null on one, and setAttribute('value', '')
 * does nothing at all - so a textarea full of PII sails straight through a
 * naive drop-attribute. Every value read and write goes through this pair.
 */
export function readControlValue(el: Element): string | null {
  if (el.tagName === 'TEXTAREA') return el.textContent ?? '';
  return el.getAttribute('value');
}

export function writeControlValue(el: Element, value: string): void {
  if (el.tagName === 'TEXTAREA') {
    el.textContent = value;
    return;
  }
  el.setAttribute('value', value);
}

// ---------------------------------------------------------------------------
// signal tables
// ---------------------------------------------------------------------------

const INPUT_TYPE_PII: Readonly<Record<string, PiiKind>> = {
  password: 'password',
  email: 'email',
  tel: 'phone',
};

const AUTOCOMPLETE_PII: Readonly<Record<string, PiiKind>> = {
  'cc-number': 'credit-card',
  'cc-csc': 'cvv',
  'cc-name': 'person-name',
  'current-password': 'password',
  'new-password': 'password',
  'one-time-code': 'otp',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  name: 'person-name',
  'given-name': 'person-name',
  'family-name': 'person-name',
  'additional-name': 'person-name',
  'street-address': 'postal-address',
  'address-line1': 'postal-address',
  'address-line2': 'postal-address',
  'address-level1': 'postal-address',
  'address-level2': 'postal-address',
  'postal-code': 'postal-address',
  bday: 'dob',
  'bday-day': 'dob',
  'bday-month': 'dob',
  'bday-year': 'dob',
};

/** Keyword heuristics. Anchored to word boundaries - "pan" must not match "company". */
const KEYWORD_RULES: readonly { readonly re: RegExp; readonly kind: PiiKind; readonly confidence: number }[] = [
  { re: /\b(aadhaar|aadhar|uidai)\b/i, kind: 'aadhaar', confidence: 0.78 },
  { re: /\bpan\s*(card|number|no)\b|\bpan\b(?=\s*[:=])/i, kind: 'pan', confidence: 0.75 },
  { re: /\bpassport\b/i, kind: 'passport', confidence: 0.75 },
  { re: /\b(ssn|social\s*security)\b/i, kind: 'ssn', confidence: 0.78 },
  { re: /\b(cvv|cvc|security\s*code)\b/i, kind: 'cvv', confidence: 0.82 },
  { re: /\b(card\s*number|cardnumber|credit\s*card|debit\s*card)\b/i, kind: 'credit-card', confidence: 0.8 },
  { re: /\b(otp|one[\s-]*time[\s-]*(code|password))\b/i, kind: 'otp', confidence: 0.8 },
  { re: /\bifsc\b/i, kind: 'ifsc', confidence: 0.85 },
  { re: /\b(account\s*(number|no)|acct\s*no)\b/i, kind: 'bank-account', confidence: 0.7 },
  { re: /\b(dob|date\s*of\s*birth|birth\s*date)\b/i, kind: 'dob', confidence: 0.75 },
  { re: /\b(street|address\s*line|postal\s*code|pin\s*code|zip)\b/i, kind: 'postal-address', confidence: 0.65 },
  { re: /\b(mobile|phone|contact\s*number)\b/i, kind: 'phone', confidence: 0.7 },
  { re: /\b(e-?mail)\b/i, kind: 'email', confidence: 0.72 },
  { re: /\b(api[\s_-]*key|secret|token)\b/i, kind: 'api-key', confidence: 0.7 },
  { re: /\b(full\s*name|first\s*name|last\s*name|surname)\b/i, kind: 'person-name', confidence: 0.6 },
];

const IMG_VISUAL_RULES: readonly { readonly re: RegExp; readonly kind: PiiKind; readonly confidence: number }[] = [
  { re: /\b(passport|aadhaar|aadhar|licen[sc]e|id\s*card|id\s*proof)\b/i, kind: 'id-document', confidence: 0.8 },
  { re: /\bsignature\b/i, kind: 'signature', confidence: 0.8 },
  { re: /\b(profile\s*(photo|picture)|avatar|headshot|selfie)\b/i, kind: 'face', confidence: 0.65 },
  /*
   * A PHOTOGRAPHED CARD, which no model available to this project can find.
   *
   * The text rules have had a `credit-card` entry all along, so a card NUMBER in
   * the DOM is caught. This array did not, so `<img alt="photo of my debit
   * card">` produced a detection from neither channel: not from text, because
   * there is no number to match, and not from vision, because COCO contains no
   * credit card and no face detector finds one either. It fell straight through.
   *
   * One regex closes more real coverage here than any model on the Hub, at zero
   * bytes and zero milliseconds.
   *
   * DELIBERATELY NARROW. `\bcard\b` alone would take "business card", "gift
   * card", "loyalty card" and "card sorting", and metric 3 scores precision of
   * redaction at 20%. Bare "visa" is excluded for the same reason - a visa is a
   * travel document far more often than it is a payment card - while
   * "mastercard" and "rupay" are unambiguous enough to stand alone.
   */
  {
    re: /\b(credit|debit|bank|payment|atm)[\s_-]*card\b|\bcard[\s_-]*(front|back|scan)\b|\b(mastercard|rupay)\b/i,
    kind: 'credit-card',
    confidence: 0.8,
  },
];

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Remove placeholder-shaped strings the page authored. Runs BEFORE redaction
 * inserts real ones, so a page cannot forge a redaction the log has no record of.
 */
export function stripForgeriesFromDoc(doc: Document): number {
  let count = 0;
  const walker = doc.createTreeWalker(doc.documentElement, 0x00000004 /* SHOW_TEXT */);
  const dirty: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const text = node as Text;
    const found = countForgedPlaceholders(text.data);
    if (found > 0) {
      count += found;
      dirty.push(text);
    }
    node = walker.nextNode();
  }
  for (const text of dirty) {
    text.data = stripForgedPlaceholders(text.data);
  }

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const found = countForgedPlaceholders(attr.value);
      if (found > 0) {
        count += found;
        el.setAttribute(attr.name, stripForgedPlaceholders(attr.value));
      }
    }
  }
  return count;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Reset the id counter so test output is stable across runs. */
export function resetDetectionIds(): void {
  counter = 0;
}

function makeDetection(args: {
  kind: PiiKind;
  source: DetectionSource;
  confidence: number;
  el: Element;
  attr: string | null;
  nodeIndex: number | null;
  textSpan: { start: number; end: number } | null;
  value: string;
  rule: string;
  salt: string;
  rectOf: RectProvider;
}): Detection {
  return {
    id: detectionId(nextId('d')),
    kind: args.kind,
    source: args.source,
    confidence: args.confidence,
    rect: args.rectOf(args.el),
    domPath: canonicalPath(args.el),
    attr: args.attr,
    nodeIndex: args.nodeIndex,
    textSpan: args.textSpan,
    evidence: {
      rule: args.rule,
      valueLength: args.value.length,
      valueHash: saltedHash(args.value, args.salt),
    },
  };
}

/** Default rect provider: real layout in a browser, the fixture attribute in jsdom. */
export const attributeRectProvider: RectProvider = (el) =>
  parseRectAttr(el.getAttribute('data-test-rect'), 'css-viewport');

export function scanDom(doc: Document, opts: DomScanOptions = {}): DomScanResult {
  const salt = opts.salt ?? TEST_SALT;
  const rectOf = opts.rectOf ?? attributeRectProvider;
  const minConfidence = opts.minConfidence ?? 0;
  const out: Detection[] = [];

  const push = (d: Detection): void => {
    if (d.confidence >= minConfidence) out.push(d);
  };

  const forgeriesStripped = stripForgeriesFromDoc(doc);

  // --- tier 0: explicit author or user declaration ------------------------
  for (const el of Array.from(doc.querySelectorAll('[data-sensitive],[data-pii]'))) {
    const declared = el.getAttribute('data-pii') ?? el.getAttribute('data-sensitive') ?? '';
    const kind = (declared.trim() === '' ? 'unknown-sensitive' : declared.trim()) as PiiKind;
    push(
      makeDetection({
        kind,
        source: 'user-rule',
        confidence: 1,
        el,
        attr: null,
        nodeIndex: null,
        textSpan: null,
        value: el.getAttribute('value') ?? el.textContent ?? '',
        rule: 'declared-sensitive',
        salt,
        rectOf,
      }),
    );
  }

  // --- tier 1: structural truth -------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('input'))) {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    const kind = INPUT_TYPE_PII[type];
    if (kind !== undefined) {
      push(
        makeDetection({
          kind,
          source: 'dom-input-type',
          confidence: type === 'password' ? 0.99 : 0.9,
          el,
          attr: 'value',
          nodeIndex: null,
          textSpan: null,
          value: el.getAttribute('value') ?? '',
          rule: `input-type-${type}`,
          salt,
          rectOf,
        }),
      );
    }
  }

  // --- tier 2: declared intent --------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('[autocomplete]'))) {
    const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    for (const token of tokens) {
      const kind = AUTOCOMPLETE_PII[token];
      if (kind === undefined) continue;
      push(
        makeDetection({
          kind,
          source: 'dom-autocomplete',
          confidence: 0.88,
          el,
          attr: 'value',
          nodeIndex: null,
          textSpan: null,
          value: readControlValue(el) ?? '',
          rule: `autocomplete-${token}`,
          salt,
          rectOf,
        }),
      );
      break;
    }
  }

  // --- tier 3: heuristics on names, labels, placeholders ------------------
  for (const el of Array.from(doc.querySelectorAll('input,textarea,select'))) {
    const haystack = [
      el.getAttribute('name') ?? '',
      el.getAttribute('id') ?? '',
      el.getAttribute('placeholder') ?? '',
      accessibleName(el) ?? '',
    ].join(' ');
    if (haystack.trim() === '') continue;

    for (const rule of KEYWORD_RULES) {
      if (!rule.re.test(haystack)) continue;
      push(
        makeDetection({
          kind: rule.kind,
          source: 'dom-heuristic',
          confidence: rule.confidence,
          el,
          attr: 'value',
          nodeIndex: null,
          textSpan: null,
          value: readControlValue(el) ?? '',
          rule: `keyword-${rule.kind}`,
          salt,
          rectOf,
        }),
      );
      break;
    }
  }

  // --- images that announce themselves as identity material ---------------
  for (const el of Array.from(doc.querySelectorAll('img'))) {
    const haystack = [
      el.getAttribute('alt') ?? '',
      el.getAttribute('title') ?? '',
      el.getAttribute('src') ?? '',
      el.getAttribute('class') ?? '',
    ].join(' ');
    for (const rule of IMG_VISUAL_RULES) {
      if (!rule.re.test(haystack)) continue;
      push(
        makeDetection({
          kind: rule.kind,
          source: 'dom-heuristic',
          confidence: rule.confidence,
          el,
          attr: 'src',
          nodeIndex: null,
          textSpan: null,
          value: el.getAttribute('src') ?? '',
          rule: `img-${rule.kind}`,
          salt,
          rectOf,
        }),
      );
      break;
    }
  }

  // --- attribute values that carry PII directly ---------------------------
  const VALUE_ATTRS = ['value', 'placeholder', 'alt', 'title'] as const;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    for (const attr of VALUE_ATTRS) {
      const raw = el.getAttribute(attr);
      if (raw === null || raw === '') continue;
      for (const match of scanTextPatterns(raw)) {
        push(
          makeDetection({
            kind: match.kind,
            source: 'regex',
            confidence: match.confidence,
            el,
            attr,
            nodeIndex: null,
            textSpan: { start: match.start, end: match.end },
            value: match.value,
            rule: match.rule,
            salt,
            rectOf,
          }),
        );
      }
    }
  }

  // --- text content --------------------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    const children = Array.from(el.childNodes);
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node === undefined || node.nodeType !== 3) continue;
      const data = (node as Text).data;
      if (data.trim() === '') continue;
      for (const match of scanTextPatterns(data)) {
        push(
          makeDetection({
            kind: match.kind,
            source: 'regex',
            confidence: match.confidence,
            el,
            attr: null,
            nodeIndex: i,
            textSpan: { start: match.start, end: match.end },
            value: match.value,
            rule: match.rule,
            salt,
            rectOf,
          }),
        );
      }
    }
  }

  return { detections: out, forgeriesStripped };
}

export { charClassOf };
