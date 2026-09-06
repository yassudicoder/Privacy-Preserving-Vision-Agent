import { describe, expect, it } from 'vitest';
import {
  type BackendDescriptor,
  type PanelEvent,
  type RedactionLog,
  emptySummary,
} from '@/contracts/index.ts';
import {
  formatReceipt,
  initialPanelState,
  privacyWarnings,
  receiptNetworkLines,
  reduceAll,
} from '@/panel/index.ts';

/**
 * The privacy receipt reports MEASUREMENTS, and reports the absence of one as
 * an absence.
 *
 * The failure this file exists to prevent is a card that prints
 *
 *     RAW PII        NOT SENT
 *     RAW SCREENSHOT NOT SENT
 *
 * unconditionally. Both lines are true today, they would stay on screen after a
 * regression, and they would be the last thing anyone doubted - a UI asserting a
 * property it never measured is worse than no UI, because it turns an open
 * question into a confident answer.
 *
 * So the assertions below are mostly about the NEGATIVE cases: a step that never
 * reached the gate, a gate that blocked, a backend that was never probed.
 */

const CLOUD: BackendDescriptor = {
  kind: 'cloud',
  endpoint: 'https://api.example.com',
  model: 'hosted-vlm',
  offDevice: true,
  authenticated: true,
  encrypted: true,
};

const ON_DEVICE: BackendDescriptor = {
  kind: 'on-device',
  endpoint: null,
  model: 'local-heuristic-baseline',
  offDevice: false,
  authenticated: false,
  encrypted: false,
};

function log(applied: number, detected: number): RedactionLog {
  return {
    schemaVersion: 1,
    createdAt: 0,
    frameId: 'f1',
    url: 'https://example.test/',
    nonce: 'a1b2c3d4',
    residualRisk: 'none',
    entries: Array.from({ length: detected }, (_, i) => ({
      detectionId: `d${String(i)}`,
      kind: 'email' as const,
      source: 'dom-scan' as const,
      strategy: 'placeholder' as const,
      applied: i < applied,
      target: { domPath: null, rect: null, attr: null },
      placeholder: null,
      preservedShape: { length: 8, charClass: 'mixed' as const },
      evidenceHash: 'h',
      confidence: 0.9,
    })),
    summary: { ...emptySummary() },
  } as unknown as RedactionLog;
}

/** The events one clean, off-device step emits, in the order the step emits them. */
function cleanStep(step: number): PanelEvent[] {
  return [
    { type: 'backend/selected', descriptor: CLOUD },
    { type: 'frame/captured', frameId: 'f1', bytes: 40_000, ms: 20 },
    {
      type: 'vision/done',
      ms: 30,
      result: {
        frameId: 'f1',
        detections: [],
        backend: 'webgpu',
        modelId: 'yunet',
        timings: { decodeMs: 1, preprocessMs: 1, inferMs: 1, postprocessMs: 1 },
      },
    } as PanelEvent,
    { type: 'detections/merged', detections: [], ms: 2 } as PanelEvent,
    { type: 'redaction/done', log: log(4, 4), ms: 12 },
    {
      type: 'bake/done',
      opsApplied: 3,
      opsRequested: 4,
      opsOutsideFrame: 1,
      bytes: 5000,
      ms: 9,
    },
    {
      type: 'context/sent',
      bytes: 12_000,
      imageBytes: 5000,
      elementCount: 20,
      elementsAvailable: 20,
      estimatedTokens: 900,
      tokenBudget: 3400,
      dropped: [],
      namesTruncated: 0,
      geometryOmitted: false,
      duplicatesCollapsed: 0,
      preview: null,
    },
    { type: 'privacy/verified', step, checkedFields: 27, leaks: [], blocked: false, reason: null },
    { type: 'context/transmitted', channel: 'cloud', modelId: 'qwen2.5vl:3b', backend: 'cloud' },
    {
      type: 'server/response',
      action: { type: 'click', ref: 'e3' } as never,
      ms: 240,
      rawLength: 30,
      modelId: 'qwen2.5vl:3b',
    },
    {
      type: 'action/executed',
      action: { type: 'click', ref: 'e3' } as never,
      ok: true,
      ms: 15,
    },
    { type: 'step/done', step, ok: true, e2eMs: 620 },
  ];
}

