import { describe, expect, it } from 'vitest';
import { type Action, type ValidationContext, elementRef } from '@/contracts/index.ts';
import { parseAction, parseAndValidate, validateAction } from '@/agent-server/index.ts';

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    validRefs: new Set([elementRef('e1'), elementRef('e2'), elementRef('e3')]),
    sensitiveRefs: new Set([elementRef('e2')]),
    // e1/e2/e3 are all typeable by default so the existing cases keep testing
    // what they were written to test; the not-typeable cases override it.
    typeableRefs: new Set([elementRef('e1'), elementRef('e2'), elementRef('e3')]),
    allowedOrigins: ['https://acme.example'],
    maxScrollPx: 5000,
    maxWaitMs: 10_000,
    maxTypeChars: 1000,
    ...overrides,
  };
}

describe('validateAction', () => {
  it('accepts a click on a known ref', () => {
    const r = validateAction({ type: 'click', ref: elementRef('e1') }, ctx());
    expect(r.ok).toBe(true);
  });

  it('rejects a ref that was never sent', () => {
    // The core guarantee: the model can only name elements we chose to expose.
    // Even a fully compromised server cannot address anything else.
    const r = validateAction({ type: 'click', ref: elementRef('e99') }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-ref');
  });

  it('refuses to type into a field holding PII', () => {
    const action: Action = { type: 'type', ref: elementRef('e2'), text: 'hi', submit: false };
    const r = validateAction(action, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('sensitive-target');
  });

  it('allows typing into a sensitive field only with explicit confirmation', () => {
    const action: Action = { type: 'type', ref: elementRef('e2'), text: 'hi', submit: false };
    const r = validateAction(action, ctx(), { userConfirmedSensitive: true });
    expect(r.ok).toBe(true);
  });

  it('rejects over-long text', () => {
    const action: Action = {
      type: 'type',
      ref: elementRef('e1'),
      text: 'x'.repeat(1001),
      submit: false,
    };
    const r = validateAction(action, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('text-too-long');
  });

  describe('navigate', () => {
    it('accepts an allow-listed origin', () => {
      const r = validateAction({ type: 'navigate', url: 'https://acme.example/next' }, ctx());
      expect(r.ok).toBe(true);
    });

    it('rejects an origin that is not allow-listed', () => {
      const r = validateAction({ type: 'navigate', url: 'https://evil.example/steal' }, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('origin-not-allowed');
    });

    it('rejects non-http protocols', () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
        const r = validateAction({ type: 'navigate', url }, ctx());
        expect(r.ok).toBe(false);
      }
    });

    it('rejects a relative URL', () => {
      const r = validateAction({ type: 'navigate', url: '/next' }, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('bad-url');
    });
  });

  it('bounds scroll distance', () => {
    const r = validateAction({ type: 'scroll', direction: 'down', amountPx: 999_999 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('scroll-too-far');
  });

  it('bounds wait duration', () => {
    const r = validateAction({ type: 'wait', ms: 500_000 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('wait-too-long');
  });

  it('lets terminal actions through unconditionally', () => {
    expect(validateAction({ type: 'done', summary: 'ok' }, ctx()).ok).toBe(true);
    expect(validateAction({ type: 'abort', reason: 'stuck' }, ctx()).ok).toBe(true);
    expect(validateAction({ type: 'ask_user', question: 'which one?' }, ctx()).ok).toBe(true);
  });
});

describe('parseAndValidate', () => {
  it('blocks an injected navigate end to end', () => {
    const r = parseAndValidate(
      '{"type":"navigate","url":"http://evil.example/steal"}',
      ctx(),
      parseAction,
    );
    expect(r.ok).toBe(false);
  });

  it('passes a legitimate action end to end', () => {
    const r = parseAndValidate('{"type":"click","ref":"e3"}', ctx(), parseAction);
    expect(r.ok).toBe(true);
  });

  it('surfaces the parse error when parsing fails first', () => {
    const r = parseAndValidate('not json', ctx(), parseAction);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no-json-found');
  });
});

describe('typing at something that cannot be typed into', () => {
  /*
   * FROM A REAL RUN. The model emitted
   * `{"type":"type","ref":"e41","text":"Submit Review","submit":true}` where
   * "Submit Review" is the accessible name of a BUTTON. It had picked the right
   * element and the wrong verb.
   *
   * Validation had no roles, so it passed. The content script then refused with
   * "holds no value", the panel logged `action type failed`, and the step was
   * spent. Four of them in one run, ending in `no-progress`.
   *
   * The role was in the context we SENT. Refusing here costs nothing; refusing
   * in the page costs a capture, a redaction, a plan and a round trip.
   */
  it('refuses type at a button', () => {
    const r = validateAction(
      { type: 'type', ref: elementRef('e3'), text: 'Submit Review', submit: true },
      ctx({ typeableRefs: new Set([elementRef('e1')]) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not-typeable');
      expect(r.error.detail).toMatch(/use click/i);
    }
  });

  it('still accepts type at a real text field', () => {
    const r = validateAction(
      { type: 'type', ref: elementRef('e1'), text: 'laptop', submit: true },
      ctx({ typeableRefs: new Set([elementRef('e1')]) }),
    );
    expect(r.ok).toBe(true);
  });

  it('checks the ref exists before it checks the role', () => {
    // An unknown ref is the more serious finding - it means the server named
    // something we never exposed - and must not be masked by the role message.
    const r = validateAction(
      { type: 'type', ref: elementRef('e99'), text: 'x', submit: false },
      ctx({ typeableRefs: new Set() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-ref');
  });

  it('does not restrict click the same way', () => {
    // Clicking a text field is legitimate: it focuses it.
    const r = validateAction(
      { type: 'click', ref: elementRef('e3') },
      ctx({ typeableRefs: new Set() }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('a question that solicits a credential is refused', () => {
  /*
   * The panel used to defend this with one line of hint text beside the
   * question - which asks the user to out-argue a sentence we chose to display,
   * in our own trusted UI. "Confirm your password to continue" arriving there is
   * a phishing prompt wearing our credibility.
   *
   * Refused rather than stripped: a question with the credential words removed
   * still means what it meant.
   */
  const ctx = {
    validRefs: new Set(),
    sensitiveRefs: new Set(),
    typeableRefs: new Set(),
    allowedOrigins: [],
    maxScrollPx: 5000,
    maxWaitMs: 5000,
    maxTypeChars: 500,
  } as unknown as Parameters<typeof validateAction>[1];

  for (const q of [
    'Please confirm your password to continue',
    'What is the CVV on the card?',
    'Enter the 6-digit OTP we sent you',
    'What is your card number?',
    'Paste your API key',
    'What is the verification code?',
  ]) {
    it(`refuses: ${q}`, () => {
      const out = validateAction({ type: 'ask_user', question: q }, ctx);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('asks-for-credential');
    });
  }

  it('allows an ordinary question', () => {
    const out = validateAction(
      { type: 'ask_user', question: 'Which one did you mean - Laptop Pro, or Gaming Laptop?' },
      ctx,
    );
    expect(out.ok).toBe(true);
  });

  it('allows a question that merely mentions a card in passing', () => {
    // "card" alone is a gift card, a loyalty card, a card game. The rule is
    // about the SECRET being solicited, not about the word.
    const out = validateAction(
      { type: 'ask_user', question: 'Which card design did you want - blue or red?' },
      ctx,
    );
    expect(out.ok).toBe(true);
  });
});
