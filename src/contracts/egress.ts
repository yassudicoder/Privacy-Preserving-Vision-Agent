import { ANY_PLACEHOLDER_RE } from './redaction.ts';
import { FENCE_TOKENS, isDataAtom } from './untrusted.ts';
import { HTML_ATTR_NAMES, type SanitizedContext } from './context.ts';

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
  'analysis',
  'containers',
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
  'tag',
  'attrs',
  'container',
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
/** Exactly the fields `toDataAtom` mints. Anything else is smuggled. */
const DATA_ATOM_KEYS: ReadonlySet<string> = new Set(['kind', 'text', 'redacted', 'truncated']);

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
  /*
   * AN ATOM CARRIES FOUR FIELDS AND NOTHING ELSE.
   *
   * `isDataAtom` checks that the four it needs are present and well typed; it
   * does not check that nothing else is. So an object shaped like an atom plus
   * `{ raw: "<the whole row>" }` satisfied the guard, and the walker then SKIPPED
   * it - labels are handled here and excluded from the generic string check - so
   * the extra field passed both gates and reached the wire. The one place the
   * payload is allowed to carry text was the one place text was not counted.
   */
  const extra = Object.keys(value).filter((k) => !DATA_ATOM_KEYS.has(k));
  if (extra.length > 0) {
    out.push({
      code: 'unexpected-field',
      detail: `${where} is a DataAtom carrying [${extra.sort().join(', ')}] - an atom has exactly ${[...DATA_ATOM_KEYS].sort().join(', ')}`,
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
/** A lowercase tag name: letters, digits, hyphens. Custom elements pass; markup never does. */
const TAG_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ROLE_RE = /^[a-z][a-z-]{0,40}$/;
const CONTAINER_KEYS: ReadonlySet<string> = new Set(['tag', 'role', 'attrs', 'parent']);
const ATTR_NAMES: ReadonlySet<string> = new Set(HTML_ATTR_NAMES);

/**
 * Attributes: a closed set of NAMES, each value a DataAtom.
 *
 * `class`, `style`, `onclick` - anything outside `HTML_ATTR_NAMES` - is refused
 * here, which is what keeps "no CSS and no script leave the machine" true of
 * the payload itself rather than of whichever function built it.
 */
function checkAttrs(value: unknown, where: string, out: EgressViolation[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    out.push({ code: 'missing-field', detail: `${where} must be an array` });
    return;
  }
  value.forEach((a: unknown, i: number) => {
    const at = `${where}[${String(i)}]`;
    if (!isObject(a) || Object.keys(a).some((k) => k !== 'key' && k !== 'value')) {
      out.push({ code: 'unexpected-field', detail: `${at} must be exactly {key, value}` });
      return;
    }
    if (typeof a['key'] !== 'string' || !ATTR_NAMES.has(a['key'])) {
      out.push({
        code: 'unexpected-field',
        detail: `${at}.key ${JSON.stringify(a['key'])} is not an attribute the sanitizer emits`,
      });
      return;
    }
    if (a['value'] === null || a['value'] === undefined) {
      out.push({ code: 'missing-field', detail: `${at}.value must be a DataAtom` });
      return;
    }
    checkAtom(a['value'], `${at}.value`, out);
  });
}

function checkContainers(value: unknown, out: EgressViolation[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    out.push({ code: 'missing-field', detail: 'containers must be an array' });
    return;
  }
  value.forEach((c: unknown, i: number) => {
    const at = `containers[${String(i)}]`;
    if (!isObject(c)) {
      out.push({ code: 'missing-field', detail: `${at} must be an object` });
      return;
    }
    for (const key of Object.keys(c)) {
      if (!CONTAINER_KEYS.has(key)) {
        out.push({ code: 'unexpected-field', detail: `${at}."${key}" is not a field the sanitizer emits` });
      }
    }
    if (typeof c['tag'] !== 'string' || !TAG_RE.test(c['tag'])) {
      out.push({ code: 'unexpected-field', detail: `${at}.tag is not a tag name` });
    }
    if (c['role'] !== null && (typeof c['role'] !== 'string' || !ROLE_RE.test(c['role']))) {
      out.push({ code: 'unexpected-field', detail: `${at}.role is not a role name` });
    }
    if (c['parent'] !== null && typeof c['parent'] !== 'number') {
      out.push({ code: 'missing-field', detail: `${at}.parent must be a number or null` });
    }
    checkAttrs(c['attrs'], `${at}.attrs`, out);
  });
}

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
      if (el['tag'] !== undefined && (typeof el['tag'] !== 'string' || !TAG_RE.test(el['tag']))) {
        out.push({ code: 'unexpected-field', detail: `${at}.tag is not a tag name` });
      }
      if (el['container'] !== undefined && el['container'] !== null && typeof el['container'] !== 'number') {
        out.push({ code: 'missing-field', detail: `${at}.container must be a number or null` });
      }
      checkAttrs(el['attrs'], `${at}.attrs`, out);
    });
  }

  checkContainers(candidate['containers'], out);
  out.push(...inspectAnalysis(candidate['analysis']));
  out.push(...inspectScreenshot(candidate['screenshot']));
  out.push(...inspectPlaceholders(candidate, typeof nonce === 'string' ? nonce : ''));

  return out;
}

