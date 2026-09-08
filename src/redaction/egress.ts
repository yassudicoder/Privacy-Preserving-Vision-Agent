import {
  type EgressViolation,
  type PiiKind,
  type SanitizedContext,
  ANY_PLACEHOLDER_RE,
  isDataAtom,
} from '@/contracts/index.ts';
import { scanTextPatterns } from './patterns.ts';

/**
 * The second egress gate: is there still PII in what we are about to send?
 *
 * `contracts/egress.ts` checks the SHAPE - that the payload is the thing the
 * sanitizer produces, that its placeholders carry this session's nonce, that its
 * screenshot's counters say every op that could land did. This one checks the
 * CONTENT, by running the same detectors that produced the redaction over the
 * text that is about to leave.
 *
 * WHY IT LIVES HERE AND NOT IN CONTRACTS. It needs `scanTextPatterns`, which is
 * this module's. `contracts` may import nothing, and `agent-server` may import
 * only `contracts` - so the shape gate can run inside the network client and
 * this one cannot. `orchestrator` is the layer that sees both, and it calls this
 * before it calls `client.plan`. Two gates at two layers, neither optional.
 *
 * WHY A FINDING HERE IS ALMOST CERTAINLY REAL. The redactor scanned the page
 * text at `minConfidence` and replaced what it found with placeholders. This
 * scans the ALREADY-REDACTED text at the SAME threshold. Anything that matches
 * now is something the redactor was configured to catch and did not - the two
 * scanners are the same code with the same setting, so they can only disagree
 * where the text they see differs (a value assembled across nodes, a group name
 * lifted from a heading). That is the residual false-positive class, and it is
 * small enough that refusing is the right trade.
 *
 * WHY IT REFUSES RATHER THAN STRIPS. Stripping would send a payload nobody
 * verified, produced by a code path that has just been shown to be wrong about
 * this page. The step degrades instead, and the panel says which kind fired.
 * This is the same call `step.ts` already makes for an uncovered screenshot.
 *
 * WHAT IT DOES NOT SCAN, and why:
 *
 *  - `goal` and `clarifications[].answer`. Those are what the USER TYPED.
 *    `SanitizedContext` documents `goal` as "Comes from the USER, never from the
 *    page", and a user whose task is "email the invoice to me@example.com" has
 *    authored that address deliberately. Refusing it would block the product to
 *    protect the user from themselves, and do so invisibly from their side.
 *
 *    `clarifications[].question` IS scanned, and the first version of this file
 *    got that wrong - it excluded the whole `Clarification` as "user-authored".
 *    Only half of one is. The QUESTION is composed by `detectAmbiguity` from the
 *    page's own accessible names, so on a page whose button is labelled with an
 *    email address the question contains that address, and it is then carried in
 *    `SanitizedContext.clarifications` on every later step of the task. The
 *    names have already been through `toDataAtom` and are redacted, so this is a
 *    backstop rather than a known hole - but "already redacted" is exactly the
 *    claim every other field in this scan is also making.
 *  - `screenshot.base64`. Image bytes are not text; a long base64 run trips the
 *    card and phone rules constantly and means nothing. The screenshot is
 *    checked by its op counters instead, in `contracts/egress.ts`, which is a
 *    real check rather than a pattern match on noise.
 *  - `url`. Already reduced to origin + path shape by `sanitizeUrl`, with query
 *    and fragment stripped - which is where a token or an email in a URL lives.
 */

/** Where the leak was found. Field paths only - never the offending value. */
export interface LeakFinding {
  readonly kind: PiiKind;
  readonly rule: string;
  readonly confidence: number;
  /** e.g. `elements[12].value`. Enough to fix, not enough to leak. */
  readonly field: string;
}

export interface RedactionVerdict {
  readonly ok: boolean;
  readonly findings: readonly LeakFinding[];
  /** Shape-level problems, in the same vocabulary `contracts/egress.ts` uses. */
  readonly violations: readonly EgressViolation[];
  /** How many text fields were actually scanned. Zero would mean this did nothing. */
  readonly fieldsScanned: number;
}

/**
 * Markup that should never appear in a sanitized field.
 *
 * `buildSanitizedContext` emits accessible names and control values, never
 * serialised markup. A tag here means raw HTML took a route around the
 * sanitizer, which is the single worst thing that could be in this payload -
 * it would carry every value on the page, redacted or not.
 */
const RAW_MARKUP_RE = /<\s*(?:html|body|head|script|iframe|form|input|div|span|table)\b/i;

interface Field {
  readonly path: string;
  readonly text: string;
}

/**
 * The page-derived text in a context, with its field paths.
 *
 * Exported for the tests, which assert that a value planted in each field is
 * actually reached - a scanner that silently covers three fields out of six
 * passes every test written against the three.
 */
