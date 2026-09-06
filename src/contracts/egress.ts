import { ANY_PLACEHOLDER_RE } from './redaction.ts';
import { FENCE_TOKENS, isDataAtom } from './untrusted.ts';
import type { SanitizedContext } from './context.ts';

/**
 * The last check before bytes leave the machine.
 *
 * WHY THIS EXISTS WHEN THE TYPE SYSTEM ALREADY SAYS SO. `SanitizedContext` is
 * nominal and only `redaction/sanitize.ts` may mint one, which is a strong
 * guarantee right up until a value crosses a message boundary. On Chrome it does
 * exactly that twice per step: the context is built in the offscreen document
 * and JSON-serialised back to the service worker, where `receiveSanitizedContext`
 * RE-BRANDS a plain object. `createRemoteDomPipeline` says so in its own
 * comment. From that point the nominal type is an assertion about history rather
 * than a fact about the value in hand.
 *
 * So this file re-establishes at runtime what the compiler can no longer see,
 * and it does it at EGRESS - the moment before a request is written to a socket
 * - rather than at construction, because that is where being wrong is expensive.
 *
 * IT FAILS CLOSED. Every function here returns violations or throws; none of
 * them repairs a payload. A guard that strips the offending field and sends the
 * rest would turn "we found a leak" into "we sent something", and the whole
 * point is that a leak stops the request. The step degrades - text-only, or a
 * failed step - and the panel says which check fired.
 *
 * WHAT IT CANNOT DO, stated plainly so nobody reads more into it: it cannot
 * prove a value was redacted, because it never saw the original. It proves the
 * payload has the STRUCTURE only the redaction pipeline produces, that its
 * placeholders carry this session's nonce, that its screenshot's own counters
 * say every op that could land did land, and that no key exists which the
 * sanitizer does not emit. The deeper "is there still an email address in here"
 * check needs the PII detectors and therefore lives in `redaction/egress.ts`,
 * one module up. Both run.
 */

export type EgressViolationCode =
  /** Not an object, or the wrong schema version. */
  | 'not-a-context'
  /** A field the sanitizer always emits is missing or the wrong type. */
  | 'missing-field'
  /**
   * A key the sanitizer never emits.
   *
   * This is the check that catches a raw frame, raw HTML, a DOM path or a token
   * being bolted onto the payload later. Everything the server needs is already
   * in the known set, so an extra key is either a mistake or an exfiltration.
   */
  | 'unexpected-field'
  /**
   * Page-derived text that is not a `DataAtom`.
   *
   * A bare string here means something reached the payload without passing
   * `toDataAtom`, which is what neutralises control characters, bidi marks and
   * fence tokens and applies the length cap. An empty object `{}` means an
   * `Untrusted` wrapper was serialised - symbol keys do not survive JSON - and
   * is the signature of raw page text taking a route it was never meant to.
   */
  | 'unquoted-page-text'
  /** A prompt fence token survived into network-bound text. */
  | 'fence-token'
  /**
   * A redaction placeholder carrying somebody else's nonce.
   *
   * Always an attack. A page that prints `[[PII:EMAIL:1:deadbeef]]` is trying to
   * make the server believe a field was redacted when it was not.
   */
  | 'forged-placeholder'
  /** The screenshot's own counters say a pixel op that could have landed did not. */
  | 'unverified-screenshot'
  /** The screenshot is not the shape `bakeRedactions` produces. */
  | 'unbaked-screenshot';

export interface EgressViolation {
  readonly code: EgressViolationCode;
  /** Names the field and the problem. Never quotes the offending VALUE. */
  readonly detail: string;
}

/**
 * Exactly the keys `buildSanitizedContext` emits.
 *
 * Pinned rather than derived, so adding a field to `SanitizedContextShape`
 * fails this check until someone deliberately widens the list - which is the
 * same treatment `unsafeUnwrap` call sites and `permissions.request` get, and
 * for the same reason.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'taskId',
  'step',
  'goal',
  'url',
  'title',
  'viewport',
  'elements',
  'screenshot',
  'redactionSummary',
  'nonce',
  'history',
  'clarifications',
  'budget',
]);

const ALLOWED_ELEMENT_KEYS: ReadonlySet<string> = new Set([
  'ref',
  'role',
  'name',
  'groupName',
  'value',
  'rect',
  'states',
  'isSensitive',
]);

const SCREENSHOT_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Page-derived text must be a DataAtom, and its text must be clean.
 *
 * Null is fine - plenty of elements have no accessible name. Anything else that
 * is not a DataAtom is the failure this code exists to catch.
 */
