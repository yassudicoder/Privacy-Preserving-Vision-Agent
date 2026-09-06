import { describe, expect, it } from 'vitest';
import {
  type PanelEvent,
  type RedactionLog,
  redactionNonce,
  zeroTimings,
} from '@/contracts/index.ts';
import {
  endToEndMs,
  groupRedactionsByKind,
  initialPanelState,
  latencyBars,
  privacyWarnings,
  reduceAll,
  reducePanel,
} from '@/panel/index.ts';

function log(over: Partial<RedactionLog> = {}): RedactionLog {
  return {
    schemaVersion: 1,
    frameId: 'f0',
    url: 'https://example.invalid/page',
    nonce: redactionNonce('a1b2c3d4'),
    createdAt: 1,
    entries: [
      {
        detectionId: 'd1' as never,
        kind: 'email',
        source: 'regex',
        strategy: 'placeholder',
        applied: true,
        target: { domPath: null, rect: null, attr: null },
        placeholder: '[[PII:EMAIL:1:a1b2c3d4]]',
        preservedShape: null,
        confidence: 0.9,
        reason: 'span rewritten',
      },
    ],
    summary: {
      byKind: { email: 1 },
      bySource: { regex: 1 },
      nodesRemoved: 0,
      attributesDropped: 0,
      placeholdersInserted: 1,
      pixelOpsQueued: 0,
      forgeriesStripped: 0,
    },
    residualRisk: 'none',
    ...over,
  };
}

const start: PanelEvent = { type: 'session/start', taskId: 't1', goal: 'sign in', at: 100 };

