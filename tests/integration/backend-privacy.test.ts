/*
 * NODE, not jsdom. See the header of `tests/agent-server/backend.test.ts`: under
 * jsdom an `AbortController` signal is rejected by undici's `fetch`, so every
 * request fails as a transport error and a leak test would pass because nothing
 * was ever sent. `ensureDomParser()` supplies the one DOM API the pipeline needs.
 */
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import {
  type BakedScreenshot,
  type SanitizedContext,
  type SanitizedContextShape,
  assertOutboundContext,
  inspectOutboundContext,
  EgressBlockedError,
} from '@/contracts/index.ts';
import { HttpAgentBackend, PROTOCOL_VERSION, validateAction, parseAction } from '@/agent-server/index.ts';
import { verifyOutboundRedaction, validationContextFor } from '@/redaction/index.ts';
import { ensureDomParser, loadFixture, runPipeline, truthLiterals } from '@/harness/index.ts';
import { unsafeUnwrap } from '@/contracts/index.ts';
import { startMockBackend, type MockBackend } from '../support/mock-backend.ts';

/**
 * THE INVARIANT, TESTED AT THE ONLY PLACE IT CAN BE TESTED.
 *
 * "Raw sensitive data never reaches any AI backend" is a claim about bytes on a
 * socket. Nothing short of a real listener can check it: the type system stops
 * at the serialisation boundary, and an injected `fetch` sees the object the
 * client passed rather than the string the HTTP layer produced.
 *
 * So each test here stands up a listener, drives a real request through the real
 * client, and greps the RAW REQUEST BODY the server received for values the
 * fixture's own ground truth says must never appear.
 *
 * The fixture literals come from `truthLiterals()`, which reads each fixture's
 * `.truth.json` and returns only `mustRedact: true` entries. Restating them here
 * would mean a new fixture value is not covered until somebody remembers to add
 * it, and excluding `mustRedact: false` is deliberate - those are documented gaps
 * with a written note, and asserting on them would make this file fail for a
 * reason CLAUDE.md already records, which is how a real assertion gets weakened.
 */

beforeAll(async () => {
  await ensureDomParser();
});