export function outboundTextFields(ctx: SanitizedContext): readonly Field[] {
  const fields: Field[] = [];

  const push = (path: string, atom: unknown): void => {
    if (atom === null || atom === undefined) return;
    if (isDataAtom(atom)) {
      if (atom.text !== '') fields.push({ path, text: atom.text });
      return;
    }
    /*
     * Not a DataAtom. `contracts/egress.ts` raises that as
     * `unquoted-page-text`; here it is scanned anyway when it is a string,
     * because a field that took a route around `toDataAtom` is the LAST field
     * that should escape a content check.
     */
    if (typeof atom === 'string' && atom !== '') fields.push({ path, text: atom });
  };

  push('title', ctx.title);

  ctx.elements.forEach((el, i) => {
    push(`elements[${String(i)}].name`, el.name);
    push(`elements[${String(i)}].groupName`, el.groupName);
    push(`elements[${String(i)}].value`, el.value);
  });

  /*
   * History carries the accessible name AS IT WAS when the action ran - a plain
   * string, not a DataAtom, taken from an already-sanitized element. It is still
   * page-derived and it still travels, so it is still scanned.
   */
  /*
   * Analysis column LABELS. They are table headers - page-authored, therefore
   * exactly as capable of carrying an email address as any other cell.
   *
   * `outboundTextFields` is a hand-written list with no reflection over keys, so
   * a new field is NOT rescanned automatically; it has to be pushed here. The
   * rest of an analysis is numbers, and `contracts/egress.ts` refuses any string
   * that is not a label - so this covers the whole text surface of the block.
   */
  (ctx.analysis?.columns ?? []).forEach((col, i) => {
    push(`analysis.columns[${String(i)}].label`, col.label);
  });

  ctx.history.forEach((step, i) => {
    push(`history[${String(i)}].name`, step.name);
    push(`history[${String(i)}].note`, step.note);
  });

  /*
   * The QUESTION only. The ANSWER is what the user typed and is deliberately
   * left alone; the question is composed by `detectAmbiguity` from the page's
   * own accessible names, which makes it page-derived text that then travels on
   * every later step of the same task.
   */
  ctx.clarifications.forEach((c, i) => {
    push(`clarifications[${String(i)}].question`, c.question);
  });

  return fields;
}

export interface VerifyOptions {
  /**
   * The threshold the redactor ran at.
   *
   * Passed rather than defaulted so the two scanners cannot drift: a redactor
   * running at 0.5 and a verifier running at 0.3 would refuse every step on
   * detections the redactor was deliberately configured to ignore.
   */
  readonly minConfidence: number;
}

/**
 * Runs the PII detectors over what is about to be sent.
 *
 * Returns a verdict rather than throwing, because the CALLER decides the
 * consequence and there is more than one sensible consequence: the orchestrator
 * fails the step, while a test asserts the findings. `assertNoLeak` is the
 * throwing form for call sites that want fail-closed with no thinking.
 */
export function verifyOutboundRedaction(
  ctx: SanitizedContext,
  opts: VerifyOptions,
): RedactionVerdict {
  const fields = outboundTextFields(ctx);
  const findings: LeakFinding[] = [];
  const violations: EgressViolation[] = [];

  for (const field of fields) {
    if (RAW_MARKUP_RE.test(field.text)) {
      violations.push({
        code: 'unquoted-page-text',
        detail: `${field.path} contains raw markup - sanitized fields carry text, never HTML`,
      });
    }

    /*
     * Placeholders are removed before scanning.
     *
     * `[[PII:PHONE:3:9f2a...]]` contains a digit run and a hex tail, and the
     * phone and id rules will happily match inside it. Scanning the placeholder
     * that PROVES a redaction happened, and reporting it as a leak, would make
     * the verifier fire hardest on the pages it protected best.
     */
    const scannable = field.text.replace(ANY_PLACEHOLDER_RE, ' ');
    for (const match of scanTextPatterns(scannable, opts.minConfidence)) {
      findings.push({
        kind: match.kind,
        rule: match.rule,
        confidence: match.confidence,
        field: field.path,
        // `match.value` is deliberately NOT carried. This object reaches the
        // panel, the timeline and the receipt; putting the leaked value in the
        // leak report would leak it.
      });
    }
  }

  return {
    ok: findings.length === 0 && violations.length === 0,
    findings,
    violations,
    fieldsScanned: fields.length,
  };
}

/** Thrown by `assertNoLeak`. Names kinds and fields, never values. */
export class OutboundLeakError extends Error {
  readonly verdict: RedactionVerdict;

  constructor(verdict: RedactionVerdict) {
    const kinds = [...new Set(verdict.findings.map((f) => f.kind))].join(', ');
    const fields = [...new Set(verdict.findings.map((f) => f.field))].slice(0, 6).join(', ');
    const shape = verdict.violations.map((v) => v.detail).join('; ');
    super(
      'outbound context BLOCKED: unredacted content found after sanitization' +
        (kinds === '' ? '' : ` - ${String(verdict.findings.length)} ${kinds} in ${fields}`) +
        (shape === '' ? '' : ` - ${shape}`),
    );
    this.name = 'OutboundLeakError';
    this.verdict = verdict;
  }
}

/** Fail-closed form. Throws on any finding; returns the verdict otherwise. */
export function assertNoLeak(ctx: SanitizedContext, opts: VerifyOptions): RedactionVerdict {
  const verdict = verifyOutboundRedaction(ctx, opts);
  if (!verdict.ok) throw new OutboundLeakError(verdict);
  return verdict;
}