function checkAtom(
  value: unknown,
  where: string,
  out: EgressViolation[],
): void {
  if (value === null || value === undefined) return;
  if (!isDataAtom(value)) {
    const shape = isObject(value)
      ? Object.keys(value).length === 0
        ? 'an empty object (a serialised Untrusted wrapper)'
        : `an object with keys [${Object.keys(value).sort().join(', ')}]`
      : typeof value;
    out.push({
      code: 'unquoted-page-text',
      detail: `${where} is ${shape}, not a DataAtom - it did not pass toDataAtom()`,
    });
    return;
  }
  for (const token of FENCE_TOKENS) {
    if (value.text.includes(token)) {
      out.push({
        code: 'fence-token',
        detail: `${where} contains the prompt fence token ${JSON.stringify(token)} un-neutralised`,
      });
      return;
    }
  }
}

/**
 * Every violation in a candidate payload. Empty means it may be sent.
 *
 * Takes `unknown` on purpose. A function that only accepts `SanitizedContext`
 * could not check a value that arrived over a message boundary, which is the
 * exact case that needs checking.
 */
export function inspectOutboundContext(candidate: unknown): readonly EgressViolation[] {
  const out: EgressViolation[] = [];

  if (!isObject(candidate)) {
    return [{ code: 'not-a-context', detail: `payload is ${typeof candidate}, not an object` }];
  }
  if (candidate['schemaVersion'] !== 1) {
    return [
      {
        code: 'not-a-context',
        detail: `schemaVersion is ${JSON.stringify(candidate['schemaVersion'])}, expected 1`,
      },
    ];
  }

  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_KEYS.has(key)) {
      out.push({
        code: 'unexpected-field',
        detail: `"${key}" is not a field the sanitizer emits`,
      });
    }
  }

  const req = (key: string, ok: boolean, expected: string): void => {
    if (!ok) out.push({ code: 'missing-field', detail: `${key} must be ${expected}` });
  };

  req('taskId', typeof candidate['taskId'] === 'string', 'a string');
  req('step', typeof candidate['step'] === 'number', 'a number');
  req('goal', typeof candidate['goal'] === 'string', 'a string');
  req('url', typeof candidate['url'] === 'string', 'a string');
  req('viewport', isObject(candidate['viewport']), 'an object');
  req('redactionSummary', isObject(candidate['redactionSummary']), 'an object');
  req('budget', isObject(candidate['budget']), 'an object');
  req('history', Array.isArray(candidate['history']), 'an array');
  req('clarifications', Array.isArray(candidate['clarifications']), 'an array');
  req('elements', Array.isArray(candidate['elements']), 'an array');

  const nonce = candidate['nonce'];
  req('nonce', typeof nonce === 'string' && nonce !== '', 'a non-empty string');

  checkAtom(candidate['title'], 'title', out);

  const elements = candidate['elements'];
  if (Array.isArray(elements)) {
    elements.forEach((el: unknown, i: number) => {
      const at = `elements[${String(i)}]`;
      if (!isObject(el)) {
        out.push({ code: 'missing-field', detail: `${at} must be an object` });
        return;
      }
      for (const key of Object.keys(el)) {
        if (!ALLOWED_ELEMENT_KEYS.has(key)) {
          out.push({
            code: 'unexpected-field',
            detail: `${at}."${key}" is not a field the sanitizer emits`,
          });
        }
      }
      req(`${at}.ref`, typeof el['ref'] === 'string', 'a string');
      req(`${at}.role`, typeof el['role'] === 'string', 'a string');
      req(`${at}.isSensitive`, typeof el['isSensitive'] === 'boolean', 'a boolean');
      checkAtom(el['name'], `${at}.name`, out);
      checkAtom(el['groupName'], `${at}.groupName`, out);
      checkAtom(el['value'], `${at}.value`, out);
    });
  }

  out.push(...inspectScreenshot(candidate['screenshot']));
  out.push(...inspectPlaceholders(candidate, typeof nonce === 'string' ? nonce : ''));

  return out;
}