/**
 * Exactly the keys an analysis may carry, and the ONE that may hold page text.
 *
 * Pinned for the same reason `ALLOWED_KEYS` is: adding a field to
 * `AnalysisShape` fails this check until somebody widens the list on purpose.
 * That matters more here than anywhere else in the payload, because the whole
 * privacy claim of the analysis feature is "numbers leave, rows do not" - and
 * the field that would break it is precisely a new one holding a sample value.
 */
const ALLOWED_ANALYSIS_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'tablesFound',
  'tableIndex',
  'rowsAnalyzed',
  'cellsRead',
  'columns',
  'trends',
  'correlations',
  'outliers',
  'forecasts',
  'series',
  'chartsDetected',
  'computeMs',
  'refusal',
]);

const ALLOWED_COLUMN_KEYS: ReadonlySet<string> = new Set([
  'index',
  'label',
  'kind',
  'n',
  'nMissing',
  'nRedacted',
  'nUnparsed',
  'distinct',
  'stats',
]);

/**
 * Fields that legitimately carry a string, and the COMPLETE set each may hold.
 *
 * Allowing the field NAME alone would be a hole: `method` is a legitimate
 * string field, so `method: "the largest row was Yash, 5000"` would pass. The
 * value is checked against the enum's members, so one of these fields can carry
 * exactly what the engine can mint and nothing else.
 *
 * `direction` appears twice with different vocabularies - rising/falling/flat on
 * a trend, high/low on an outlier - so the union of both is listed. That is
 * looser than per-type checking by four strings and far simpler to keep correct.
 */
const ANALYSIS_ENUMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['kind', new Set(['numeric', 'temporal', 'categorical', 'redacted', 'unknown'])],
  ['direction', new Set(['rising', 'falling', 'flat', 'high', 'low'])],
  ['strength', new Set(['none', 'weak', 'moderate', 'strong'])],
  ['method', new Set(['linear-least-squares', 'last-value', 'moving-average'])],
  ['band', new Set(['low', 'medium', 'high'])],
  ['momentum', new Set(['accelerating', 'steady', 'decelerating'])],
  [
    'refusal',
    new Set([
      'no-table-found',
      'no-numeric-column',
      'too-many-cells',
      'timed-out',
      'all-columns-redacted',
    ]),
  ],
]);

/**
 * The analysis half of the gate.
 *
 * WHAT IT ENFORCES, and why each rule is here rather than trusted to the type:
 * the nominal brand is stripped by JSON the moment the context crosses the
 * Chrome offscreen boundary, so on the other side `analysis` is a plain object
 * that a compiler can no longer say anything about.
 *
 *  - Only pinned keys, at both levels. A new field carrying "the top 5 values"
 *    is refused until this file changes.
 *  - `label` is the ONLY string allowed anywhere in the block, and it must be a
 *    `DataAtom` - so it has been neutralised, fence-defanged and length-capped.
 *  - EVERY other leaf must be a number, a boolean, or null. A string appearing
 *    where a statistic belongs is the signature of a cell value being smuggled
 *    out, and it is refused rather than reported.
 */