describe('a completed off-device step', () => {
  it('records what was measured, not what was assumed', () => {
    const state = reduceAll(cleanStep(1));
    const r = state.receipt;

    expect(r.step).toBe(1);
    expect(r.perception.domCaptured).toBe(true);
    expect(r.perception.frameBytes).toBe(40_000);
    expect(r.privacy.redactionsApplied).toBe(4);
    expect(r.privacy.pixelOpsApplied).toBe(3);
    expect(r.privacy.pixelOpsOutsideFrame).toBe(1);
    expect(r.deployment).toEqual(CLOUD);
    // What ANSWERED, from the plan response - not the configured label.
    expect(r.modelAnswered).toBe('qwen2.5vl:3b');
    expect(r.deployment?.model).toBe('hosted-vlm');
    expect(r.validation).toBe('pass');
    expect(r.execution).toBe('pass');
    expect(r.e2eMs).toBe(620);
  });

  it('reports raw PII as verified-absent WITH the number of fields checked', () => {
    const r = reduceAll(cleanStep(1)).receipt;
    expect(r.network.rawPii).toEqual({ state: 'verified-absent', checkedFields: 27 });
    // A scanner that walked nothing also reports nothing found. The count is
    // what makes those distinguishable, so it must actually travel.
    expect(receiptNetworkLines(r)[1]?.value).toContain('27 field(s) checked');
  });

  it('reports the sanitized context and the image as SENT, because they were', () => {
    const r = reduceAll(cleanStep(1)).receipt;
    expect(r.network.sanitizedContext).toEqual({ state: 'sent', bytes: 12_000 });
    expect(r.network.redactedScreenshot).toEqual({ state: 'sent', bytes: 5000 });
    /*
     * `sent` is toned differently from `blocked`. A SENT line is not a warning -
     * the sanitized context is supposed to be sent - and colouring it as a hazard
     * would teach a reader to ignore the colour that matters.
     */
    const lines = receiptNetworkLines(r);
    expect(lines.find((l) => l.label === 'Sanitized context')?.tone).toBe('sent');
    expect(lines.find((l) => l.label === 'Raw PII')?.tone).toBe('ok');
  });

  it('is filed under the step number the step reported', () => {
    const state = reduceAll([...cleanStep(1), ...cleanStep(2)]);
    expect(state.receipts.map((r) => r.step)).toEqual([1, 2]);
    // Sealed independently: step 2's counts do not bleed into step 1's record.
    expect(state.receipts[0]?.e2eMs).toBe(620);
  });
});

describe('an on-device step', () => {
  it('says the context STAYED, which is not the same as "we checked the wire"', () => {
    const events = cleanStep(1).map((e) =>
      e.type === 'backend/selected'
        ? { ...e, descriptor: ON_DEVICE }
        : e.type === 'context/transmitted'
          ? { ...e, channel: 'on-device' as const, backend: 'on-device' as const }
          : e,
    );
    const r = reduceAll(events).receipt;

    expect(r.network.sanitizedContext.state).toBe('stayed-on-device');
    expect(r.deployment?.offDevice).toBe(false);
    expect(formatReceipt(r)).toContain('NOT SENT - planned on this device');
    expect(formatReceipt(r)).toContain('never left this device');
  });
});

describe('a step that never reached the gate', () => {
  it('says NOT CHECKED, never NOT SENT', () => {
    /*
     * THE ASSERTION THIS FILE IS FOR.
     *
     * A step that died at capture never ran an egress check. Reporting "RAW PII:
     * NOT SENT" there would be technically true and epistemically worthless - it
     * would be true of a step that did nothing at all, which is exactly when a
     * receipt is least informative and most likely to be believed.
     */
    const state = reduceAll([
      { type: 'backend/selected', descriptor: CLOUD },
      { type: 'frame/captured', frameId: 'f1', bytes: 100, ms: 5 },
      { type: 'error', scope: 'capture', message: 'the tab was not visible' },
      { type: 'step/done', step: 1, ok: false, e2eMs: 30 },
    ]);

    const r = state.receipt;
    expect(r.network.rawPii).toEqual({ state: 'not-checked' });
    expect(r.network.rawScreenshot).toEqual({ state: 'not-checked' });
    expect(r.validation).toBe('not-reached');
    expect(r.execution).toBe('not-reached');

    const text = formatReceipt(r);
    expect(text).toContain('NOT CHECKED');
    expect(text).not.toContain('Raw PII               NOT SENT');
  });
});