/**
 * The screenshot half of the gate.
 *
 * A raw frame does not have these fields - `CapturedFrame` carries a frameId,
 * dimensions and base64 with no op counters at all - so requiring them is what
 * makes "only a baked image may be sent" a runtime fact and not only a type.
 *
 * The counter rule is the one from `orchestrator/step.ts`, restated at egress
 * because that is where it actually matters: a screenshot shows the VIEWPORT
 * while the DOM scan reads the whole document, so ops that fell outside the
 * frame were never in the picture and correctly did not apply. Ops that
 * OVERLAPPED the frame and did not apply are a redaction that was supposed to
 * happen and did not.
 */
export function inspectScreenshot(shot: unknown): readonly EgressViolation[] {
  if (shot === null || shot === undefined) return [];
  if (!isObject(shot)) {
    return [{ code: 'unbaked-screenshot', detail: `screenshot is ${typeof shot}, not an object` }];
  }

  const out: EgressViolation[] = [];
  const num = (k: string): number | null =>
    typeof shot[k] === 'number' && Number.isFinite(shot[k]) ? (shot[k] as number) : null;

  const base64 = shot['base64'];
  if (typeof base64 !== 'string' || base64 === '') {
    out.push({ code: 'unbaked-screenshot', detail: 'screenshot.base64 must be a non-empty string' });
  }
  const format = shot['format'];
  if (typeof format !== 'string' || !SCREENSHOT_FORMATS.has(format)) {
    out.push({
      code: 'unbaked-screenshot',
      detail: `screenshot.format must be jpeg or png, got ${JSON.stringify(format)}`,
    });
  }
  const width = num('width');
  const height = num('height');
  if (width === null || width <= 0 || height === null || height <= 0) {
    out.push({ code: 'unbaked-screenshot', detail: 'screenshot must carry positive dimensions' });
  }

  const applied = num('opsApplied');
  const requested = num('opsRequested');
  const outside = num('opsOutsideFrame');
  if (applied === null || requested === null || outside === null) {
    /*
     * The distinguishing check. `bakeRedactions` is the only function that can
     * produce these three counters, so their ABSENCE means the image was not
     * baked - it is a raw capture wearing the field name.
     */
    out.push({
      code: 'unbaked-screenshot',
      detail:
        'screenshot is missing the opsApplied/opsRequested/opsOutsideFrame counters that only bakeRedactions() produces',
    });
    return out;
  }

  const shouldHaveLanded = requested - outside;
  if (shouldHaveLanded > applied) {
    out.push({
      code: 'unverified-screenshot',
      detail:
        `${String(shouldHaveLanded)} pixel op(s) overlapped the captured frame but only ` +
        `${String(applied)} applied - the image would still show what the text redaction removed`,
    });
  }
  return out;
}

/**
 * Every placeholder in the payload must carry this session's nonce.
 *
 * Serialised and scanned WHOLE rather than field by field, because the point is
 * to catch a forgery wherever it ended up, including in a field that was added
 * after this file was written.
 */
function inspectPlaceholders(candidate: Record<string, unknown>, nonce: string): EgressViolation[] {
  if (nonce === '') return [];
  let blob: string;
  try {
    blob = JSON.stringify(candidate);
  } catch {
    return [{ code: 'not-a-context', detail: 'payload is not JSON-serialisable' }];
  }
  const found = blob.match(ANY_PLACEHOLDER_RE) ?? [];
  const foreign = found.filter((token) => !token.includes(`:${nonce}]]`));
  if (foreign.length === 0) return [];
  return [
    {
      code: 'forged-placeholder',
      // COUNT, never the token: a forged token is page-authored text.
      detail: `${String(foreign.length)} redaction placeholder(s) carry a nonce that is not this session's`,
    },
  ];
}

/** Thrown by `assertOutboundContext`. Carries every violation, not just the first. */
export class EgressBlockedError extends Error {
  readonly violations: readonly EgressViolation[];

  constructor(violations: readonly EgressViolation[]) {
    const codes = [...new Set(violations.map((v) => v.code))].join(', ');
    super(
      `outbound context BLOCKED before transmission (${codes}): ` +
        violations.map((v) => v.detail).join('; '),
    );
    this.name = 'EgressBlockedError';
    this.violations = violations;
  }
}

/**
 * Refuse to send anything that is not a sanitized context.
 *
 * Throws rather than returning a result, so a caller cannot accidentally ignore
 * it - `if (!ok) {}` is a plausible mistake and a silent one, and this is the
 * check that must not be silently ignorable.
 */
export function assertOutboundContext(candidate: unknown): asserts candidate is SanitizedContext {
  const violations = inspectOutboundContext(candidate);
  if (violations.length > 0) throw new EgressBlockedError(violations);
}