const started: MockBackend[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

async function mock(...args: Parameters<typeof startMockBackend>): Promise<MockBackend> {
  const backend = await startMockBackend(...args);
  started.push(backend);
  return backend;
}

function request(context: SanitizedContext) {
  return { protocolVersion: PROTOCOL_VERSION, context, clientVersion: 'test' } as const;
}

/** The three off-device deployments, each pointed at its own listener. */
const OFF_DEVICE = ['local', 'private', 'cloud'] as const;

// --- D: raw PII never reaches any backend -----------------------------------

describe('D. raw PII is blocked on every deployment', () => {
  const FIXTURES = ['login-form', 'checkout', 'profile-pii'] as const;

  for (const kind of OFF_DEVICE) {
    for (const fixtureId of FIXTURES) {
      it(`${kind}: no ${fixtureId} literal appears in the body the server received`, async () => {
        const server = await mock({ script: ['{"type":"done","summary":"ok"}'] });
        const backend = new HttpAgentBackend({
          kind,
          origin: server.origin,
          model: 'm',
          clientVersion: 'test',
        });

        const run = runPipeline(fixtureId, { goal: 'complete the form' });
        const outcome = await backend.plan(request(run.context), new AbortController().signal);
        expect(outcome.ok, `${kind}/${fixtureId} should have been sent`).toBe(true);

        const body = server.bodyText();
        expect(body.length).toBeGreaterThan(0);

        const literals = truthLiterals(loadFixture(fixtureId).truth);
        expect(literals.length, 'the fixture must actually carry PII to test with').toBeGreaterThan(0);
        for (const { id, literal } of literals) {
          expect(body, `${fixtureId}#${id} leaked to the ${kind} backend`).not.toContain(literal);
        }
      });
    }
  }

  it('the same literals ARE present in the source page, so the test can fail', () => {
    /*
     * A GUARD AGAINST A VACUOUS SUITE.
     *
     * Every assertion above is a `not.toContain`, and those pass trivially
     * against an empty body, a fixture whose literals were renamed, or a
     * `truthLiterals` that returned nothing. This asserts the values genuinely
     * exist in the input, so "absent from the payload" means removed rather than
     * never there.
     */
    for (const fixtureId of FIXTURES) {
      const fixture = loadFixture(fixtureId);
      /*
       * UNWRAPPED, and `JSON.stringify` would not have done.
       *
       * The first version of this line used `JSON.stringify(fixture.html)` and
       * got `{}` for every fixture - so it "passed" by finding nothing anywhere.
       * That is `Untrusted<T>` working exactly as designed (the payload sits
       * behind a module-private symbol and symbol keys do not serialise), and it
       * is precisely the property that makes page text unable to leak by
       * accident. Reading it deliberately needs `unsafeUnwrap` with a named
       * reason, which is what `test-fixture` is for.
       */
      const html = unsafeUnwrap(fixture.html, 'test-fixture');
      for (const { id, literal } of truthLiterals(fixture.truth)) {
        expect(html, `${fixtureId}#${id} is not in its own fixture`).toContain(literal);
      }
    }
  });

  it('is blocked before the request when a leak survives sanitization', async () => {
    /*
     * The gate itself, with a payload constructed to defeat the redactor.
     *
     * A real page cannot easily be made to do this - if it could, that would be
     * a redaction bug rather than a gate test - so the value is planted directly
     * into a built context. That is the situation the gate exists for: the
     * pipeline believed it was finished and was wrong.
     */
    const server = await mock({ script: ['{"type":"done","summary":"ok"}'] });

    const clean = runPipeline('login-form', { goal: 'sign in' }).context;
    const tampered = {
      ...(clean as SanitizedContextShape),
      elements: [
        ...clean.elements,
        {
          ...clean.elements[0],
          value: { kind: 'page-data', text: 'ada.lovelace@example.com', redacted: false, truncated: false },
        },
      ],
    } as unknown as SanitizedContext;

    const verdict = verifyOutboundRedaction(tampered, { minConfidence: 0.5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.kind)).toContain('email');
    // The FIELD is named and the VALUE is not - a leak report that quotes the
    // leak is a second copy of it, in the panel and the timeline.
    expect(JSON.stringify(verdict.findings)).not.toContain('ada.lovelace');
    // Nothing was sent: the verdict is produced before any client call.
    expect(server.bodyText()).toBe('');
  });

  it('does not fire on redaction placeholders, which are proof rather than leaks', () => {
    /*
     * `[[PII:PHONE:3:9f2a...]]` carries a digit run and a hex tail, and the phone
     * and id rules match inside it. A verifier that scanned placeholders would
     * fire hardest on the pages it had protected best, and would be turned off
     * within a day.
     */
    const run = runPipeline('profile-pii', { goal: 'read the profile' });
    const verdict = verifyOutboundRedaction(run.context, { minConfidence: 0.5 });
    expect(verdict.ok, JSON.stringify(verdict.findings)).toBe(true);
    expect(verdict.fieldsScanned).toBeGreaterThan(0);
  });

  it('scans a field it is given, so a clean verdict is not an empty one', () => {
    // `fieldsScanned: 0` and "no findings" are the same output for a scanner
    // that walked nothing. The receipt reports the count for this reason.
    const run = runPipeline('checkout', { goal: 'pay' });
    const verdict = verifyOutboundRedaction(run.context, { minConfidence: 0.5 });
    expect(verdict.fieldsScanned).toBeGreaterThan(3);
  });
});

// --- E / F: screenshots -------------------------------------------------------

describe('E/F. only a verified redacted screenshot may be sent', () => {
  /**
   * A raw frame, dressed as convincingly as a raw frame can be.
   *
   * `CapturedFrame` carries `dataUrl`, `frameId`, `natural` and `viewport` and
   * has NO op counters, because only `bakeRedactions()` produces those. That
   * absence is what the gate keys on, and it is why a raw capture cannot be
   * laundered into the payload by renaming a field.
   */
  const RAW_FRAME = {
    base64: 'UkFXX1BJWEVMU19GUk9NX1RIRV9VU0VSU19TQ1JFRU4',
    format: 'jpeg' as const,
    width: 1280,
    height: 720,
  };

  it('E. refuses a screenshot with no bake counters', () => {
    const violations = inspectOutboundContext({
      ...(runPipeline('login-form').context as SanitizedContextShape),
      screenshot: RAW_FRAME,
    });
    expect(violations.map((v) => v.code)).toContain('unbaked-screenshot');
    expect(violations.map((v) => v.detail).join(' ')).toMatch(/bakeRedactions/);
  });

  it('E. refuses a screenshot whose ops were requested and did not land', () => {
    const violations = inspectOutboundContext({
      ...(runPipeline('login-form').context as SanitizedContextShape),
      screenshot: {
        ...RAW_FRAME,
        // Five ops overlapped the frame; one applied. Four PII regions are still
        // legible in the picture while the text beside them says they were removed.
        opsRequested: 6,
        opsOutsideFrame: 1,
        opsApplied: 1,
      },
    });
    expect(violations.map((v) => v.code)).toContain('unverified-screenshot');
  });

  it('F. allows a screenshot whose ops all landed', () => {
    const violations = inspectOutboundContext({
      ...(runPipeline('login-form').context as SanitizedContextShape),
      screenshot: { ...RAW_FRAME, opsRequested: 4, opsOutsideFrame: 0, opsApplied: 4 },
    });
    expect(violations).toEqual([]);
  });

  it('F. allows ops that fell outside the captured viewport', () => {
    /*
     * The ambiguity that made `bake 0 pixel op(s)` unreadable. A screenshot shows
     * the VIEWPORT while the DOM scan reads the whole document, so PII below the
     * fold is redacted in the text and was never in the picture. Zero applied is
     * then correct, and refusing it would refuse the common case.
     */
    const violations = inspectOutboundContext({
      ...(runPipeline('login-form').context as SanitizedContextShape),
      screenshot: { ...RAW_FRAME, opsRequested: 3, opsOutsideFrame: 3, opsApplied: 0 },
    });
    expect(violations).toEqual([]);
  });

  for (const kind of OFF_DEVICE) {
    it(`E. ${kind}: a raw frame never reaches the socket`, async () => {
      const server = await mock({ script: ['{"type":"done","summary":"ok"}'] });
      const backend = new HttpAgentBackend({
        kind,
        origin: server.origin,
        model: 'm',
        clientVersion: 'test',
      });

      const clean = runPipeline('login-form', { goal: 'sign in' }).context;
      const withRaw = {
        ...(clean as SanitizedContextShape),
        screenshot: RAW_FRAME as unknown as BakedScreenshot,
      } as unknown as SanitizedContext;

      const outcome = await backend.plan(request(withRaw), new AbortController().signal);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      // `refused` and not `transport`: WE stopped it. Reporting our own gate as
      // a backend outage would offer the user a switch to a different provider.
      expect(outcome.error.kind).toBe('refused');
      expect(outcome.error.retryable).toBe(false);
      // And, the assertion that actually matters: no bytes were written.
      expect(server.requests.filter((r) => r.url === '/plan')).toHaveLength(0);
      expect(server.bodyText()).not.toContain(RAW_FRAME.base64);
    });

    it(`F. ${kind}: a verified baked image does reach the socket`, async () => {
      const server = await mock({ script: ['{"type":"done","summary":"ok"}'] });
      const backend = new HttpAgentBackend({
        kind,
        origin: server.origin,
        model: 'm',
        clientVersion: 'test',
      });

      const baked = {
        base64: 'QkFLRURfQU5EX1ZFUklGSUVE',
        format: 'jpeg' as const,
        width: 768,
        height: 432,
        opsRequested: 3,
        opsApplied: 3,
        opsOutsideFrame: 0,
      } as unknown as BakedScreenshot;

      const clean = runPipeline('login-form', { goal: 'sign in' }).context;
      const withBaked = {
        ...(clean as SanitizedContextShape),
        screenshot: baked,
      } as unknown as SanitizedContext;

      const outcome = await backend.plan(request(withBaked), new AbortController().signal);

      expect(outcome.ok).toBe(true);
      expect(server.bodyText()).toContain('QkFLRURfQU5EX1ZFUklGSUVE');
    });
  }
});

// --- The shape gate ----------------------------------------------------------

describe('the shape gate refuses anything the sanitizer does not emit', () => {
  it('refuses an added field, whatever it is called', () => {
    /*
     * THE CHECK THAT CATCHES A LEAK NOBODY ANTICIPATED.
     *
     * Every other rule here names a specific thing to refuse, which means it can
     * only refuse things somebody thought of. This one inverts it: the sanitizer
     * emits a fixed set of keys, so ANY other key is either a mistake or an
     * exfiltration, and neither should travel.
     */
    const violations = inspectOutboundContext({
      ...(runPipeline('login-form').context as SanitizedContextShape),
      rawHtml: '<html><body>the whole unredacted page</body></html>',
    });
    expect(violations.map((v) => v.code)).toContain('unexpected-field');
    expect(violations.map((v) => v.detail).join(' ')).toContain('rawHtml');
  });

  it('refuses an added field on an element', () => {
    const clean = runPipeline('login-form').context;
    const violations = inspectOutboundContext({
      ...(clean as SanitizedContextShape),
      elements: [{ ...clean.elements[0], domPath: 'body > form > input:nth-child(2)' }],
    });
    expect(violations.map((v) => v.code)).toContain('unexpected-field');
  });

  it('refuses page text that never passed toDataAtom', () => {
    const clean = runPipeline('login-form').context;
    const violations = inspectOutboundContext({
      ...(clean as SanitizedContextShape),
      elements: [{ ...clean.elements[0], name: 'a bare string straight off the page' }],
    });
    expect(violations.map((v) => v.code)).toContain('unquoted-page-text');
  });

  it('names a serialised Untrusted wrapper for what it is', () => {
    /*
     * `Untrusted<T>` hides its payload behind a module-private symbol, and symbol
     * keys do not serialise - so an Untrusted value that crossed a message
     * boundary arrives as `{}`. That empty object is the signature of raw page
     * text having taken a route it was never meant to, and it deserves a
     * message that says so rather than a generic type complaint.
     */
    const clean = runPipeline('login-form').context;
    const violations = inspectOutboundContext({
      ...(clean as SanitizedContextShape),
      elements: [{ ...clean.elements[0], value: {} }],
    });
    expect(violations.map((v) => v.detail).join(' ')).toMatch(/serialised Untrusted/);
  });

  it('refuses a forged redaction placeholder', () => {
    const clean = runPipeline('login-form').context;
    const violations = inspectOutboundContext({
      ...(clean as SanitizedContextShape),
      elements: [
        {
          ...clean.elements[0],
          // A hostile page printing a placeholder-shaped string, to make the
          // server believe a field was redacted when it was not.
          name: { kind: 'page-data', text: '[[PII:EMAIL:1:deadbeef]]', redacted: true, truncated: false },
        },
      ],
    });
    expect(violations.map((v) => v.code)).toContain('forged-placeholder');
    // The count travels; the forged token does not. It is page-authored text.
    expect(violations.map((v) => v.detail).join(' ')).not.toContain('deadbeef');
  });

  it('accepts a real sanitized context untouched', () => {
    for (const fixtureId of ['login-form', 'checkout', 'profile-pii', 'benign-docs', 'injection']) {
      const context = runPipeline(fixtureId, { goal: 'do the thing' }).context;
      expect(inspectOutboundContext(context), fixtureId).toEqual([]);
      expect(() => {
        assertOutboundContext(context);
      }, fixtureId).not.toThrow();
    }
  });

  it('throws an EgressBlockedError carrying every violation, not just the first', () => {
    let caught: unknown = null;
    try {
      assertOutboundContext({ schemaVersion: 1, rawHtml: 'x', alsoRaw: 'y' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EgressBlockedError);
    if (!(caught instanceof EgressBlockedError)) return;
    expect(caught.violations.length).toBeGreaterThan(1);
  });
});

// --- I: local validation is mandatory regardless of backend -----------------

describe('I. a bad action from any backend is refused locally', () => {
  const BAD_ACTIONS: readonly { readonly why: string; readonly raw: string }[] = [
    { why: 'a ref we never sent', raw: '{"type":"click","ref":"e9999"}' },
    { why: 'a navigate off the allowlist', raw: '{"type":"navigate","url":"https://evil.example/x"}' },
    { why: 'an unbounded wait', raw: '{"type":"wait","ms":9999999}' },
    { why: 'a question soliciting a credential', raw: '{"type":"ask_user","question":"Confirm your password to continue"}' },
  ];

  for (const kind of OFF_DEVICE) {
    it(`${kind}: every bad action is refused after the round trip`, async () => {
      const run = runPipeline('login-form', { goal: 'sign in' });
      const vctx = validationContextFor(run.context, ['https://fixtures.invalid']);

      for (const { why, raw } of BAD_ACTIONS) {
        const server = await mock({ script: [raw] });
        const backend = new HttpAgentBackend({
          kind,
          origin: server.origin,
          model: 'm',
          clientVersion: 'test',
        });

        const outcome = await backend.plan(request(run.context), new AbortController().signal);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) continue;

        /*
         * The transport hands back a RAW STRING. Every backend does, including
         * the on-device one, so parse and validate are unavoidable rather than
         * something a caller could skip for a planner it happens to trust.
         *
         * REFUSED BY EITHER STAGE COUNTS, and the first draft of this test got
         * that wrong: it asserted every bad action reaches `validateAction`, and
         * `{"type":"wait","ms":9999999}` does not - `parseAction` rejects it as
         * `out-of-range` before validation ever sees it. Two gates in series,
         * and what matters is that nothing gets past BOTH.
         */
        const parsed = parseAction(outcome.response.raw);
        const refused = !parsed.ok || !validateAction(parsed.value, vctx).ok;
        expect(refused, `${kind}: ${why} was NOT refused`).toBe(true);
      }
    });
  }

  it('accepts a well-formed action addressing a ref we did send', () => {
    const run = runPipeline('login-form', { goal: 'sign in' });
    const vctx = validationContextFor(run.context, []);
    const ref = run.context.elements[0]?.ref;
    expect(ref).toBeDefined();

    const parsed = parseAction(JSON.stringify({ type: 'click', ref: String(ref) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateAction(parsed.value, vctx).ok).toBe(true);
  });

  it('builds the same validation context whatever the backend', () => {
    /*
     * The ref allowlist is derived from the CONTEXT, not from the destination.
     * There is no per-backend validation setting and this asserts there is no
     * accidental one: the same context yields the same permitted refs.
     */
    const run = runPipeline('checkout', { goal: 'pay the invoice' });
    const a = validationContextFor(run.context, ['https://one.example']);
    const b = validationContextFor(run.context, ['https://two.example']);
    expect([...a.validRefs].sort()).toEqual([...b.validRefs].sort());
    expect([...a.typeableRefs].sort()).toEqual([...b.typeableRefs].sort());
    expect([...a.sensitiveRefs].sort()).toEqual([...b.sensitiveRefs].sort());
  });
});

// --- the clarification question is page-derived, and is scanned -------------

describe('a clarification question is scanned; the answer is not', () => {
  it('scans clarifications[].question', () => {
    /*
     * `Clarification.question` LOOKS user-facing and is not user-AUTHORED.
     * `detectAmbiguity` composes it from the page's own accessible names, so on a
     * page whose button is labelled with an email address the question carries
     * that address - and it is then carried in the context on every later step of
     * the task.
     *
     * The first version of `outboundTextFields` excluded the whole Clarification
     * as "user-authored". Only the answer is.
     */
    const clean = runPipeline('login-form', { goal: 'sign in' }).context;
    const withQuestion = {
      ...(clean as SanitizedContextShape),
      clarifications: [
        { question: 'Which one did you mean - Email ada.lovelace@example.com?', answer: 'the first' },
      ],
    } as unknown as SanitizedContext;

    const verdict = verifyOutboundRedaction(withQuestion, { minConfidence: 0.5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.field)).toContain('clarifications[0].question');
  });

  it('leaves clarifications[].answer alone, because the user typed it', () => {
    /*
     * A user whose task is "email the invoice to me@example.com" authored that
     * address on purpose. Refusing it would block the product to protect the user
     * from themselves, and would do so invisibly from their side.
     */
    const clean = runPipeline('login-form', { goal: 'sign in' }).context;
    const withAnswer = {
      ...(clean as SanitizedContextShape),
      clarifications: [{ question: 'Which account?', answer: 'the one for ada@example.com' }],
    } as unknown as SanitizedContext;

    const verdict = verifyOutboundRedaction(withAnswer, { minConfidence: 0.5 });
    expect(verdict.ok, JSON.stringify(verdict.findings)).toBe(true);
  });

  it('leaves the user-typed goal alone for the same reason', () => {
    const ctx = runPipeline('login-form', { goal: 'send the receipt to ada@example.com' }).context;
    expect(verifyOutboundRedaction(ctx, { minConfidence: 0.5 }).ok).toBe(true);
  });
});