describe('a step the egress gate blocked', () => {
  const blocked: PanelEvent[] = [
    { type: 'backend/selected', descriptor: CLOUD },
    { type: 'frame/captured', frameId: 'f1', bytes: 100, ms: 5 },
    { type: 'redaction/done', log: log(2, 3), ms: 8 },
    {
      type: 'privacy/verified',
      step: 1,
      checkedFields: 31,
      leaks: [{ kind: 'email', field: 'elements[7].value' }],
      blocked: true,
      reason: 'outbound context BLOCKED: unredacted content found after sanitization',
    },
    { type: 'error', scope: 'verify', message: 'outbound context BLOCKED' },
    { type: 'step/done', step: 1, ok: false, e2eMs: 90 },
  ];

  it('marks every claim as BLOCKED, including the ones that would have been sent', () => {
    const r = reduceAll(blocked).receipt;
    expect(r.network.rawPii.state).toBe('blocked');
    expect(r.network.sanitizedContext.state).toBe('blocked');
    expect(r.network.redactedScreenshot.state).toBe('blocked');
  });

  it('names the kind and the field, and never the value', () => {
    const r = reduceAll(blocked).receipt;
    expect(r.network.leaks).toEqual([{ kind: 'email', field: 'elements[7].value' }]);
    const text = formatReceipt(r);
    expect(text).toContain('email in elements[7].value');
    // The leak type carries no value field, so there is nothing to print even
    // if this line wanted to. Asserted so that stays true.
    expect(Object.keys(r.network.leaks[0] ?? {}).sort()).toEqual(['field', 'kind']);
  });

  it('is the loudest thing in the warnings list', () => {
    const warnings = privacyWarnings(reduceAll(blocked));
    expect(warnings.join(' ')).toContain('outbound context BLOCKED');
    expect(warnings.join(' ')).toContain('email');
  });
});

describe('post-action verification', () => {
  it('attaches to the step it names, not to the newest one', () => {
    /*
     * The loop compares fingerprints AFTER `step/done`, so the receipt it patches
     * has already been sealed. Matching on the step number rather than patching
     * the newest entry means a late or out-of-order event cannot attach a
     * verification to a step it did not describe.
     */
    const state = reduceAll([
      ...cleanStep(1),
      ...cleanStep(2),
      { type: 'page/verified', step: 1, changed: true },
      { type: 'page/verified', step: 2, changed: false },
    ]);

    expect(state.receipts[0]?.verification).toEqual({ kind: 'changed' });
    expect(state.receipts[1]?.verification).toEqual({ kind: 'unchanged' });
  });

  it('says "changed", never "verified"', () => {
    // A DOM fingerprint proves something moved, not that the right thing moved.
    // On a page with a clock in the header it moves every step regardless.
    const state = reduceAll([...cleanStep(1), { type: 'page/verified', step: 1, changed: true }]);
    const text = formatReceipt(state.receipts[0] ?? state.receipt);
    expect(text).toContain('page changed after the action');
    expect(text).not.toMatch(/\bVERIFIED\b/);
  });

  it('defaults to not-checked when the loop supplied no fingerprint', () => {
    expect(reduceAll(cleanStep(1)).receipt.verification).toEqual({ kind: 'not-checked' });
  });
});

describe('plan-only', () => {
  it('reports execution as WITHHELD, not as a pass', () => {
    /*
     * Plan-only exists for pointing the agent at a real logged-in page. `ok:true`
     * alone reads as "the click landed" and nothing was clicked - a false success
     * claim in exactly the mode where one is least acceptable.
     */
    const events = cleanStep(1).map((e) =>
      e.type === 'action/executed' ? { ...e, withheld: true } : e,
    );
    const r = reduceAll(events).receipt;
    expect(r.execution).toBe('withheld');
    expect(formatReceipt(r)).toContain('WITHHELD');
  });
});

