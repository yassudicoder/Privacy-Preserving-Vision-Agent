import { describe, expect, it } from 'vitest';
import {
  type Action,
  type TargetResolution,
  type TargetSpec,
  type ValidationContext,
  elementRef,
} from '@/contracts/index.ts';
import { parseAction, parseAndValidate, validateAction } from '@/agent-server/index.ts';

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    validRefs: new Set([elementRef('e1'), elementRef('e2'), elementRef('e3')]),
    sensitiveRefs: new Set([elementRef('e2')]),
    // e1/e2/e3 are all typeable by default so the existing cases keep testing
    // what they were written to test; the not-typeable cases override it.
    typeableRefs: new Set([elementRef('e1'), elementRef('e2'), elementRef('e3')]),
    // Empty by default: no field holds anything, so the existing cases keep
    // testing what they were written to test. The already-typed cases override.
    currentValues: new Map(),
    allowedOrigins: ['https://acme.example'],
    maxScrollPx: 5000,
    maxWaitMs: 10_000,
    maxTypeChars: 1000,
    ...overrides,
  };
}

describe('a no-op retype is refused before the request leaves', () => {
  /*
   * THE RUN THIS COMES FROM. On amazon.in the loop ended
   * `repeating - planned {"type":"type","ref":"e4","text":"iPhone 17"} 3 times
   * in a row`. All three EXECUTED - typed, events fired, page changed - and the
   * model was shown `value="iPhone 17"` on that element in the next prompt each
   * time. Typing text a field already holds cannot change the page, so the step
   * that follows is guaranteed to make no progress.
   */
  const withValue = (text: string): ValidationContext =>
    ctx({ currentValues: new Map([[elementRef('e1'), text]]) });

  it('refuses typing text the field already holds', () => {
    const out = validateAction(
      { type: 'type', ref: elementRef('e1'), text: 'iPhone 17', submit: false },
      withValue('iPhone 17'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('already-typed');
  });

  it('ignores whitespace the field would have kept anyway', () => {
    const out = validateAction(
      { type: 'type', ref: elementRef('e1'), text: ' iPhone 17 ', submit: false },
      withValue('iPhone 17'),
    );
    expect(out.ok).toBe(false);
  });

  it('ALLOWS the same text when it SUBMITS - submitting is not a no-op', () => {
    // The refusal told the model to "submit it"; a model that obeyed with
    // `submit:true` was then refused again. Seen on amazon.in, ending in abort.
    const out = validateAction(
      { type: 'type', ref: elementRef('e1'), text: 'iPhone 17', submit: true },
      withValue('iPhone 17'),
    );
    expect(out.ok).toBe(true);
  });

  it('names the exact JSON that would submit, because "submit it" is not an action', () => {
    const out = validateAction(
      { type: 'type', ref: elementRef('e1'), text: 'iPhone 17', submit: false },
      withValue('iPhone 17'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.detail).toContain('"submit":true');
  });

  it('ALLOWS a genuine edit, including one that only changes case', () => {
    // Correcting capitalisation is a real change. Anything more lenient than an
    // exact compare starts refusing edits the user asked for.
    for (const text of ['iPhone 17 Pro', 'IPHONE 17', 'iphone 16']) {
      const out = validateAction(
        { type: 'type', ref: elementRef('e1'), text, submit: false },
        withValue('iPhone 17'),
      );
      expect(out.ok).toBe(true);
    }
  });

  it('ALLOWS typing into a field whose value we could not compare', () => {
    /*
     * A redacted or truncated value reached the model as a placeholder, not as
     * text - so the model asking to type the real thing is not a repeat of
     * anything, it never saw the real thing. `validationContextFor` omits those,
     * and an absent entry must mean "allowed".
     */
    const out = validateAction(
      { type: 'type', ref: elementRef('e1'), text: 'anything', submit: false },
      ctx({ currentValues: new Map() }),
    );
    expect(out.ok).toBe(true);
  });

  it('ALLOWS clearing a field', () => {
    // Empty text is not a repeat of a non-empty value, and blanking a box is a
    // legitimate action.
    const out = validateAction(
      { type: 'type', ref: elementRef('e1'), text: '', submit: false },
      withValue(''),
    );
    expect(out.ok).toBe(true);
  });

  it('is checked AFTER the cheaper rules, so a better error still wins', () => {
    // A non-typeable target is the more useful thing to say, and it is what the
    // model most often gets wrong.
    const out = validateAction(
      { type: 'type', ref: elementRef('e3'), text: 'x', submit: false },
      ctx({
        typeableRefs: new Set([elementRef('e1')]),
        currentValues: new Map([[elementRef('e3'), 'x']]),
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not-typeable');
  });
});

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

describe('a model-written target is resolved before anything else is judged', () => {
  /*
   * The model names elements from the page HTML - {"tag":"button","text":...}
   * - and never by ref. `validateAction` resolves the target against the sent
   * elements through `locate`, then every existing rule judges the element it
   * resolved to. Ambiguity and no-match are refusals: the client never picks.
   */
  const locate = (t: TargetSpec): TargetResolution => {
    if (t.text === 'Search') return { ok: true, ref: elementRef('e1') };
    if (t.text === 'Add to cart' && t.within === undefined) {
      return { ok: false, reason: 'ambiguous', count: 2, differ: ['within'] };
    }
    if (t.text === 'Add to cart') return { ok: true, ref: elementRef('e3') };
    return { ok: false, reason: 'no-match', count: 0 };
  };
  const unresolved = elementRef('');

  it('fills the ref from the target, and the element rules then apply to it', () => {
    const typed = validateAction(
      { type: 'type', ref: unresolved, target: { text: 'Search' }, text: 'laptop', submit: true },
      ctx({ locate }),
    );
    expect(typed.ok && 'ref' in typed.value && String(typed.value.ref)).toBe('e1');
    // e2 is sensitive in ctx(): a target resolving there is refused like a ref was.
    const sensitive = validateAction(
      { type: 'type', ref: unresolved, target: { id: 'pw' }, text: 'x', submit: false },
      ctx({ locate: () => ({ ok: true, ref: elementRef('e2') }) }),
    );
    expect(sensitive.ok).toBe(false);
    if (!sensitive.ok) expect(sensitive.error.code).toBe('sensitive-target');
  });

  it('refuses an ambiguous target instead of picking one, and says how to fix it', () => {
    const out = validateAction({ type: 'click', ref: unresolved, target: { text: 'Add to cart' } }, ctx({ locate }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('ambiguous-target');
      expect(out.error.detail).toMatch(/within/);
    }
    const narrowed = validateAction(
      { type: 'click', ref: unresolved, target: { text: 'Add to cart', within: 'Dell' } },
      ctx({ locate }),
    );
    expect(narrowed.ok && 'ref' in narrowed.value && String(narrowed.value.ref)).toBe('e3');
  });

  it('refuses a target that matches nothing', () => {
    const out = validateAction({ type: 'click', ref: unresolved, target: { text: 'Buy now' } }, ctx({ locate }));
    expect(!out.ok && out.error.code).toBe('no-such-target');
  });

  it('refuses every target when no locator is supplied - fail closed', () => {
    const out = validateAction({ type: 'click', ref: unresolved, target: { text: 'Search' } }, ctx());
    expect(!out.ok && out.error.code).toBe('no-such-target');
  });

  it('an action that skipped resolution cannot pass on its empty ref', () => {
    const out = validateAction({ type: 'click', ref: unresolved }, ctx({ locate }));
    expect(!out.ok && out.error.code).toBe('unknown-ref');
  });
});

describe('parse reads a target and leaves resolution to validation', () => {
  it('parses a target object and leaves ref empty', () => {
    const out = parseAction('{"type":"click","target":{"tag":"button","text":"Go","junk":"x"}}');
    expect(out.ok).toBe(true);
    if (out.ok && out.value.type === 'click') {
      expect(out.value.target).toEqual({ tag: 'button', text: 'Go' });
      expect(String(out.value.ref)).toBe('');
    }
  });

  it('refuses an empty target and a target that is not an object', () => {
    const empty = parseAction('{"type":"click","target":{}}');
    expect(!empty.ok && empty.error.code).toBe('missing-field');
    const flat = parseAction('{"type":"click","target":"e3"}');
    expect(!flat.ok && flat.error.code).toBe('bad-field-type');
  });

  it('defaults a wait that names no duration, instead of failing the task', () => {
    // gemini-3.5-flash-lite on amazon.in, verbatim: a fenced {"type":"wait"}.
    const out = parseAction('```json\n{"type":"wait"}\n```');
    expect(out.ok && out.value).toEqual({ type: 'wait', ms: 1000 });
  });

  it('still reads a ref, which is how the on-device planners address elements', () => {
    const out = parseAction('{"type":"click","ref":"e3"}');
    expect(out.ok && out.value.type === 'click' && String(out.value.ref)).toBe('e3');
  });
});
