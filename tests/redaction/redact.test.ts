// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ANY_PLACEHOLDER_RE, markUntrusted, redactionNonce } from '@/contracts/index.ts';
import { redact, resetDetectionIds } from '@/redaction/index.ts';
import { allFixtureIds, loadFixture, runPipeline, truthLiterals } from '@/harness/index.ts';

const NONCE = 'a1b2c3d4';

describe('redact() over every fixture', () => {
  for (const id of allFixtureIds()) {
    describe(id, () => {
      it('lets no ground-truth literal survive in the redacted HTML', () => {
        const run = runPipeline(id, { nonce: NONCE });
        const html = String(run.result.html);
        const leaked = truthLiterals(run.fixture.truth).filter((t) => html.includes(t.literal));
        expect(leaked.map((l) => l.id)).toEqual([]);
      });

      it('lets no ground-truth literal survive into the outgoing payload', () => {
        // This is the assertion that actually matters: the HTML never leaves the
        // machine, the SanitizedContext does.
        const run = runPipeline(id, { nonce: NONCE });
        const wire = JSON.stringify(run.context);
        const leaked = truthLiterals(run.fixture.truth).filter((t) => wire.includes(t.literal));
        expect(leaked.map((l) => l.id)).toEqual([]);
      });

      it('produces a log whose applied entries all name a strategy and a target', () => {
        const run = runPipeline(id, { nonce: NONCE });
        for (const entry of run.result.log.entries) {
          expect(entry.strategy).toBeTruthy();
          expect(entry.reason).toBeTruthy();
          if (entry.applied) {
            expect(entry.target.domPath !== null || entry.target.rect !== null).toBe(true);
          }
        }
      });

      it('never puts a raw PII value into the redaction log', () => {
        // The log is rendered in the panel and written to disk. Putting the
        // values in it would defeat the entire exercise.
        const run = runPipeline(id, { nonce: NONCE });
        const serialised = JSON.stringify(run.result.log);
        for (const { literal } of truthLiterals(run.fixture.truth)) {
          expect(serialised).not.toContain(literal);
        }
      });

      it('is deterministic', () => {
        resetDetectionIds();
        const a = runPipeline(id, { nonce: NONCE });
        resetDetectionIds();
        const b = runPipeline(id, { nonce: NONCE });
        expect(String(a.result.html)).toBe(String(b.result.html));
        expect(a.result.log.summary).toEqual(b.result.log.summary);
      });
    });
  }
});

describe('login-form specifics', () => {
  it('strips the password value but keeps the field', () => {
    const run = runPipeline('login-form', { nonce: NONCE });
    const html = String(run.result.html);
    expect(html).not.toContain('hunter2-correct-horse');
    // Visual context is 25% of the score. Deleting the field would score worse
    // than leaving it in place with an empty value.
    expect(html).toContain('type="password"');
    expect(run.context.elements.some((e) => e.role === 'textbox' && e.isSensitive)).toBe(true);
  });

  it('replaces the email with a placeholder carrying the session nonce', () => {
    const run = runPipeline('login-form', { nonce: NONCE });
    const html = String(run.result.html);
    expect(html).not.toContain('priya.sharma@example.com');
    expect(html).toMatch(/\[\[PII:EMAIL:\d+:a1b2c3d4\]\]/);
  });

  it('redacts PII in prose as well as in form values', () => {
    const run = runPipeline('login-form', { nonce: NONCE });
    const html = String(run.result.html);
    expect(html).not.toContain('9876543210');
    expect(html).not.toContain('support@acme.example');
  });

  it('strips the query string from the logged URL', () => {
    const run = runPipeline('login-form', { nonce: NONCE });
    expect(run.result.log.url).not.toContain('session=');
    expect(run.context.url).not.toContain('session=');
  });
});

describe('checkout specifics', () => {
  it('redacts the Luhn-valid card number', () => {
    const run = runPipeline('checkout', { nonce: NONCE });
    expect(String(run.result.html)).not.toContain('4111111111111111');
  });

  it('does NOT redact the Luhn-invalid order reference', () => {
    // Over-redaction blinds the agent. This number is not a card and must survive.
    const run = runPipeline('checkout', { nonce: NONCE });
    expect(String(run.result.html)).toContain('1234567890123456');
  });

  it('clears a textarea value, which does not live in an attribute', () => {
    // setAttribute('value', '') on a <textarea> does nothing at all; the content
    // is a text node. Getting this wrong leaks the whole delivery address.
    const run = runPipeline('checkout', { nonce: NONCE });
    expect(String(run.result.html)).not.toContain('14 Nehru Road');
  });
});