describe('backend state in the panel', () => {
  it('starts with no deployment and no health, which is not "down"', () => {
    expect(initialPanelState.deployment).toBeNull();
    expect(initialPanelState.backendHealth).toBeNull();
    expect(initialPanelState.backendUnavailable).toBeNull();
  });

  it('clears a stale health probe when the backend changes', () => {
    /*
     * A measurement of a DIFFERENT endpoint shown against a new backend is the
     * confident-and-wrong report this panel avoids everywhere else. Null means
     * "not probed", which the UI renders as unknown rather than as down.
     */
    const state = reduceAll([
      { type: 'backend/selected', descriptor: CLOUD },
      {
        type: 'backend/health',
        health: {
          kind: 'cloud',
          reachable: true,
          waking: false,
          authRequired: false,
          plannerId: 'hosted',
          description: null,
          error: null,
          checkedAtMs: 1,
        },
      },
      { type: 'backend/selected', descriptor: ON_DEVICE },
    ]);
    expect(state.backendHealth).toBeNull();
    expect(state.deployment).toEqual(ON_DEVICE);
  });

  it('keeps a health probe that belongs to the selected backend', () => {
    const state = reduceAll([
      { type: 'backend/selected', descriptor: CLOUD },
      {
        type: 'backend/health',
        health: {
          kind: 'cloud',
          reachable: true,
          waking: false,
          authRequired: false,
          plannerId: 'hosted',
          description: null,
          error: null,
          checkedAtMs: 1,
        },
      },
      { type: 'backend/selected', descriptor: CLOUD },
    ]);
    expect(state.backendHealth?.plannerId).toBe('hosted');
  });

  it('holds an unavailable backend until the user resolves it, and records it too', () => {
    const state = reduceAll([
      { type: 'backend/selected', descriptor: CLOUD },
      {
        type: 'backend/unavailable',
        unavailable: {
          kind: 'private',
          endpoint: 'https://ai.example.com',
          error: 'could not reach https://ai.example.com',
          alternatives: ['on-device', 'local'],
        },
      },
    ]);

    expect(state.backendUnavailable?.alternatives).toEqual(['on-device', 'local']);
    // In the errors list as well as the banner: a failure that vanishes once
    // resolved is a failure nobody can account for afterwards.
    expect(state.errors.join(' ')).toContain('private unavailable');
    // And the SELECTION did not move. Nothing here switches anything.
    expect(state.deployment?.kind).toBe('cloud');
  });

  it('clears the banner only when a selection is actually made', () => {
    const state = reduceAll([
      {
        type: 'backend/unavailable',
        unavailable: {
          kind: 'private',
          endpoint: 'https://ai.example.com',
          error: 'down',
          alternatives: ['on-device'],
        },
      },
      { type: 'backend/selected', descriptor: ON_DEVICE },
    ]);
    expect(state.backendUnavailable).toBeNull();
  });

  it('survives a new session, because it is a setting and not task state', () => {
    const state = reduceAll([
      { type: 'backend/selected', descriptor: CLOUD },
      { type: 'session/start', taskId: 't2', goal: 'buy a laptop', at: 5 },
    ]);
    expect(state.deployment).toEqual(CLOUD);
    // Everything task-shaped IS cleared.
    expect(state.redactions).toEqual([]);
    expect(state.errors).toEqual([]);
  });
});

describe('the formatted receipt', () => {
  it('carries no credential, whatever the backend', () => {
    /*
     * The receipt is designed to be copied into a report or an issue. A
     * `BackendDescriptor` has no field that can hold a token - `authenticated` is
     * a boolean - and this asserts the rendering did not reintroduce one.
     */
    const text = formatReceipt(reduceAll(cleanStep(1)).receipt);
    expect(text).toContain('Authenticated');
    expect(text).toContain('yes');
    expect(text).not.toMatch(/Bearer|sk-|token[:=]\s*\S{8,}/i);
  });

  it('shows what answered and what was configured, in that order', () => {
    const text = formatReceipt(reduceAll(cleanStep(1)).receipt);
    expect(text.indexOf('Answered')).toBeLessThan(text.indexOf('Configured'));
    expect(text).toContain('qwen2.5vl:3b');
    expect(text).toContain('hosted-vlm');
  });
});

// --- regressions the adversarial review found -------------------------------

