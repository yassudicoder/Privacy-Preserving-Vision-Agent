import {
  type Action,
  type ActionType,
  type ParseErrorCode,
  type ParseResult,
  ACTION_TYPES,
  elementRef,
  parseErr,
  parseOk,
  neutralize,
  TARGET_KEYS,
  type ElementRef,
  type TargetSpec,
} from '@/contracts/index.ts';

/**
 * parseAction(rawModelOutput) -> ParseResult<Action>
 *
 * Pure, total, and never throws. This is a trust boundary: the string arrives
 * from a server that was itself reasoning over page-derived data, so it is
 * treated as hostile input rather than as a well-formed response.
 *
 * Returns a Result rather than throwing. A thrown exception at a security
 * boundary tends to get caught somewhere generic and turned into a shrug; an
 * explicit error code has to be handled.
 */

/** Find every balanced {...} region, respecting strings and escapes. */
export function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) continue;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unwrap `{ action: {...} }` envelopes the server may emit. */
function unwrapEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  const inner = obj['action'];
  if (isRecord(inner) && typeof inner['type'] === 'string') return inner;
  return obj;
}

function looksLikeAction(obj: Record<string, unknown>): boolean {
  const candidate = unwrapEnvelope(obj);
  const type = candidate['type'];
  return typeof type === 'string' && (ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * How long a question may be.
 *
 * A question is one sentence. Anything longer is a server using the panel as a
 * canvas, and a wall of text above an input box is how a person is talked into
 * typing something.
 */
const MAX_QUESTION_CHARS = 200;

/** A `wait` that names no duration waits this long. */
const DEFAULT_WAIT_MS = 1000;

function str(obj: Record<string, unknown>, key: string): ParseResult<string, ParseErrorCode> {
  const v = obj[key];
  if (v === undefined) return parseErr('missing-field', `missing "${key}"`);
  if (typeof v !== 'string') return parseErr('bad-field-type', `"${key}" must be a string`);
  return parseOk(v);
}

function num(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): ParseResult<number, ParseErrorCode> {
  const v = obj[key];
  if (v === undefined) return parseErr('missing-field', `missing "${key}"`);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return parseErr('bad-field-type', `"${key}" must be a finite number`);
  }
  if (v < min || v > max) {
    return parseErr('out-of-range', `"${key}" must be between ${min} and ${max}`);
  }
  return parseOk(v);
}

function bool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = obj[key];
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): ParseResult<T, ParseErrorCode> {
  const v = obj[key];
  if (v === undefined) return parseErr('missing-field', `missing "${key}"`);
  if (typeof v !== 'string') return parseErr('bad-field-type', `"${key}" must be a string`);
  if (!(allowed as readonly string[]).includes(v)) {
    return parseErr('bad-field-type', `"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return parseOk(v as T);
}

const MAX_TARGET_FIELD_CHARS = 300;

/**
 * An element-addressing action names its element one of two ways.
 *
 *   "target": {...}  what the MODEL sends - the element's tag, attributes and
 *                    text as they appear in the page HTML. Resolved against the
 *                    sent elements by `validateAction`, never here: parse has no
 *                    page. Until then `ref` is the empty string, which no
 *                    allowlist contains, so an action that somehow skipped
 *                    resolution is refused as `unknown-ref` rather than run.
 *   "ref": "e3"      what the client's OWN deterministic planners send - they
 *                    choose from the context directly. The model is never shown
 *                    a ref, so from it this could only be a guess, and a guess
 *                    meets the same allowlist it always did.
 */
function elementAddress(
  obj: Record<string, unknown>,
): ParseResult<{ readonly ref: ElementRef; readonly target?: TargetSpec }, ParseErrorCode> {
  const raw = obj['target'];
  if (raw !== undefined) {
    if (!isRecord(raw)) return parseErr('bad-field-type', '"target" must be an object');
    const spec: { -readonly [K in keyof TargetSpec]: string } = {};
    for (const key of TARGET_KEYS) {
      const v = raw[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' && typeof v !== 'number') {
        return parseErr('bad-field-type', `"target.${key}" must be a string`);
      }
      const text = String(v).slice(0, MAX_TARGET_FIELD_CHARS);
      if (text.trim() !== '') spec[key] = text;
    }
    if (Object.keys(spec).length === 0) {
      return parseErr('missing-field', `"target" names no field; use ${TARGET_KEYS.join(', ')}`);
    }
    return parseOk({ ref: elementRef(''), target: spec });
  }
  const ref = str(obj, 'ref');
  if (!ref.ok) return parseErr('missing-field', 'missing "target"');
  return parseOk({ ref: elementRef(ref.value) });
}

function buildAction(obj: Record<string, unknown>): ParseResult<Action, ParseErrorCode> {
  const rawType = obj['type'];
  if (typeof rawType !== 'string') return parseErr('missing-type', 'no "type" field');
  if (!(ACTION_TYPES as readonly string[]).includes(rawType)) {
    return parseErr('unknown-type', `unknown action type "${rawType}"`);
  }
  const type = rawType as ActionType;

  switch (type) {
    case 'click': {
      const at = elementAddress(obj);
      if (!at.ok) return at;
      return parseOk({ type: 'click', ...at.value });
    }
    case 'type': {
      const at = elementAddress(obj);
      if (!at.ok) return at;
      const text = str(obj, 'text');
      if (!text.ok) return text;
      return parseOk({
        type: 'type',
        ...at.value,
        text: text.value,
        submit: bool(obj, 'submit', false),
      });
    }
    case 'select': {
      const at = elementAddress(obj);
      if (!at.ok) return at;
      const option = str(obj, 'option');
      if (!option.ok) return option;
      return parseOk({ type: 'select', ...at.value, option: option.value });
    }
    case 'scroll': {
      const direction = oneOf(obj, 'direction', ['up', 'down', 'left', 'right'] as const);
      if (!direction.ok) return direction;
      const amount = obj['amountPx'] === undefined ? parseOk(400) : num(obj, 'amountPx', 0, 100_000);
      if (!amount.ok) return amount;
      return parseOk({ type: 'scroll', direction: direction.value, amountPx: amount.value });
    }
    case 'key': {
      const key = oneOf(obj, 'key', ['Enter', 'Escape', 'Tab', 'Backspace'] as const);
      if (!key.ok) return key;
      return parseOk({ type: 'key', key: key.value });
    }
    case 'navigate': {
      const url = str(obj, 'url');
      if (!url.ok) return url;
      return parseOk({ type: 'navigate', url: url.value });
    }
    case 'wait': {
      /*
       * `ms` DEFAULTS, exactly as `scroll`'s `amountPx` already did. A real
       * amazon.in run on gemini-3.5-flash-lite opened a product page and replied
       * {"type":"wait"} - a sensible action, duration unstated - and the missing
       * field ended a task that had just reached the page it wanted.
       */
      const ms = obj['ms'] === undefined ? parseOk(DEFAULT_WAIT_MS) : num(obj, 'ms', 0, 600_000);
      if (!ms.ok) return ms;
      return parseOk({ type: 'wait', ms: ms.value });
    }
    case 'ask_user': {
      const question = str(obj, 'question');
      if (!question.ok) return question;
      /*
       * NEUTRALISED AND CAPPED AT THE WIRE.
       *
       * This is the ONE thing a server says that is rendered to the user as
       * prose, in the extension's own panel, directly above the input box. It
       * reached `say('agent', q)` raw: no neutralisation, no length cap, and
       * newlines preserved under `white-space: pre-wrap`. A compromised server
       * could compose whatever it liked there, with our credibility.
       *
       * `contracts/context.ts` already states the requirement - "neutralise
       * before rendering it anywhere a person will read it" - and nothing did
       * it. Done here, at parse, so every consumer downstream gets clean text
       * rather than each being trusted to remember.
       *
       * Same treatment page text gets from `toDataAtom`, for the same reason.
       */
      return parseOk({
        type: 'ask_user',
        question: neutralize(question.value).slice(0, MAX_QUESTION_CHARS),
      });
    }
    case 'done': {
      const summary = str(obj, 'summary');
      if (!summary.ok) return summary;
      return parseOk({ type: 'done', summary: summary.value });
    }
    case 'abort': {
      const reason = str(obj, 'reason');
      if (!reason.ok) return reason;
      // Rendered to the user in the panel timeline, exactly as a question is,
      // so it gets the same treatment as a question.
      return parseOk({ type: 'abort', reason: neutralize(reason.value).slice(0, MAX_QUESTION_CHARS) });
    }
  }
}

export function parseAction(rawModelOutput: string): ParseResult<Action, ParseErrorCode> {
  if (typeof rawModelOutput !== 'string' || rawModelOutput.trim() === '') {
    return parseErr('empty-input', 'model output was empty');
  }

  const candidates = extractJsonObjects(rawModelOutput);
  if (candidates.length === 0) {
    return parseErr('no-json-found', 'no JSON object in the model output');
  }

  const parsed: Record<string, unknown>[] = [];
  /** Objects that clearly meant to be an action but named a type we do not have. */
  const unknownTyped: string[] = [];
  let sawMalformed = false;

  for (const chunk of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(chunk);
    } catch {
      sawMalformed = true;
      continue;
    }
    if (!isRecord(value)) continue;
    if (looksLikeAction(value)) {
      parsed.push(unwrapEnvelope(value));
      continue;
    }
    const candidateType = unwrapEnvelope(value)['type'];
    if (typeof candidateType === 'string') unknownTyped.push(candidateType);
  }

  if (parsed.length === 0) {
    // Distinguish "asked for something we do not support" from "this was not an
    // action at all". The first is worth surfacing: it is what an injected or
    // hallucinated capability looks like.
    if (unknownTyped.length > 0) {
      return parseErr('unknown-type', `unknown action type "${unknownTyped[0] ?? ''}"`);
    }
    if (sawMalformed) return parseErr('malformed-json', 'JSON present but unparseable');
    return parseErr('not-an-object', 'no object with a recognised action "type"');
  }

  /*
   * More than one action is a refusal, not a "take the first".
   *
   * The concrete attack: page content persuades the model to append a second
   * action. If we silently took the first, an injected action could ride along
   * whenever the model happened to put it first. Ambiguity here is a security
   * signal, so it fails closed.
   */
  if (parsed.length > 1) {
    return parseErr(
      'multiple-actions',
      `expected exactly one action, found ${parsed.length}`,
    );
  }

  const only = parsed[0];
  if (only === undefined) return parseErr('not-an-object', 'no action object');
  return buildAction(only);
}

/** Rationale and confidence, when the server bothered to send them. */
export function parseRationale(rawModelOutput: string): { rationale: string; confidence: number } {
  for (const chunk of extractJsonObjects(rawModelOutput)) {
    try {
      const value: unknown = JSON.parse(chunk);
      if (!isRecord(value)) continue;
      const rationale = typeof value['rationale'] === 'string' ? value['rationale'] : '';
      const confidence = typeof value['confidence'] === 'number' ? value['confidence'] : 0;
      if (rationale !== '' || confidence !== 0) {
        return { rationale, confidence: Math.max(0, Math.min(1, confidence)) };
      }
    } catch {
      continue;
    }
  }
  return { rationale: '', confidence: 0 };
}
