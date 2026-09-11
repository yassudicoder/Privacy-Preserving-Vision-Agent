// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_POLICY, markUntrusted, redactionNonce } from '@/contracts/index.ts';
import {
  DEFAULT_VIEWPORT,
  accessibleName,
  buildSanitizedContext,
  redact,
  verifyOutboundRedaction,
} from '@/redaction/index.ts';

/**
 * PII in an `aria-label` is redacted at the SOURCE, not merely caught by the
 * outbound content gate.
 *
 * The assessment found a card number in an aria-label reaching the payload as
 * `elements[].name` (accessibleName reads aria-label first) with `redacted:false`
 * - stopped only by `verifyOutboundRedaction` failing closed. That is one gate
 * where the design wants two, and a hostile aria-label aborted every step. The
 * scanner now covers aria-label, so the name is a placeholder before any gate.
 */
const CARD = '4111 1111 1111 1111';

describe('aria-label PII is redacted at the source', () => {
  it('replaces PII in an aria-label so the accessible name carries a placeholder', () => {
    const r = redact(markUntrusted(`<button aria-label="pay ${CARD}">Buy</button>`), [], {
      viewport: DEFAULT_VIEWPORT,
      nonce: redactionNonce('aria1234'),
    });
    const name = accessibleName(r.doc.querySelector('button')!) ?? '';
    expect(name).not.toContain('4111');
    expect(name).toContain('[[PII:');
  });

  it('the outbound context is clean at the FIRST gate - not left to the content gate', () => {
    const r = redact(markUntrusted(`<input name="x" aria-label="card ${CARD}">`), [], {
      viewport: DEFAULT_VIEWPORT,
      nonce: redactionNonce('aria1234'),
    });
    const ctx = buildSanitizedContext({
      doc: r.doc, log: r.log, detections: r.detections, viewport: DEFAULT_VIEWPORT,
      url: 'https://x.test', taskId: 't', step: 0, goal: 'g', screenshot: null, budget: DEFAULT_BUDGET_POLICY,
    });
    expect(JSON.stringify(ctx)).not.toContain('4111');
    // The content gate now finds nothing, because redaction already happened.
    expect(verifyOutboundRedaction(ctx, { minConfidence: 0.5 }).ok).toBe(true);
  });

  it('leaves a benign aria-label untouched (precision)', () => {
    const r = redact(markUntrusted('<button aria-label="Search Amazon.in">Go</button>'), [], {
      viewport: DEFAULT_VIEWPORT,
      nonce: redactionNonce('aria1234'),
    });
    expect(accessibleName(r.doc.querySelector('button')!)).toBe('Search Amazon.in');
  });
});
