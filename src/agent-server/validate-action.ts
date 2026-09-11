import {
  type Action,
  type ParseResult,
  type ValidationContext,
  type ValidationErrorCode,
  parseErr,
  parseOk,
} from '@/contracts/index.ts';

/**
 * The runtime half of the untrusted-data rule.
 *
 * `parseAction` proves the model emitted something well-formed. This proves the
 * model stayed inside the vocabulary we gave it. Even a fully compromised
 * server, or a model successfully steered by injected page text, cannot:
 *
 *   - address an element we did not send (`validRefs`)
 *   - type into a field holding PII without explicit user consent
 *   - navigate anywhere but an allow-listed origin
 *   - stall the agent with an unbounded wait
 */

export interface ValidateOptions {
  /** Set only when the user has confirmed this specific step in the UI. */
  readonly userConfirmedSensitive?: boolean;
}

/**
 * Words that make a question a credential prompt.
 *
 * Deliberately about the SECRET being solicited rather than about phrasing -
 * "what is your", "please confirm" and the rest are endless and a paraphrase
 * defeats them. There is no legitimate reason for the planner to need any of
 * these: they are redacted before it sees the page, and the prompt says so.
 */
const SOLICITS_CREDENTIAL =
  /\b(password|passcode|passphrase|pin|otp|one[- ]time (code|password)|cvv|cvc|security code|card number|credit card|debit card|social security|aadhaar|passport number|api[- ]?key|secret key|seed phrase|private key|mfa|2fa|verification code)\b/i;