describe('defects an audit found, pinned', () => {
  it('does not carry the previous step proof into a step that failed early', () => {
    /*
     * `frame/captured` reset the receipt but spread `...state.privacyGate` and
     * overwrote only `capture`, so `redaction`, `bake`, `prepared` and
     * `transmitted` survived - and nothing else cleared them, because
     * `session/start` is emitted by no production path.
     *
     * The panel then showed the receipt card correctly reporting step 2 as
     * `not-checked` everywhere, while the Privacy Gate section directly above it
     * said "Sanitized context delivered to qwen2.5vl:3b" for a step in which
     * nothing was sanitized and nothing was sent.
     */
    const state = reduceAll([
      ...cleanStep(1),
      { type: 'frame/captured', frameId: 'f2', bytes: 100, ms: 5 },
      { type: 'error', scope: 'redact', message: 'DOMParser is not defined' },
      { type: 'step/done', step: 2, ok: false, e2eMs: 40 },
    ]);

    expect(state.privacyGate.transmitted).toBeNull();
    expect(state.privacyGate.prepared).toBeNull();
    expect(state.privacyGate.bake).toBeNull();
    expect(state.privacyGate.redaction).toBeNull();
    // The capture that DID happen is kept - it is this step's measurement.
    expect(state.privacyGate.capture).toEqual({ bytes: 100, ms: 5 });
  });

  it('does not file the previous step under a failed step number', () => {
    /*
     * A step can fail BEFORE `frame/captured` - `snapshot` throws, or capture
     * itself does - and `step/done` still fires. Stamping the new step number
     * onto the untouched accumulator filed step 1's redactions, masks and
     * transmission under step 2, for a step that never read the page.
     */
    const state = reduceAll([
      ...cleanStep(1),
      { type: 'error', scope: 'snapshot', message: 'Receiving end does not exist' },
      { type: 'step/done', step: 2, ok: false, e2eMs: 12 },
    ]);

    const second = state.receipts[1];
    expect(second?.step).toBe(2);
    expect(second?.perception.domCaptured).toBe(false);
    expect(second?.privacy.redactionsApplied).toBe(0);
    expect(second?.network.sanitizedContext).toEqual({ state: 'not-checked' });
    // Step 1's real receipt is untouched.
    expect(state.receipts[0]?.privacy.redactionsApplied).toBe(4);
  });

  it('does not claim SENT with a byte count it never measured', () => {
    /*
     * This read `prepared?.bytes ?? 0` and rendered "SENT (0 bytes)" when
     * `context/sent` had not been seen - asserting both that a transmission
     * happened and that it was empty, neither of which was measured.
     */
    const state = reduceAll([
      { type: 'backend/selected', descriptor: CLOUD },
      { type: 'frame/captured', frameId: 'f1', bytes: 10, ms: 1 },
      { type: 'context/transmitted', channel: 'cloud', modelId: 'm', backend: 'cloud' },
      { type: 'step/done', step: 1, ok: true, e2eMs: 10 },
    ]);
    expect(state.receipt.network.sanitizedContext).toEqual({ state: 'not-checked' });
    expect(formatReceipt(state.receipt)).not.toContain('SENT (0 bytes)');
  });

  it('patches only the most recent receipt sharing a step number', () => {
    /*
     * Step numbers restart at 1 every run and `receipts` accumulates across runs
     * - `session/start` is emitted by no production path, so nothing clears them
     * between tasks. Matching on the number alone patched EVERY receipt numbered
     * 1, including one from a previous run, with a verification that describes a
     * different page.
     *
     * `taskId` cannot be the discriminator on its own for the same reason: with
     * no `session/start` it is null on every receipt. So the rule is the LAST
     * match, which is the step this event is actually about.
     */
    const state = reduceAll([
      ...cleanStep(1), // run A, step 1
      ...cleanStep(1), // run B, step 1 - the numbers restart
      { type: 'page/verified', step: 1, changed: false },
    ]);

    expect(state.receipts).toHaveLength(2);
    // The older one is untouched: nothing was ever measured about its page.
    expect(state.receipts[0]?.verification).toEqual({ kind: 'not-checked' });
    expect(state.receipts[1]?.verification).toEqual({ kind: 'unchanged' });
  });

  it('clears a refusal when the next step starts', () => {
    // `lastRefusal` was never cleared, so one refused action left a permanent
    // "last action refused" warning - including after a later step corrected it.
    const state = reduceAll([
      ...cleanStep(1),
      { type: 'error', scope: 'validate', message: 'refused action: not-typeable' },
      { type: 'frame/captured', frameId: 'f2', bytes: 10, ms: 1 },
    ]);
    expect(state.lastRefusal).toBeNull();
    expect(privacyWarnings(state).join(' ')).not.toContain('refused');
  });
});