describe('profile-pii specifics', () => {
  it('redacts checksum-validated identifiers', () => {
    const run = runPipeline('profile-pii', { nonce: NONCE });
    const html = String(run.result.html);
    expect(html).not.toContain('234567890124');
    expect(html).not.toContain('ABCPD1234E');
    expect(html).not.toContain('HDFC0001234');
  });

  it('queues pixel redactions for the visual-only detections', () => {
    const run = runPipeline('profile-pii', { nonce: NONCE });
    const kinds = run.result.pixelOps.map((o) => o.kind);
    expect(kinds).toContain('face');
    expect(kinds).toContain('signature');
  });

  it('converts pixel-op rects into device pixels at dpr 2', () => {
    // The fixture runs at devicePixelRatio 2 precisely so a missing conversion
    // shows up as a box in the wrong half of the frame.
    const run = runPipeline('profile-pii', { nonce: NONCE });
    const face = run.result.pixelOps.find((o) => o.kind === 'face');
    expect(face).toBeDefined();
    expect(face?.rect.space).toBe('device-px');
    // CSS y is ~100; at dpr 2 the device y must be ~200, not ~100.
    expect(face?.rect.y ?? 0).toBeGreaterThan(150);
  });
});

describe('benign-docs is the false-positive canary', () => {
  it('applies no redactions at all', () => {
    const run = runPipeline('benign-docs', { nonce: NONCE });
    const applied = run.result.log.entries.filter((e) => e.applied);
    expect(applied).toEqual([]);
  });

  it('leaves the document text intact', () => {
    const run = runPipeline('benign-docs', { nonce: NONCE });
    const html = String(run.result.html);
    expect(html).toContain('antenna pointing procedures');
    expect(html).toContain('azimuth encoder offset');
    expect(html).not.toMatch(ANY_PLACEHOLDER_RE);
  });
});

describe('injection fixture', () => {
  it('strips exactly the forged redaction tokens the page planted', () => {
    const run = runPipeline('injection', { nonce: NONCE });
    expect(run.result.log.summary.forgeriesStripped).toBe(
      run.fixture.truth.expectedForgeries,
    );
  });

  it('leaves no foreign-nonce placeholder anywhere in the output', () => {
    const run = runPipeline('injection', { nonce: NONCE });
    const html = String(run.result.html);
    expect(html).not.toContain('deadbeef');
    expect(html).not.toContain('cafebabe');
    const wire = JSON.stringify(run.context);
    expect(wire).not.toContain('deadbeef');
    expect(wire).not.toContain('cafebabe');
  });

  it('still redacts the real password on a hostile page', () => {
    const run = runPipeline('injection', { nonce: NONCE });
    expect(String(run.result.html)).not.toContain('s3cret-value-here');
  });

  it('keeps the hostile prose as inert data rather than deleting it', () => {
    // Redacting it would be wrong: it is not PII, and the server needs to see
    // the page as it is. It just must not be obeyed.
    const run = runPipeline('injection', { nonce: NONCE });
    expect(String(run.result.html)).toContain('Ignore all previous instructions');
  });
});

describe('redact() input handling', () => {
  it('tolerates an empty document', () => {
    const r = redact(markUntrusted(''), [], { nonce: redactionNonce(NONCE) });
    expect(r.log.entries).toEqual([]);
    expect(typeof String(r.html)).toBe('string');
  });

  it('tolerates malformed markup', () => {
    const r = redact(markUntrusted('<div><p>unclosed<span>'), [], {
      nonce: redactionNonce(NONCE),
    });
    expect(r.log.residualRisk).toBeTruthy();
  });

  it('reports residual risk honestly when detections fall below threshold', () => {
    const fixture = loadFixture('checkout');
    resetDetectionIds();
    const r = redact(fixture.html, fixture.visionBoxes, {
      nonce: redactionNonce(NONCE),
      viewport: fixture.truth.viewport,
      minConfidence: 0.99,
    });
    expect(['low', 'unknown']).toContain(r.log.residualRisk);
  });
});
