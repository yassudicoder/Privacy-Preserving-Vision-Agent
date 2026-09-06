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
          `ref "${String(action.ref)}" is not a text field; use click for buttons and links`,
        );
      }
      if (action.text.length > ctx.maxTypeChars) {
        return parseErr(
          'text-too-long',
          `text is ${action.text.length} chars, limit is ${ctx.maxTypeChars}`,
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