export function validateAction(
  action: Action,
  ctx: ValidationContext,
  opts: ValidateOptions = {},
): ParseResult<Action, ValidationErrorCode> {
  /*
   * A MODEL-WRITTEN TARGET IS RESOLVED FIRST, against exactly the elements this
   * step sent, and every rule below then judges the element it resolved to - so
   * sensitive, not-typeable and already-typed apply to a target exactly as they
   * did to a ref. No match and several matches are both refusals: the client
   * never picks among candidates on the model's behalf.
   */
  if (
    (action.type === 'click' || action.type === 'type' || action.type === 'select') &&
    action.target !== undefined
  ) {
    const found = ctx.locate?.(action.target) ?? { ok: false as const, reason: 'no-match' as const, count: 0 };
    if (!found.ok) {
      // Keys only, never values: this text becomes the CORRECTION, outside the fence.
      const differ = found.differ ?? [];
      return found.reason === 'ambiguous'
        ? parseErr(
            'ambiguous-target',
            `${String(found.count)} elements match that target, and the client does not pick one. ` +
              (differ.length > 0
                ? `They differ in: ${differ.join(', ')}. Add that to the target, copied from the ` +
                  'one you mean in the PAGE HTML' +
                  /*
                   * `within` can differ where the rendered within="..." does
                   * not: the resolver reads each match's whole section. Seen on
                   * an amazon.in product page, two Add to cart buttons with the
                   * same within="With Exchange ..." sat in different accordion
                   * panels; told to "copy within", the model copied the one
                   * value that could not tell them apart.
                   */
                  (differ.includes('within')
                    ? ' - for within, use text that appears ONLY near the one you mean'
                    : '')
                : 'Nothing sent tells them apart; ask the user which one they mean, or act on ' +
                  'something else'),
          )
        : parseErr(
            'no-such-target',
            'no element in the page HTML matches that target' +
              (found.failedAt === undefined
                ? ''
                : found.failedAt === 'tag'
                  ? ' - there is no element with that tag'
                  : ` - none has that ${found.failedAt}`) +
              '. Copy the tag, attributes and text exactly as they appear there, and use fewer ' +
              'fields if unsure',
          );
    }
    action = { ...action, ref: found.ref };
  }

  switch (action.type) {
    case 'click':
    case 'select': {
      if (!ctx.validRefs.has(action.ref)) {
        return parseErr('unknown-ref', `ref "${String(action.ref)}" was not in the sent context`);
      }
      return parseOk(action);
    }

    case 'type': {
      if (!ctx.validRefs.has(action.ref)) {
        return parseErr('unknown-ref', `ref "${String(action.ref)}" was not in the sent context`);
      }
      if (ctx.sensitiveRefs.has(action.ref) && opts.userConfirmedSensitive !== true) {
        return parseErr(
          'sensitive-target',
          `ref "${String(action.ref)}" holds PII; typing into it needs explicit user confirmation`,
        );
      }
      if (!ctx.typeableRefs.has(action.ref)) {
        /*
         * Refused here rather than in the page.
         *
         * The element exists and the model chose it sensibly - it is simply not
         * something you can type into, and the sent context already said so via
         * its role. Letting it through spends a whole step (capture, redact,
         * plan, execute) to learn what was knowable before the request left.
         */
        return parseErr(
          'not-typeable',
          'that element is not a text field; use click for buttons and links',
        );
      }
      if (action.text.length > ctx.maxTypeChars) {
        return parseErr(
          'text-too-long',
          `text is ${action.text.length} chars, limit is ${ctx.maxTypeChars}`,
        );
      }
      /*
       * A NO-OP IS NOT AN ACTION.
       *
       * Typing text a field already holds cannot change the page, so the step
       * that follows is guaranteed to make no progress. Measured on amazon.in:
       * three consecutive steps typing "iPhone 17" into a box already showing
       * `value="iPhone 17"` in the prompt, each executing successfully, the task
       * ending on no-progress having achieved nothing.
       *
       * Compared case-sensitively and after trimming only the outer whitespace
       * the field itself would have kept. Anything more lenient starts refusing
       * genuine edits - correcting capitalisation IS a change.
       */
      /*
       * ...UNLESS IT SUBMITS. `submit:true` into a field already holding the
       * text is not a no-op - it submits the form, which is exactly the next
       * thing a search box needs. This refusal used to fire regardless, while
       * its own detail told the model to "submit it". So a model that obeyed
       * was refused a second time for obeying. On amazon.in that read as
       * `re-planning once: already-typed at e4` then `refused action:
       * already-typed`, and the next step aborted.
       *
       * The detail names the exact JSON, because "submit it" is not a verb in
       * the action vocabulary and a 3B model cannot be relied on to map it to
       * one. NOT `{"type":"key","key":"Enter"}`: `key` acts on
       * `document.activeElement`, and nothing guarantees the field still has
       * focus a whole step later.
       */
      const current = ctx.currentValues.get(action.ref);
      if (
        !action.submit &&
        current !== undefined &&
        current.trim() === action.text.trim() &&
        action.text !== ''
      ) {
        return parseErr(
          'already-typed',
          'that field already contains that text, so typing it again changes nothing. ' +
            'To submit it, send the same "type" action again with "submit":true; ' +
            'otherwise act on a different element',
        );
      }
      return parseOk(action);
    }

    case 'navigate': {
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        return parseErr('bad-url', `"${action.url}" is not an absolute URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return parseErr('bad-url', `refusing protocol "${url.protocol}"`);
      }
      if (!ctx.allowedOrigins.includes(url.origin)) {
        return parseErr('origin-not-allowed', `origin "${url.origin}" is not allow-listed`);
      }
      return parseOk(action);
    }

    case 'scroll': {
      if (action.amountPx > ctx.maxScrollPx) {
        return parseErr(
          'scroll-too-far',
          `scroll of ${action.amountPx}px exceeds limit ${ctx.maxScrollPx}px`,
        );
      }
      return parseOk(action);
    }

    case 'wait': {
      if (action.ms > ctx.maxWaitMs) {
        return parseErr('wait-too-long', `wait of ${action.ms}ms exceeds limit ${ctx.maxWaitMs}ms`);
      }
      return parseOk(action);
    }

    case 'ask_user': {
      /*
       * A QUESTION THAT ASKS FOR A CREDENTIAL IS REFUSED, NOT WARNED ABOUT.
       *
       * This is the one thing a server says that is shown to the user as prose,
       * in the extension's own panel, above the input box. "Confirm your
       * password to continue" arriving there would be a phishing prompt wearing
       * our UI - and the only defence until now was a line of hint text beside
       * it, which asks the user to out-argue a sentence we chose to display.
       *
       * The prompt already tells the model not to; this is what happens when a
       * server ignores that. Refused rather than stripped, because a question
       * with the credential words removed still means what it meant.
       */
      if (SOLICITS_CREDENTIAL.test(action.question)) {
        return parseErr(
          'asks-for-credential',
          'a question asking for a password, card number or code is never legitimate',
        );
      }
      return parseOk(action);
    }
    case 'key':
    case 'done':
    case 'abort':
      return parseOk(action);
  }
}

/** Parse then validate. The only entry point the orchestrator should call. */
export function parseAndValidate(
  raw: string,
  ctx: ValidationContext,
  parse: (raw: string) => ParseResult<Action, string>,
  opts: ValidateOptions = {},
): ParseResult<Action, string> {
  const parsed = parse(raw);
  if (!parsed.ok) return parsed;
  return validateAction(parsed.value, ctx, opts);
}