export function inspectAnalysis(analysis: unknown): readonly EgressViolation[] {
  if (analysis === null || analysis === undefined) return [];
  if (!isObject(analysis)) {
    return [{ code: 'not-a-context', detail: `analysis is ${typeof analysis}, not an object` }];
  }

  const out: EgressViolation[] = [];
  for (const key of Object.keys(analysis)) {
    if (!ALLOWED_ANALYSIS_KEYS.has(key)) {
      out.push({
        code: 'unexpected-field',
        detail: `analysis."${key}" is not a field the analysis engine emits`,
      });
    }
  }

  const columns = analysis['columns'];
  if (columns !== undefined && !Array.isArray(columns)) {
    out.push({ code: 'missing-field', detail: 'analysis.columns must be an array' });
  } else if (Array.isArray(columns)) {
    columns.forEach((col: unknown, i: number) => {
      const at = `analysis.columns[${String(i)}]`;
      if (!isObject(col)) {
        out.push({ code: 'missing-field', detail: `${at} must be an object` });
        return;
      }
      for (const key of Object.keys(col)) {
        if (!ALLOWED_COLUMN_KEYS.has(key)) {
          out.push({
            code: 'unexpected-field',
            detail: `${at}."${key}" is not a field the analysis engine emits`,
          });
        }
      }
      // The one page-derived string in the whole block.
      checkAtom(col['label'], `${at}.label`, out);
      // Everything else on a column is a number or the `kind` enum.
      for (const [k, v] of Object.entries(col)) {
        if (k === 'label') continue;
        walkAnalysisValue(v, `${at}.${k}`, out);
      }
    });
  }

  for (const [k, v] of Object.entries(analysis)) {
    /*
     * `columns` is walked above, where the label atom is checked properly.
     * Everything else - including `refusal` - goes through the value-checked
     * walker, so a fixed enum is verified rather than exempted.
     */
    if (k === 'columns') continue;
    walkAnalysisValue(v, `analysis.${k}`, out);
  }

  return out;
}

/**
 * EVERY LEAF IN AN ANALYSIS MUST BE A NUMBER, A BOOLEAN, NULL, OR A DECLARED ENUM.
 *
 * Walked generically rather than field by field, so a statistic added later is
 * covered without this function being updated. The failure worth defending
 * against is a NEW field carrying text, and a hand-written list of known fields
 * would not see one.
 *
 * Shared by the column loop and the top level so both apply the identical rule -
 * two copies of a check like this drift, and the one that drifts is the one
 * nobody is looking at.
 */
function walkAnalysisValue(value: unknown, path: string, out: EgressViolation[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'number' || typeof value === 'boolean') return;

  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkAnalysisValue(v, `${path}[${String(i)}]`, out);
    });
    return;
  }

  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) walkAnalysisValue(v, `${path}.${k}`, out);
    return;
  }

  if (typeof value === 'string') {
    /*
     * An enum field may hold exactly what the engine can mint. Checking the
     * VALUE and not merely the field name is the point: `method` is a
     * legitimate string field, and without this a cell value assigned to it
     * would pass the gate wearing a permitted name.
     */
    const key = path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '');
    const allowed = ANALYSIS_ENUMS.get(key);
    if (allowed !== undefined && allowed.has(value)) return;
    out.push({
      code: 'unquoted-page-text',
      detail:
        allowed === undefined
          ? `${path} is a string; only a column label or a declared enum may carry text in an analysis`
          : `${path} is "${value.slice(0, 24)}", which is not a value the engine can produce`,
    });
    return;
  }

  // A function, a symbol, a bigint - none of which the engine emits.
  out.push({
    code: 'unexpected-field',
    detail: `${path} is ${typeof value}, which an analysis never contains`,
  });
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