describe('reducePanel', () => {
  it('starts a session from a clean slate', () => {
    const s = reducePanel(initialPanelState, start);
    expect(s.session).toEqual({ taskId: 't1', goal: 'sign in', running: true, step: 0 });
    expect(s.timeline).toHaveLength(1);
  });

  it('discards prior state when a new session starts', () => {
    const dirty = reduceAll([start, { type: 'error', scope: 'capture', message: 'boom' }]);
    const fresh = reducePanel(dirty, { ...start, taskId: 't2' });
    expect(fresh.errors).toEqual([]);
    expect(fresh.redactions).toEqual([]);
  });

  it('accumulates redaction entries', () => {
    const s = reduceAll([start, { type: 'redaction/done', log: log(), ms: 12 }]);
    expect(s.redactions).toHaveLength(1);
    expect(s.metrics.counts.redactions).toBe(1);
    expect(s.metrics.latency.redactMs).toBe(12);
  });

  it('records only applied entries as redactions', () => {
    const withFailure = log({
      entries: [
        {
          detectionId: 'd2' as never,
          kind: 'phone',
          source: 'regex',
          strategy: 'placeholder',
          applied: false,
          target: { domPath: null, rect: null, attr: null },
          placeholder: null,
          preservedShape: null,
          confidence: 0.8,
          reason: 'DOM path no longer resolves',
        },
      ],
    });
    const s = reduceAll([start, { type: 'redaction/done', log: withFailure, ms: 1 }]);
    expect(s.redactions).toHaveLength(0);
  });

  it('keeps a privacy-gate proof from capture through verified delivery', () => {
    const s = reduceAll([
      start,
      { type: 'frame/captured', frameId: 'f0', bytes: 4096, ms: 8 },
      { type: 'redaction/done', log: log(), ms: 3 },
      { type: 'bake/done', opsRequested: 1, opsApplied: 1, opsOutsideFrame: 0, bytes: 900, ms: 4 },
      {
        type: 'context/sent',
        bytes: 1500,
        imageBytes: 900,
        elementCount: 4,
        elementsAvailable: 4,
        estimatedTokens: 99,
        tokenBudget: 1200,
        dropped: [],
        namesTruncated: 0,
        geometryOmitted: false,
        duplicatesCollapsed: 0,
        preview: { base64: 'safe-image-only', format: 'jpeg', width: 320, height: 180 },
      },
      { type: 'context/transmitted', channel: 'cloud', modelId: 'demo-vlm' },
    ]);

    expect(s.privacyGate.capture).toEqual({ bytes: 4096, ms: 8 });
    expect(s.privacyGate.redaction).toEqual({ detected: 1, applied: 1, residualRisk: 'none' });
    expect(s.privacyGate.bake).toMatchObject({ requested: 1, applied: 1, bytes: 900 });
    expect(s.privacyGate.prepared?.preview?.base64).toBe('safe-image-only');
    expect(s.privacyGate.transmitted).toEqual({ channel: 'cloud', modelId: 'demo-vlm' });
    expect(s.timeline.at(-1)?.detail).toContain('sanitized context delivered');
  });

  it('does NOT synthesise an end-to-end number by adding the stages up', () => {
    /*
     * This test previously asserted `endToEndMs === 65`, the sum of 10+20+30+5.
     *
     * That pinned behaviour the contract explicitly forbids:
     * `LatencyBreakdown.e2eMs` is documented as "wall clock for the whole step -
     * NOT the sum of the above, they overlap". The panel had no source for the
     * real figure, so it invented one, and the invented one was displayed as a
     * measurement.
     *
     * Changing the assertion rather than deleting the test: the stage times must
     * still be recorded, and e2eMs must still be absent until something reports
     * it. Both are checked below.
     */
    const s = reduceAll([
      start,
      { type: 'frame/captured', frameId: 'f0', bytes: 1000, ms: 10 },
      { type: 'redaction/done', log: log(), ms: 20 },
      { type: 'server/response', action: null, ms: 30, rawLength: 0, modelId: 'test-planner' },
      {
        type: 'action/executed',
        action: { type: 'done', summary: 'ok' },
        ok: true,
        ms: 5,
      },
    ]);
    // Stages recorded...
    expect(s.metrics.latency.captureMs).toBe(10);
    expect(s.metrics.latency.serverMs).toBe(30);
    // ...but no wall clock invented from them.
    expect(endToEndMs(s)).toBe(0);
  });

  it('takes the end-to-end number from the step that measured it', () => {
    const s = reduceAll([
      start,
      { type: 'frame/captured', frameId: 'f0', bytes: 1000, ms: 10 },
      { type: 'redaction/done', log: log(), ms: 20 },
      { type: 'step/done', step: 1, ok: true, e2eMs: 812 },
    ]);
    // 812, not 30. Real overlap means the wall clock is not the sum, and here it
    // is larger than the sum rather than smaller - which a sum can never show.
    expect(endToEndMs(s)).toBe(812);
  });

  it('advances the session step on execution', () => {
    const s = reduceAll([
      start,
      { type: 'action/executed', action: { type: 'done', summary: 'x' }, ok: true, ms: 1 },
      { type: 'action/executed', action: { type: 'done', summary: 'y' }, ok: true, ms: 1 },
    ]);
    expect(s.session?.step).toBe(2);
    /*
     * `metrics.counts.steps` is NOT advanced here, and this assertion changed.
     *
     * It used to expect 2, which pinned a double count: `action/executed` and
     * `step/done` BOTH incremented, so a real step - which emits both - counted
     * twice and the panel's Steps stat was exactly double reality. This test
     * could not see it, because it emits only `action/executed`; half of a
     * doubled number looks like a plausible number, which is why it stood.
     *
     * `step/done` is the counter now: it is the one event every step emits on
     * every path, including a step that failed before executing anything.
     */
    expect(s.metrics.counts.steps).toBe(0);
  });

  it('counts one step per step, not one per event that mentions a step', () => {
    // The regression guard the test above could not be: a WHOLE step, with both
    // events, must count exactly once.
    const s = reduceAll([
      start,
      { type: 'frame/captured', frameId: 'f0', bytes: 10, ms: 1 },
      { type: 'action/executed', action: { type: 'done', summary: 'x' }, ok: true, ms: 1 },
      { type: 'step/done', step: 1, ok: true, e2eMs: 100 },
    ]);
    expect(s.metrics.counts.steps).toBe(1);
  });

  it('records vision backend and detection counts', () => {
    const s = reduceAll([
      start,
      {
        type: 'vision/done',
        ms: 40,
        result: {
          frameId: 'f0',
          detections: [],
          backend: 'webgpu',
          modelId: 'yolos-tiny',
          timings: zeroTimings(),
        },
      },
    ]);
    expect(s.metrics.resource.backend).toBe('webgpu');
    expect(s.metrics.latency.visionMs).toBe(40);
  });

  it('collects errors and counts them', () => {
    const s = reduceAll([
      start,
      { type: 'error', scope: 'transport', message: 'timeout' },
      { type: 'error', scope: 'parse', message: 'bad json' },
    ]);
    expect(s.errors).toHaveLength(2);
    expect(s.metrics.counts.errors).toBe(2);
  });

  it('surfaces a validation refusal specifically', () => {
    const s = reduceAll([
      start,
      { type: 'error', scope: 'validate', message: 'ref e9 was not in the sent context' },
    ]);
    expect(s.lastRefusal).toContain('e9');
  });

  it('ends the session without discarding what it recorded', () => {
    const s = reduceAll([
      start,
      { type: 'redaction/done', log: log(), ms: 1 },
      { type: 'session/end', reason: 'done', at: 900 },
    ]);
    expect(s.session?.running).toBe(false);
    expect(s.redactions).toHaveLength(1);
  });

  it('caps the timeline so a long session cannot grow without bound', () => {
    const events: PanelEvent[] = [start];
    for (let i = 0; i < 400; i++) {
      events.push({ type: 'frame/captured', frameId: `f${String(i)}`, bytes: 1, ms: 1 });
    }
    expect(reduceAll(events).timeline.length).toBeLessThanOrEqual(200);
  });

  it('never mutates the state it is given', () => {
    const before = reduceAll([start]);
    const snapshot = JSON.stringify(before);
    reducePanel(before, { type: 'redaction/done', log: log(), ms: 1 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('selectors', () => {
  it('groups redactions by kind', () => {
    const s = reduceAll([start, { type: 'redaction/done', log: log(), ms: 1 }]);
    expect(groupRedactionsByKind(s)).toEqual([
      { kind: 'email', count: 1, strategies: ['placeholder'] },
    ]);
  });

  it('reports latency as fractions that sum to one when anything was measured', () => {
    const s = reduceAll([
      start,
      { type: 'frame/captured', frameId: 'f0', bytes: 1, ms: 25 },
      { type: 'server/response', action: null, ms: 75, rawLength: 0, modelId: 'test-planner' },
    ]);
    const total = latencyBars(s).reduce((acc, b) => acc + b.fraction, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('warns when forged redaction tokens were stripped', () => {
    const s = reduceAll([
      start,
      {
        type: 'redaction/done',
        ms: 1,
        log: log({ summary: { ...log().summary, forgeriesStripped: 2 } }),
      },
    ]);
    expect(privacyWarnings(s).join(' ')).toContain('forged');
  });

  it('is quiet when there is nothing to warn about', () => {
    const s = reduceAll([start, { type: 'redaction/done', log: log(), ms: 1 }]);
    expect(privacyWarnings(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// a dropped element is never silent
// ---------------------------------------------------------------------------

describe('the panel says when the budget bounded coverage', () => {
  function sent(over: Partial<Parameters<typeof reducePanel>[1]> = {}) {
    return reducePanel(initialPanelState, {
      type: 'context/sent',
      bytes: 12480,
      imageBytes: 0,
      elementCount: 61,
      elementsAvailable: 61,
      estimatedTokens: 2891,
      tokenBudget: 3400,
      dropped: [],
      namesTruncated: 0,
      geometryOmitted: false,
      duplicatesCollapsed: 0,
      ...over,
    } as Parameters<typeof reducePanel>[1]);
  }

  it('reads as a normal line when nothing was dropped', () => {
    const s = sent();
    const line = s.timeline[s.timeline.length - 1];
    expect(line?.kind).toBe('info');
    expect(line?.detail).toContain('61 element(s)');
    expect(line?.detail).toContain('2891/3400 tok');
  });

  it('names the count AND the refs when elements were dropped', () => {
    /*
     * CLAUDE.md: "if a workflow bounds coverage, log what was dropped - silent
     * truncation reads as covered everything when it didn't." The refs matter
     * because the panel is a debug view: a human has to be able to check whether
     * the thing the agent needed is the thing that went missing.
     */
    const s = sent({
      elementCount: 61,
      elementsAvailable: 69,
      dropped: [
        { ref: 'e62', role: 'img' },
        { ref: 'e63', role: 'heading' },
      ],
    });
    const line = s.timeline[s.timeline.length - 1];
    expect(line?.detail).toContain('61 of 69 element(s)');
    expect(line?.detail).toContain('dropped 2');
    expect(line?.detail).toContain('e62');
  });

  it('marks a drop as warn, not info', () => {
    // A step that succeeded while doing less than asked must not look routine.
    const s = sent({
      elementCount: 61,
      elementsAvailable: 69,
      dropped: [{ ref: 'e62', role: 'img' }],
    });
    expect(s.timeline[s.timeline.length - 1]?.kind).toBe('warn');
  });

  it('reports omitted geometry and truncated names', () => {
    const s = sent({ geometryOmitted: true, namesTruncated: 3 });
    const line = s.timeline[s.timeline.length - 1];
    expect(line?.detail).toContain('geometry omitted');
    expect(line?.detail).toContain('3 name(s) truncated');
  });

  it('splits image bytes out of the total', () => {
    /*
     * `bytes` is JSON.stringify(context).length, which folds the base64
     * screenshot in with the text. Without the split, a context that overflowed
     * gave no clue which half grew.
     */
    const s = sent({ bytes: 70000, imageBytes: 52000 });
    expect(s.timeline[s.timeline.length - 1]?.detail).toContain('52000 image');
  });
});

describe('the panel remembers the budget in force', () => {
  it('records the budget the last step ran under', () => {
    /*
     * The input needs to show what is ACTUALLY in force. Falling back to a
     * hardcoded default would let the field disagree with the background's
     * stored value - the user would read 3400, the steps would run at 7000, and
     * `geometry omitted` would look inexplicable.
     */
    const s = reducePanel(initialPanelState, {
      type: 'context/sent',
      bytes: 1,
      imageBytes: 0,
      elementCount: 10,
      elementsAvailable: 10,
      estimatedTokens: 900,
      tokenBudget: 7000,
      dropped: [],
      namesTruncated: 0,
      geometryOmitted: false,
      duplicatesCollapsed: 0,
    });
    expect(s.tokenBudget).toBe(7000);
  });

  it('starts unknown rather than guessing', () => {
    expect(initialPanelState.tokenBudget).toBeNull();
  });
});
