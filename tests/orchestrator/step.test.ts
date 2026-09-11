// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createInProcessDomPipeline } from '@/redaction/index.ts';
import {
  type Action,
  type CapturedFrame,
  type PanelEvent,
  type ViewportInfo,
  type VisionResult,
  redactionNonce,
  rect,
  detectionId,
  type PiiKind,
} from '@/contracts/index.ts';
import type { CaptureAdapter, CaptureOptions, InferenceHost } from '@/perception/index.ts';
import type { AgentClient, PlanOutcome, PlanRequest } from '@/agent-server/index.ts';
import { type StepDeps, type StepInput, runAgentStep, resetVisionBreaker } from '@/orchestrator/index.ts';

/*
 * THE VISION BREAKER IS MODULE-LEVEL STATE.
 *
 * It latches after three consecutive detect failures and, until this hook
 * existed, nothing in the suite ever cleared it. This file already trips it
 * twice, so it sat at 2 of 3 - a third failing-detect test anywhere would have
 * silently pushed every later test in the file onto the vision-skipped path,
 * where they would still pass while asserting nothing about the code they name.
 */
beforeEach(() => {
  resetVisionBreaker();
});

/**
 * One agent step, end to end, with every browser seam faked.
 *
 * The ordering is the logic here, so most of these tests are about sequence and
 * about what happens when a stage fails - not about any single stage's output,
 * which is covered where that stage lives.
 *
 * The two that matter most are the privacy ones: that no page text reaches the
 * outgoing context, and that an action naming an element we never exposed is
 * refused BEFORE anything is executed.
 */

const CARD = '4111111111111111';
const EMAIL = 'ada@example.com';

const PAGE = `<!doctype html><html><head><title>Checkout</title></head><body>
  <label for="card">Card</label>
  <input id="card" name="cardNumber" value="${CARD}" data-test-rect="10,20,200,30">
  <label for="email">Email</label>
  <input id="email" name="email" value="${EMAIL}" data-test-rect="10,60,200,30">
  <button id="pay" data-test-rect="10,100,80,30">Pay now</button>
</body></html>`;

const VIEWPORT: ViewportInfo = {
  cssWidth: 400,
  cssHeight: 300,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
};

const CAPTURE_OPTS: CaptureOptions = { format: 'jpeg', quality: 80, maxEdgePx: 1280 };

function frame(): CapturedFrame {
  return {
    frameId: 'frame-1',
    dataUrl: 'data:image/jpeg;base64,AAAA',
    encodedBytes: 3,
    natural: { width: 400, height: 300 },
    viewport: VIEWPORT,
    capturedAt: 1_700_000_000_000,
  };
}

function vision(): VisionResult {
  return {
    frameId: 'frame-1',
    detections: [],
    backend: 'stub',
    modelId: 'fake',
    timings: { decodeMs: 1, preprocessMs: 1, inferMs: 1, postprocessMs: 1 },
  };
}

/** Builds the deps, recording everything the step touches. */
function harness(
  over: {
    snapshotFails?: Error;
    captureFails?: Error;
    hostFails?: Error;
    plan?: (req: PlanRequest) => PlanOutcome;
    executeOk?: boolean;
    html?: string;
    failCmd?: { cmd: string; err: Error };
    bakeResult?: { opsApplied: number; opsRequested: number; opsOutsideFrame: number };
    /**
     * Forces an exact applied-vs-covered shape, so the per-detection guard can
     * be tested without hand-building a page whose geometry happens to produce
     * it. `applied` are detection ids marked applied in the log; `coveredOps`
     * are the ids that got a pixel op.
     */
    redactionOverride?: {
      applied: readonly string[];
      coveredOps: readonly string[];
      /** Ids `redact` reports as `<input type="hidden">` - owed no pixel op. */
      unpaintable?: readonly string[];
    };
  } = {},
) {
  const events: PanelEvent[] = [];
  const hostCalls: [string, unknown][] = [];
  const executed: Action[] = [];
  const executedPaths: (string | null)[] = [];
  const sentContexts: PlanRequest[] = [];

  const host: InferenceHost = {
    kind: 'chrome-offscreen',
    ensureStarted: () => Promise.resolve(),
    isRunning: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
    request: <T,>(cmd: string, payload: unknown): Promise<T> => {
      hostCalls.push([cmd, payload]);
      if (over.hostFails !== undefined) return Promise.reject(over.hostFails);
      // Selective failure. `hostFails` rejects EVERYTHING, so detect dies first
      // and later stages are never reached - useless for testing them.
      if (over.failCmd !== undefined && over.failCmd.cmd === cmd) {
        return Promise.reject(over.failCmd.err);
      }
      if (cmd === 'retain') return Promise.resolve(null as T);
      if (cmd === 'detect') return Promise.resolve(vision() as T);
      if (cmd === 'bake') {
        const counts = over.bakeResult ?? {
          opsApplied: 1,
          opsRequested: 1,
          opsOutsideFrame: 0,
        };
        return Promise.resolve({
          base64: 'BAKED',
          format: 'jpeg',
          width: 400,
          height: 300,
          ...counts,
        } as T);
      }
      return Promise.resolve({} as T);
    },
  };

  const capture: CaptureAdapter = {
    capture: () => {
      if (over.captureFails !== undefined) return Promise.reject(over.captureFails);
      return Promise.resolve(frame());
    },
  };

  // Default: click the first element the context actually exposed. A real
  // server only knows the refs we sent it, and so does this one.
  const client: AgentClient = {
    plan: (req) => {
      sentContexts.push(req);
      if (over.plan !== undefined) return Promise.resolve(over.plan(req));
      const ref = req.context.elements[0]?.ref ?? 'e0';
      return Promise.resolve({
        ok: true,
        response: {
          protocolVersion: 1,
          raw: JSON.stringify({ type: 'click', ref }),
          modelId: 'fake-vlm',
          serverMs: 5,
        },
      } as PlanOutcome);
    },
  };

  let t = 1000;
  const deps: StepDeps = {
    /*
     * These tests run under jsdom, so the in-process pipeline works here exactly
     * as it does on Firefox's event page. That is also why they never caught the
     * Chrome failure: a service worker has no DOM, and nothing in this file ever
     * ran without one.
     */
    dom: (() => {
      const real = createInProcessDomPipeline();
      if (over.redactionOverride === undefined) return real;
      const { applied, coveredOps, unpaintable = [] } = over.redactionOverride;
      return {
        ...real,
        redact: async (req: Parameters<typeof real.redact>[0]) => {
          const out = await real.redact(req);
          return {
            ...out,
            /*
             * Cloned from a REAL entry rather than hand-built, so this stub can
             * never drift from `RedactionEntry` - a literal here would need
             * updating every time the type gains a field, and the failure would
             * be a compile error in a test rather than a signal about the code.
             */
            log: {
              ...out.log,
              entries: applied.map((id, i) => ({
                ...(out.log.entries[0] ?? ({} as (typeof out.log.entries)[number])),
                detectionId: detectionId(id),
                kind: (i === 0 ? 'email' : 'phone') as PiiKind,
                applied: true,
              })),
            },
            pixelOps: coveredOps.map((id) => ({
              detectionId: detectionId(id),
              kind: 'email' as PiiKind,
              strategy: 'blackout' as const,
              rect: rect('device-px', 0, 0, 10, 10),
              intensity: 1,
            })),
            unpaintable: unpaintable.map((id) => detectionId(id)),
          } as typeof out;
        },
      };
    })(),
    snapshot: () => {
      if (over.snapshotFails !== undefined) return Promise.reject(over.snapshotFails);
      return Promise.resolve({ html: over.html ?? PAGE, viewport: VIEWPORT });
    },
    capture,
    host,
    client,
    execute: (_tabId, action, domPath) => {
      executed.push(action);
      executedPaths.push(domPath);
      return Promise.resolve({ ok: over.executeOk ?? true, note: '' });
    },
    emit: (e) => events.push(e),
    now: () => (t += 3),
  };

  return { deps, events, hostCalls, executed, executedPaths, sentContexts };
}

const INPUT: StepInput = {
  tabId: 1,
  taskId: 'task-1',
  step: 0,
  goal: 'pay the invoice',
  url: 'https://shop.example/checkout?session=secret-token',
  nonce: redactionNonce('a1b2c3d4'),
  salt: 'test-salt',
  allowedOrigins: ['https://shop.example'],
  captureOptions: CAPTURE_OPTS,
  /*
   * Explicit, because vision is now OFF by default - it cost ~84% of a real
   * step and returned zero detections. These tests are ABOUT the vision path,
   * so they opt in rather than rely on a default that no longer holds. The
   * default itself is pinned separately below.
   */
  vision: true,
};

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

describe('runAgentStep completes a full step', () => {
  it('returns an outcome with the action it executed', async () => {
    const h = harness();
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok, result.ok ? '' : `${result.stage}: ${result.error}`).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.action?.type).toBe('click');
    expect(result.outcome.step).toBe(0);
    expect(h.executed).toHaveLength(1);
  });

  it('emits the panel events in pipeline order', async () => {
    const h = harness();
    await runAgentStep(h.deps, INPUT);
    const types = h.events.map((e) => e.type);
    expect(types).toEqual([
      'frame/captured',
      'vision/done',
      'detections/merged',
      'redaction/done',
      'context/sent',
      // The egress gate, between preparing the payload and sending it. Its
      // position in this list is the property that matters: a `privacy/verified`
      // arriving AFTER `context/transmitted` would mean the check ran on
      // something already on the wire.
      'privacy/verified',
      'context/transmitted',
      'server/response',
      'action/executed',
      // Terminal, and last on purpose: it carries the real wall clock, which is
      // only known once everything else has finished.
      'step/done',
    ]);
  });

  it('does not accept done before an action-oriented task has progressed', async () => {
    const h = harness({
      plan: (() => {
        let calls = 0;
        return (req) => {
          calls += 1;
          return calls === 1
            ? {
                ok: true,
                response: {
                  protocolVersion: 1,
                  raw: JSON.stringify({ type: 'done', summary: 'already done' }),
                  modelId: 'fake-vlm',
                  serverMs: 5,
                },
              }
            : {
                ok: true,
                response: {
                  protocolVersion: 1,
                  raw: JSON.stringify({ type: 'click', ref: req.context.elements[0]?.ref }),
                  modelId: 'fake-vlm',
                  serverMs: 5,
                },
              };
        };
      })(),
    });
    const result = await runAgentStep(h.deps, { ...INPUT, goal: 'search for invoice' });
    expect(result.ok).toBe(true);
    expect(h.executed[0]?.type).toBe('click');
  });

  it('recovers an explicit search when Qwen returns done twice', async () => {
    const h = harness({
      html: '<main><label for="search">Search Amazon</label><input id="search" type="search"></main>',
      plan: () => ({
        ok: true,
        response: {
          protocolVersion: 1,
          raw: JSON.stringify({ type: 'done', summary: 'already done' }),
          modelId: 'qwen2.5vl:3b',
          serverMs: 5,
        },
      }),
    });
    const result = await runAgentStep(h.deps, { ...INPUT, goal: 'search macbook pro' });
    expect(result.ok).toBe(true);
    expect(h.executed[0]?.type).toBe('type');
    expect(h.executed[0] && 'text' in h.executed[0] ? h.executed[0].text : '').toBe('macbook pro');
  });

  it('records a latency breakdown rather than zeros', async () => {
    const h = harness();
    const result = await runAgentStep(h.deps, INPUT);
    if (!result.ok) throw new Error('expected success');
    const l = result.outcome.latency;
    expect(l.captureMs).toBeGreaterThan(0);
    expect(l.visionMs).toBeGreaterThan(0);
    expect(l.serverMs).toBeGreaterThan(0);
    expect(l.e2eMs).toBeGreaterThan(0);
  });

  it('calls detect before bake, and only detect when screenshots are off', async () => {
    // Screenshots are off by default and that is a measured decision, not a
    // default - perception/bench.ts exists to make it an output.
    const h = harness();
    await runAgentStep(h.deps, INPUT);
    // 'release' joins it deliberately: the retained frame is decoded and
    // UNREDACTED, so the step that captured it says when it is done rather than
    // leaving the worker's own eviction to get round to it. No 'bake', which is
    // what this test is actually about.
    expect(h.hostCalls.map((c) => c[0])).toEqual(['detect', 'release']);
  });

  it('releases the captured frame even when the step fails', async () => {
    /*
     * The privacy half of the same change. A step that dies at `plan` has still
     * captured a picture of the user's screen; without the finally, that buffer
     * outlives the step in a document whose owner may be gone.
     */
    const h = harness({
      plan: () => ({
        ok: false,
        error: { protocolVersion: 1, error: 'server exploded', retryable: false },
      }),
    });
    await runAgentStep(h.deps, INPUT);
    expect(h.hostCalls.map((c) => c[0])).toContain('release');
  });
});

// ---------------------------------------------------------------------------
// privacy - the reason this project exists
// ---------------------------------------------------------------------------

describe('nothing sensitive reaches the outgoing context', () => {
  it('never sends the card number or the email', async () => {
    const h = harness();
    await runAgentStep(h.deps, INPUT);
    const sent = JSON.stringify(h.sentContexts[0]?.context ?? {});
    expect(sent).not.toContain(CARD);
    expect(sent).not.toContain(EMAIL);
  });

  it('strips the query string from the URL it reports', async () => {
    // The URL routinely carries tokens. sanitizeUrl drops query and fragment.
    const h = harness();
    await runAgentStep(h.deps, INPUT);
    const sent = JSON.stringify(h.sentContexts[0]?.context ?? {});
    expect(sent).not.toContain('secret-token');
  });

  it('sends a context that still describes the page structurally', async () => {
    // Redaction that removed everything would trivially pass the leak tests and
    // be useless. Metric 1 is 25% of the score.
    const h = harness();
    await runAgentStep(h.deps, INPUT);
    const ctx = h.sentContexts[0]?.context;
    expect(ctx?.elements.length ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// the runtime backstop
// ---------------------------------------------------------------------------

describe('the client refuses what the server should not have said', () => {
  it('refuses an action naming an element we never exposed, and does not execute it', async () => {
    /*
     * The whole point of validateAction. Even a fully compromised server cannot
     * name a target we did not send, and the refusal must happen BEFORE
     * execution - a check that runs after is not a check.
     */
    const h = harness({
      plan: () => ({
        ok: true,
        response: {
          protocolVersion: 1,
          raw: JSON.stringify({ type: 'click', ref: 'e999-never-sent' }),
          modelId: 'evil',
          serverMs: 1,
        },
      }),
    });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('validate');
    expect(h.executed).toHaveLength(0);
  });

  it('fails at parse when the server returns something unparseable', async () => {
    const h = harness({
      plan: () => ({
        ok: true,
        response: { protocolVersion: 1, raw: 'I refuse to emit JSON', modelId: 'x', serverMs: 1 },
      }),
    });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('parse');
    expect(h.executed).toHaveLength(0);
  });

  it('refuses a navigate to an origin outside the allowed list', async () => {
    const h = harness({
      plan: () => ({
        ok: true,
        response: {
          protocolVersion: 1,
          raw: JSON.stringify({ type: 'navigate', url: 'https://evil.example/steal' }),
          modelId: 'evil',
          serverMs: 1,
        },
      }),
    });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('validate');
    expect(h.executed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// failure is reported by stage, not swallowed
// ---------------------------------------------------------------------------

describe('a failure names the stage it happened in', () => {
  it('reports a snapshot failure', async () => {
    const h = harness({ snapshotFails: new Error('content script not injected') });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('snapshot');
      expect(result.error).toMatch(/not injected/);
    }
  });

  it('reports a capture failure', async () => {
    const h = harness({ captureFails: new Error('Cannot access contents of the page') });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('capture');
  });

  it('DEGRADES on a detect failure instead of losing the task', async () => {
    /*
     * This test previously asserted that a detect failure ended the step. That
     * was the wrong severity, and it bit for real: with a local LLM holding
     * 3.5 GB of a 6 GB GPU, the extension's WebGPU model - competing for the
     * same device - blew past its timeout, and a working agent run died at
     * step 3 with "infer exceeded 15000 ms".
     *
     * Vision ENHANCES the detection set; `scanDom` produces the rest
     * independently. Every successful run so far reported `vision 0 box(es)`
     * while redaction still applied 15 detections from the DOM. Losing the boxes
     * costs recall on metric 1. Losing the task costs everything.
     */
    const h = harness({ hostFails: new Error('infer exceeded 15000 ms') });
    const result = await runAgentStep(h.deps, INPUT);

    // The step completes.
    expect(result.ok).toBe(true);
    // And it is REPORTED, not swallowed - a run with degraded perception must be
    // visible as such rather than looking like a page with nothing on it.
    const reported = h.events.find(
      (e) => e.type === 'error' && e.scope === 'detect' && /vision unavailable/.test(e.message),
    );
    expect(reported).toBeDefined();
  });

  it('carries on with zero vision detections, and the DOM still redacts', async () => {
    // The other half: degrading must not mean an empty context. The DOM scan is
    // what produces the elements the planner acts on.
    const h = harness({ hostFails: new Error('infer exceeded 15000 ms') });
    const result = await runAgentStep(h.deps, INPUT);
    if (!result.ok) throw new Error('expected the step to survive');
    expect(result.outcome.context.elements.length).toBeGreaterThan(0);
  });

  it('reports a server failure at the plan stage', async () => {
    const h = harness({
      plan: () => ({
        ok: false,
        error: { protocolVersion: 1, error: 'connection refused', retryable: true },
      }),
    });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('plan');
      expect(result.error).toMatch(/connection refused/);
    }
  });

  it('emits an error event carrying the stage as its scope', async () => {
    const h = harness({ captureFails: new Error('boom') });
    await runAgentStep(h.deps, INPUT);
    const err = h.events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.scope).toBe('capture');
  });

  it('still reports latency for the stages that did run', async () => {
    // Uses a SNAPSHOT failure now: a detect failure no longer ends the step, so
    // it is no longer a way to produce one.
    const h = harness({ snapshotFails: new Error('nope') });
    const result = await runAgentStep(h.deps, INPUT);
    if (result.ok) throw new Error('expected failure');
    expect(result.stage).toBe('snapshot');
    expect(result.latency.e2eMs).toBeGreaterThan(0);
  });

  it('surfaces an execution that reported failure without failing the step', async () => {
    // execute() returning ok:false is a page-level miss, not a pipeline error.
    // The step completed; the outcome carries the note.
    const h = harness({ executeOk: false });
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the second round trip
// ---------------------------------------------------------------------------

describe('baking is a separate round trip, and only when asked for', () => {
  it('does not bake when screenshots are disabled', async () => {
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(h.hostCalls.some((c) => c[0] === 'bake')).toBe(false);
  });

  it('bakes against the frame id the worker retained', async () => {
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    const bake = h.hostCalls.find((c) => c[0] === 'bake');
    // Only bakes when the merge actually produced pixel ops; this page does.
    if (bake !== undefined) {
      const payload = bake[1] as { frameId: string; quality: number };
      expect(payload.frameId).toBe('frame-1');
      expect(payload.quality).toBe(80);
      // And it happened after detect, never before.
      expect(h.hostCalls.findIndex((c) => c[0] === 'detect')).toBeLessThan(
        h.hostCalls.findIndex((c) => c[0] === 'bake'),
      );
    }
  });
});

describe('the ref map stays on the client', () => {
  it('hands the content script a DOM path, not just a ref', async () => {
    // `e1` is meaningless in the page. The path is how the content script finds
    // the element - and it is never put in the context, so the server never
    // learns the page's structure.
    const h = harness();
    const result = await runAgentStep(h.deps, INPUT);
    expect(result.ok).toBe(true);
    expect(h.executedPaths).toHaveLength(1);
    expect(h.executedPaths[0]).toBeTruthy();
  });

  it('never sends a DOM path to the server', async () => {
    const h = harness();
    await runAgentStep(h.deps, INPUT);
    const path = h.executedPaths[0] ?? '';
    const sent = JSON.stringify(h.sentContexts[0]?.context ?? {});
    expect(path.length).toBeGreaterThan(0);
    expect(sent).not.toContain(path);
  });

  it('passes null for an action that names no element', async () => {
    const h = harness({
      plan: () => ({
        ok: true,
        response: {
          protocolVersion: 1,
          raw: JSON.stringify({ type: 'scroll', direction: 'down', amountPx: 200 }),
          modelId: 'x',
          serverMs: 1,
        },
      }),
    });
    await runAgentStep(h.deps, INPUT);
    expect(h.executedPaths).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// the screenshot backstop
// ---------------------------------------------------------------------------

describe('an image is never sent showing what the text redaction removed', () => {
  /*
   * THE LEAK THIS CATCHES, observed in a real Chrome run against qwen2.5vl:3b.
   * The panel logged `bake 0 pixel op(s), 58792 bytes` - an image with ZERO
   * redactions applied, sent to a model, while the text beside it had five
   * values stripped. The picture still showed every one of them.
   *
   * The cause was missing geometry: redaction parses HTML from a string, so
   * there is no layout, and `attributeRectProvider` finds `data-test-rect` only
   * on fixtures. Real pages had null rects, so `pixelCoverAll` covered nothing
   * and the bake proceeded anyway.
   *
   * The content script now stamps real rects, so this should not arise. This is
   * the backstop for when it does - because the failure is silent, and the
   * project exists to prevent exactly this.
   */
  const NO_RECTS = `<!doctype html><html><body>
    <input name="cardNumber" value="${CARD}">
    <input name="email" value="${EMAIL}">
    <button id="pay">Pay now</button>
  </body></html>`;

  it('refuses to bake when redactions applied but no pixel op covered them', async () => {
    const h = harness({ html: NO_RECTS });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    // Text redaction still happened...
    expect(result.ok).toBe(true);
    // ...and NO image was produced.
    expect(h.hostCalls.some((c) => c[0] === 'bake')).toBe(false);
    const sent = h.sentContexts[0];
    expect(sent?.context.screenshot ?? null).toBeNull();
  });

  it('says why, rather than dropping the screenshot silently', async () => {
    const h = harness({ html: NO_RECTS });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    const err = h.events.find((e) => e.type === 'error' && e.scope === 'bake');
    expect(err).toBeDefined();
    expect(JSON.stringify(err)).toMatch(/screenshot NOT sent/i);
  });

  it('still bakes when the page has geometry and the ops were produced', async () => {
    // The guard is about missing coverage, not about refusing screenshots.
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(h.hostCalls.some((c) => c[0] === 'bake')).toBe(true);
    expect(h.events.find((e) => e.type === 'error' && e.scope === 'bake')).toBeUndefined();
  });

  it('the step still completes and plans, image or no image', async () => {
    // Refusing costs the model its eyes, not the user their step.
    const h = harness({ html: NO_RECTS });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(result.ok).toBe(true);
    expect(h.sentContexts).toHaveLength(1);
    expect(h.executed.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// a failing bake must not end the task
// ---------------------------------------------------------------------------

const RETAINED_MSG =
  'bake: no retained frame for frameId "frame-1". It was never detected, or it ' +
  'has been evicted (retaining 4).';

describe('the screenshot is expendable; the step is not', () => {
  it('completes text-only when bake rejects', async () => {
    /*
     * THE REAL FAILURE. A four-step run ended with
     * `loop stopped after 4 step(s): error` because bake threw. Everything
     * needed to plan was already in hand - the page was read, the text was
     * redacted, the elements were extracted - and all of it was discarded
     * because the picture could not be made.
     *
     * This file already applies the opposite principle twice (vision degrades
     * rather than aborts; "no image" is the safe direction). It did not apply it
     * to the stage that consumes the degraded one.
     */
    const h = harness({ failCmd: { cmd: 'bake', err: new Error(RETAINED_MSG) } });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    expect(result.ok).toBe(true);
    const err = h.events.find((e) => e.type === 'error' && e.scope === 'bake');
    expect(err).toBeDefined();
    expect(JSON.stringify(err)).toMatch(/continuing text-only/i);
  });

  it('still plans and still executes, with no image attached', async () => {
    const h = harness({ failCmd: { cmd: 'bake', err: new Error(RETAINED_MSG) } });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    expect(h.sentContexts).toHaveLength(1);
    expect(h.sentContexts[0]?.context.screenshot ?? null).toBeNull();
    expect(h.executed).toHaveLength(1);
  });

  it('distinguishes a bake failure from the uncovered-redaction refusal', async () => {
    // Three different reasons an image is missing. One shared message would make
    // the panel unable to say which fired.
    const h = harness({ failCmd: { cmd: 'bake', err: new Error(RETAINED_MSG) } });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    const msgs = h.events
      .filter((e) => e.type === 'error' && e.scope === 'bake')
      .map((e) => JSON.stringify(e));
    expect(msgs.some((m) => /screenshot NOT sent/i.test(m))).toBe(false);
    expect(msgs.some((m) => /continuing text-only/i.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skipping inference must not skip redacting the image
// ---------------------------------------------------------------------------

describe('the breaker-skipped path still retains the frame', () => {
  async function tripBreaker(): Promise<void> {
    // Three consecutive detect failures, exactly as a contended GPU produces.
    for (let i = 0; i < 3; i += 1) {
      const h = harness({ failCmd: { cmd: 'detect', err: new Error('infer exceeded 4000 ms') } });
      await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    }
  }

  it('asks the worker to hold the frame instead of never sending it', async () => {
    /*
     * THE BUG THIS PINS. Retention used to happen ONLY inside `detect`. Once the
     * breaker latched, detect was never called, so the frame never reached the
     * worker - and bake then failed with "no retained frame ... It was never
     * detected", which reads like a page problem and is really the degradation
     * path eating itself. It surfaced on step 4 of a real run.
     */
    await tripBreaker();
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    const cmds = h.hostCalls.map((c) => c[0]);
    expect(cmds).toContain('retain');
    expect(cmds).not.toContain('detect');
  });

  it('produces a screenshot on that path', async () => {
    await tripBreaker();
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    expect(h.hostCalls.map((c) => c[0])).toContain('bake');
    expect(h.sentContexts[0]?.context.screenshot ?? null).not.toBeNull();
  });

  it('does not decode a raw frame in the worker when no screenshot was asked for', async () => {
    // Retained frames are decoded and UNREDACTED. A text-only run has no reason
    // to put one in the worker at all.
    await tripBreaker();
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(h.hostCalls.map((c) => c[0])).not.toContain('retain');
  });

  it('reports, rather than hides, a retain that fails', async () => {
    await tripBreaker();
    const h = harness({ failCmd: { cmd: 'retain', err: new Error('offscreen gone') } });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    expect(result.ok).toBe(true);
    const msgs = h.events
      .filter((e) => e.type === 'error' && e.scope === 'bake')
      .map((e) => JSON.stringify(e));
    expect(msgs.some((m) => /not retained/i.test(m))).toBe(true);
    // And it does NOT then attempt a bake that would fail with a misleading
    // "never detected" message for what is really a retention failure.
    expect(h.hostCalls.map((c) => c[0])).not.toContain('bake');
  });
});

// ---------------------------------------------------------------------------
// "0 pixel op(s)" has two opposite meanings
// ---------------------------------------------------------------------------

describe('an op that could have landed and did not costs the screenshot', () => {
  /*
   * FROM A REAL RUN. Every step logged `bake 0 pixel op(s)` while the text beside
   * it read `redaction 15 applied`. Reproduced exactly: on that page the PII sits
   * BELOW THE FOLD, so all 15 ops fell outside the 1920x1080 captured frame and
   * `applyPixelOps` discarded every one with "rect is empty after clamping".
   *
   * That case is SAFE - a screenshot shows the viewport, the DOM scan reads the
   * whole document, and content that is not in the picture needs no covering.
   * The dangerous case produces an identical line: ops covering VISIBLE PII that
   * failed to land. The frame-relative count is what separates them.
   */
  it('sends the image when every missing op was off-screen', async () => {
    const h = harness({
      bakeResult: { opsApplied: 0, opsRequested: 15, opsOutsideFrame: 15 },
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    expect(result.ok).toBe(true);
    expect(h.sentContexts[0]?.context.screenshot ?? null).not.toBeNull();
    const errs = h.events.filter((e) => e.type === 'error' && e.scope === 'bake');
    expect(errs).toHaveLength(0);
  });

  it('refuses when an op overlapped the frame and did not apply', async () => {
    // 15 requested, 3 off-screen, so 12 should have landed. Only 9 did: three
    // regions of the picture still show what the text redaction removed.
    const h = harness({
      bakeResult: { opsApplied: 9, opsRequested: 15, opsOutsideFrame: 3 },
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });

    expect(result.ok).toBe(true);
    expect(h.sentContexts[0]?.context.screenshot ?? null).toBeNull();
    const errs = h.events
      .filter((e) => e.type === 'error' && e.scope === 'bake')
      .map((e) => JSON.stringify(e));
    expect(errs.some((m) => /NOT sent/i.test(m))).toBe(true);
    expect(errs.some((m) => /12 pixel op\(s\) overlapped/.test(m))).toBe(true);
  });

  it('reports requested and off-screen counts, not just applied', async () => {
    // The panel could not previously distinguish the two cases above, because
    // the only number it received was `opsApplied`.
    const h = harness({
      bakeResult: { opsApplied: 0, opsRequested: 15, opsOutsideFrame: 15 },
    });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    const done = h.events.find((e) => e.type === 'bake/done');
    expect(done).toBeDefined();
    expect(JSON.stringify(done)).toMatch(/"opsRequested":15/);
    expect(JSON.stringify(done)).toMatch(/"opsOutsideFrame":15/);
  });

  it('still sends when everything landed', async () => {
    const h = harness({
      bakeResult: { opsApplied: 12, opsRequested: 12, opsOutsideFrame: 0 },
    });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(h.sentContexts[0]?.context.screenshot ?? null).not.toBeNull();
  });
});

describe('vision is opt-in', () => {
  /*
   * MEASURED, NOT PREFERRED. On a contended GPU every attempt hit
   * `infer exceeded 4000 ms`; steps ran 42-44 s of which ~40 s was waiting for a
   * model that returned ZERO boxes, while the step that skipped vision in the
   * same run took 1.8 s. `yolos-tiny` emits COCO classes and `labelToPiiKind`
   * can use almost none of them, so metrics 1 and 2 are carried by `scanDom`.
   *
   * Default-off, not removed: the architecture requires a local vision model and
   * `bench.ts` exists to pick a better one. This flag is how that comparison
   * gets run.
   */
  it('does not call detect unless asked', async () => {
    const h = harness();
    const { vision: _drop, ...noVision } = INPUT;
    await runAgentStep(h.deps, { ...noVision, screenshot: false });
    expect(h.hostCalls.map((c) => c[0])).not.toContain('detect');
  });

  it('still redacts, because the DOM scan was always doing that work', async () => {
    const h = harness();
    const { vision: _drop, ...noVision } = INPUT;
    const result = await runAgentStep(h.deps, { ...noVision, screenshot: false });

    expect(result.ok).toBe(true);
    // The redaction event carries the log; the outcome carries the action.
    const red = h.events.find((e) => e.type === 'redaction/done');
    expect(red).toBeDefined();
    expect(JSON.stringify(red)).toMatch(/"applied":true/);
  });

  it('still produces a covered screenshot, via retain rather than detect', async () => {
    // The reason this could not land before the `retain` command: with vision
    // off, `detect` never runs, so `retain` is the ONLY path that puts a frame
    // in the worker. Landing the toggle first would have silently disabled
    // every screenshot.
    const h = harness();
    const { vision: _drop, ...noVision } = INPUT;
    await runAgentStep(h.deps, { ...noVision, screenshot: true });

    const cmds = h.hostCalls.map((c) => c[0]);
    expect(cmds).toContain('retain');
    expect(cmds).toContain('bake');
    expect(h.sentContexts[0]?.context.screenshot ?? null).not.toBeNull();
  });

  it('says vision is off rather than reporting a failure that did not happen', async () => {
    const h = harness();
    const { vision: _drop, ...noVision } = INPUT;
    await runAgentStep(h.deps, { ...noVision, screenshot: false });
    const notice = h.events.find((e) => e.type === 'notice' && e.scope === 'detect');
    expect(JSON.stringify(notice)).toMatch(/vision off/i);
    expect(h.events.filter((e) => e.type === 'error' && e.scope === 'detect')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// a refused action is evidence, not a dead task
// ---------------------------------------------------------------------------

describe('validation refuses without ending the task', () => {
  /*
   * THE REGRESSION THIS PINS, from a real run at v0.3.0:
   *
   *   step 2 failed in 1966 ms
   *   loop stopped after 2 step(s): error - validate: refused action:
   *     not-typeable (ref "e39" is not a text field; use click for buttons...)
   *
   * The `not-typeable` check was added so a bad verb would be caught cheaply
   * instead of being discovered in the page 43 seconds later. Then the refusal
   * called `fail()`, which ends the step and stops the loop - so catching the
   * mistake was WORSE than letting it through. The model corrects this mistake
   * readily when told; it never got the chance.
   *
   * A refusal now takes the shape a missed action already had: the step
   * succeeds, `outcome.error` says why, and the loop puts it in history.
   */

  /** Plans a `type` at whatever ref the context says is a button. */
  function typeAtAButton(req: PlanRequest): PlanOutcome {
    const button = req.context.elements.find((e) => e.role === 'button');
    return {
      ok: true,
      response: {
        protocolVersion: 1,
        raw: JSON.stringify({
          type: 'type',
          ref: button?.ref ?? 'e0',
          text: 'Pay now',
          submit: false,
        }),
        modelId: 'fake-vlm',
        serverMs: 5,
      },
    } as PlanOutcome;
  }

  it('reports the refusal as a completed step, not a failure', async () => {
    const h = harness({ plan: typeAtAButton });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome.error).toMatch(/not-typeable/);
  });

  it('does not execute the refused action', async () => {
    // The whole point: it never reaches the page.
    const h = harness({ plan: typeAtAButton });
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(h.executed).toHaveLength(0);
  });

  it('still emits a validate error so the panel can show it', async () => {
    const h = harness({ plan: typeAtAButton });
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    const err = h.events.find((e) => e.type === 'error' && e.scope === 'validate');
    expect(err).toBeDefined();
    expect(JSON.stringify(err)).toMatch(/use click/i);
  });

  it('carries the action, so history can name what was tried', async () => {
    /*
     * Without the action the loop cannot record the attempt, the model cannot
     * see it in history, and it repeats the same refused action forever.
     */
    const h = harness({ plan: typeAtAButton });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.action?.type).toBe('type');
    }
  });
});

describe('the difference between a mistake and an attack', () => {
  /*
   * Both are refusals from the same function, and they must not behave the same
   * way. A model that types at a button has misread our schema and fixes it when
   * told. A server naming a ref we never sent is doing the one thing the runtime
   * backstop exists to stop - and handing it another turn to try again is the
   * opposite of a backstop.
   */
  function plans(raw: object) {
    return (): PlanOutcome =>
      ({
        ok: true,
        response: {
          protocolVersion: 1,
          raw: JSON.stringify(raw),
          modelId: 'x',
          serverMs: 1,
        },
      }) as PlanOutcome;
  }

  it('continues after a schema mistake', async () => {
    const h = harness({
      plan: (req) =>
        plans({
          type: 'type',
          ref: req.context.elements.find((e) => e.role === 'button')?.ref ?? 'e0',
          text: 'x',
          submit: false,
        })(),
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(true);
  });

  it('stops on a ref that was never sent', async () => {
    const h = harness({ plan: plans({ type: 'click', ref: 'e999-never-sent' }) });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('validate');
    expect(h.executed).toHaveLength(0);
  });

  it('stops on an origin outside the grant', async () => {
    const h = harness({
      plan: plans({ type: 'navigate', url: 'https://evil.example/steal' }),
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(false);
    expect(h.executed).toHaveLength(0);
  });

  it('stops on typing into a field holding PII', async () => {
    // Not a schema mistake: the context marked it sensitive, and retrying is not
    // what should happen next.
    const h = harness({
      plan: (req) => {
        const secret = req.context.elements.find((e) => e.isSensitive);
        return plans({
          type: 'type',
          ref: secret?.ref ?? 'e0',
          text: 'x',
          submit: false,
        })();
      },
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    if (result.ok) {
      // Only acceptable if this page exposed no sensitive field to target.
      expect(h.sentContexts[0]?.context.elements.some((e) => e.isSensitive)).toBe(false);
    } else {
      expect(result.stage).toBe('validate');
      expect(h.executed).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// one re-plan, with the refusal in front of the model
// ---------------------------------------------------------------------------

describe('a correctable refusal is fed back once', () => {
  /*
   * MEASURED AGAINST THE REAL MODEL, not assumed.
   *
   * With TYPEABLE rendered and rule 6 rewritten, qwen2.5vl at temperature 0
   * still returned {"type":"type","ref":"e14","text":"Add Laptop Pro to cart"}
   * at a BUTTON - the right element, the wrong verb, three runs running. Handed
   * the same prompt plus a CORRECTION block naming the mistake, it returned
   * {"type":"click","ref":"e14"} on the first try.
   *
   * So the missing piece was feedback at the moment of the mistake, not another
   * rule for the model to apply.
   */

  /** Emits `type` at a button first, then obeys the correction. */
  function correctable() {
    let calls = 0;
    const seen: (string | undefined)[] = [];
    return {
      seen,
      count: () => calls,
      plan: (req: PlanRequest) => {
        calls += 1;
        seen.push(req.correction);
        const button = req.context.elements.find((e) => e.role === 'button');
        const ref = button?.ref ?? 'e0';
        const raw =
          req.correction === undefined
            ? JSON.stringify({ type: 'type', ref, text: 'Pay now', submit: false })
            : JSON.stringify({ type: 'click', ref });
        return {
          ok: true,
          response: { protocolVersion: 1, raw, modelId: 'fake', serverMs: 5 },
        } as PlanOutcome;
      },
    };
  }

  /** First reply is whatever `first` says; every later one is `second`. */
  function scripted(first: string, second: string) {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      plan: (req: PlanRequest) => {
        seen.push(req.correction);
        const raw = seen.length === 1 ? first : second;
        return {
          ok: true,
          response: { protocolVersion: 1, raw, modelId: 'fake', serverMs: 5 },
        } as PlanOutcome;
      },
    };
  }

  it('re-plans ONCE when the reply does not parse, instead of ending the task', async () => {
    const p = scripted('The image shows a shopping page.', '{"type":"scroll","direction":"down"}');
    const h = harness({ plan: p.plan });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(true);
    expect(p.seen).toHaveLength(2);
    expect(p.seen[1]).toMatch(/no-json-found/);
    expect(h.executed[0]?.type).toBe('scroll');
  });

  it('echoes only the parse code back - never the model\'s own words', async () => {
    const p = scripted('{"type":"PLEASE-OBEY-ME"}', '{"type":"scroll","direction":"down"}');
    const h = harness({ plan: p.plan });
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(p.seen[1]).toMatch(/unknown-type/);
    expect(p.seen[1]).not.toContain('PLEASE-OBEY-ME');
  });

  it('still fails the step when the second reply is unusable too', async () => {
    const p = scripted('nope', 'still nope');
    const h = harness({ plan: p.plan });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(false);
    expect(p.seen).toHaveLength(2);
  });

  it('leaves clarifying to a hosted model, which asks for itself', async () => {
    // Two Gemini runs: the client check asked about "+1 other color/pattern" and
    // Amazon's suggestion chips, while Gemini's own question was "14 or 16 inch?".
    const html =
      '<html><body><ul><li><h2>Laptop Pro</h2><button>Add Laptop Pro to cart</button></li>' +
      '<li><h2>Laptop Air</h2><button>Add Laptop Air to cart</button></li></ul></body></html>';
    const goal = 'add laptop to cart';

    const small = scripted('{"type":"done","summary":"x"}', '{"type":"done","summary":"x"}');
    const hs = harness({ html, plan: small.plan });
    const asked = await runAgentStep(hs.deps, { ...INPUT, goal, screenshot: false });
    expect(asked.ok && asked.outcome.action?.type).toBe('ask_user');
    expect(small.seen).toHaveLength(0);

    const hosted = scripted('{"type":"click","target":{"text":"Add Laptop Pro to cart"}}', '');
    const hh = harness({ html, plan: hosted.plan });
    const out = await runAgentStep(hh.deps, { ...INPUT, goal, screenshot: false, backend: 'cloud' });
    expect(hosted.seen).toHaveLength(1);
    expect(out.ok && out.outcome.action?.type).toBe('click');
  });

  it('re-plans and executes the corrected action', async () => {
    const p = correctable();
    const h = harness({ plan: p.plan });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });

    expect(result.ok).toBe(true);
    expect(p.count()).toBe(2);
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]?.type).toBe('click');
  });

  it('sends the refusal detail, and only on the second call', async () => {
    const p = correctable();
    const h = harness({ plan: p.plan });
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });

    expect(p.seen[0]).toBeUndefined();
    expect(p.seen[1]).toMatch(/REJECTED/);
    expect(p.seen[1]).toMatch(/not a text field/);
    expect(p.seen[1]).toMatch(/role button/);
  });

  it('carries no page text into the correction', async () => {
    /*
     * It names a ref, an action type and a ROLE - all of them ours. The
     * element's NAME is page-authored and deliberately absent, because the
     * correction is assembled into the prompt's instruction region.
     */
    const p = correctable();
    const h = harness({ plan: p.plan });
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(p.seen[1]).not.toContain('Pay now');
  });

  it('gives up after one retry rather than looping', async () => {
    // A model that will not take the correction will not take it on the third
    // attempt either, and an unbounded retry hands a hostile server unlimited
    // attempts at the ref allowlist.
    let calls = 0;
    const h = harness({
      plan: (req) => {
        calls += 1;
        const button = req.context.elements.find((e) => e.role === 'button');
        return {
          ok: true,
          response: {
            protocolVersion: 1,
            raw: JSON.stringify({
              type: 'type',
              ref: button?.ref ?? 'e0',
              text: 'x',
              submit: false,
            }),
            modelId: 'stubborn',
            serverMs: 1,
          },
        } as PlanOutcome;
      },
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome.error).toMatch(/not-typeable/);
    expect(h.executed).toHaveLength(0);
  });

  it('does NOT re-plan a security refusal', async () => {
    /*
     * `unknown-ref` is a server naming an element we never exposed. Re-asking a
     * server that just did that is the opposite of a backstop.
     */
    let calls = 0;
    const h = harness({
      plan: () => {
        calls += 1;
        return {
          ok: true,
          response: {
            protocolVersion: 1,
            raw: JSON.stringify({ type: 'click', ref: 'e999-never-sent' }),
            modelId: 'evil',
            serverMs: 1,
          },
        } as PlanOutcome;
      },
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(h.executed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// plan without touching the page
// ---------------------------------------------------------------------------

describe('plan-only runs everything except the click', () => {
  /*
   * FOR TESTING ON REAL SITES. The thing this project most needs to demonstrate
   * is that a logged-in page's real name, address and card on file are stripped
   * before anything leaves the machine - and that is also the situation where a
   * wrong click is least acceptable.
   *
   * So everything runs: capture, vision, redaction, the sanitized context, the
   * server round trip and validation. Only the final interaction is withheld.
   */
  it('does not execute', async () => {
    const h = harness();
    const result = await runAgentStep(h.deps, { ...INPUT, planOnly: true, screenshot: false });
    expect(result.ok).toBe(true);
    expect(h.executed).toHaveLength(0);
  });

  it('still redacts and still plans', async () => {
    // The whole point: the redaction log and the outgoing context are exactly
    // what a real run would produce.
    const h = harness();
    const result = await runAgentStep(h.deps, { ...INPUT, planOnly: true, screenshot: false });
    expect(h.sentContexts).toHaveLength(1);
    expect(h.sentContexts[0]?.context.redactionSummary).toBeDefined();
    if (result.ok) expect(result.outcome.action).not.toBeNull();
  });

  it('says the page was untouched rather than reporting a successful click', async () => {
    const h = harness();
    const result = await runAgentStep(h.deps, { ...INPUT, planOnly: true, screenshot: false });
    const ev = h.events.find((e) => e.type === 'action/executed');
    expect(ev).toBeDefined();
    if (result.ok) expect(result.outcome.error).toBeNull();
  });

  it('executes normally when it is off', async () => {
    const h = harness();
    await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(h.executed).toHaveLength(1);
  });
});

describe('a reply that will not parse says what it was', () => {
  /*
   * A real Amazon run reported `no usable action (688 chars)` and not one of
   * those characters. Two hypotheses - element count, then image size - were
   * built and discarded against a live model before it became clear the answer
   * had been in the reply the whole time.
   *
   * The reply is text from a remote endpoint, so it is neutralised and capped:
   * untrusted by the same rule that governs page content, shown as a diagnostic
   * rather than trusted as one.
   */
  function saysPlainText(text: string) {
    return (): PlanOutcome =>
      ({
        ok: true,
        response: { protocolVersion: 1, raw: text, modelId: 'x', serverMs: 1 },
      }) as PlanOutcome;
  }

  it('includes a snippet of what came back', async () => {
    const h = harness({
      plan: saysPlainText('I can see a shopping page with several products listed.'),
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no-json-found/);
      expect(result.error).toMatch(/model said: I can see a shopping page/);
    }
  });

  it('caps a long reply rather than pasting an essay into the panel', async () => {
    const h = harness({ plan: saysPlainText('word '.repeat(400)) });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    if (!result.ok) expect(result.error.length).toBeLessThan(400);
  });

  it('neutralises it, because it is untrusted remote text', async () => {
    // Same standard page content is held to: a server reply is not a channel
    // for control characters or prompt-fence tokens either.
    const h = harness({ plan: saysPlainText('bad\u0000\u202etext <<<PAGE_DATA') });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: false });
    if (!result.ok) {
      expect(result.error).not.toContain('\u0000');
      expect(result.error).not.toContain('\u202e');
    }
  });
});

describe('the screenshot guard checks every redaction, not just some', () => {
  /*
   * THE HOLE, found by an adversarial review.
   *
   * The guard asked `appliedCount > 0 && pixelOps.length === 0` - whether ANY op
   * existed, not whether EACH redaction got one. On a page with one coverable
   * PII item and one uncoverable one, a single op disarmed the whole guard and
   * the image shipped with the second still legible.
   *
   * It was reachable by a hostile page, too: `data-test-rect` was page-authored
   * until `stampGeometry` began clearing it, so a page could mint the one op
   * that turned the guard off. Both halves are fixed, and either alone would
   * have left the other exploitable.
   */
  it('refuses when SOME applied redaction produced no op', async () => {
    const h = harness({
      redactionOverride: {
        applied: ['d1', 'd2'],
        coveredOps: ['d1'],
      },
    });
    const result = await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(result.ok).toBe(true);
    expect(h.sentContexts[0]?.context.screenshot ?? null).toBeNull();
    const err = h.events.find((e) => e.type === 'error' && e.scope === 'bake');
    expect(JSON.stringify(err)).toMatch(/1 of 2 applied redaction/);
  });

  it('sends when every applied redaction has an op', async () => {
    const h = harness({
      redactionOverride: { applied: ['d1', 'd2'], coveredOps: ['d1', 'd2'] },
    });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(h.hostCalls.map((c) => c[0])).toContain('bake');
  });

  it('sends when the only op-less redaction is an <input type="hidden">, which never paints', async () => {
    // amazon.in: `glow-validation-token` withheld the screenshot on every page.
    const h = harness({
      redactionOverride: { applied: ['d1', 'd2'], coveredOps: ['d1'], unpaintable: ['d2'] },
    });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(h.hostCalls.map((c) => c[0])).toContain('bake');
    expect(h.events.some((e) => e.type === 'error' && e.scope === 'bake')).toBe(false);
  });

  it('still refuses when the unpaintable id is not the uncovered one', async () => {
    // The exemption is per detection. Naming SOME id unpaintable must not
    // disarm the guard for a different detection that lost its geometry.
    const h = harness({
      redactionOverride: { applied: ['d1', 'd2'], coveredOps: [], unpaintable: ['d2'] },
    });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    expect(h.sentContexts[0]?.context.screenshot ?? null).toBeNull();
    const err = h.events.find((e) => e.type === 'error' && e.scope === 'bake');
    expect(JSON.stringify(err)).toMatch(/1 of 2 applied redaction/);
  });

  it('names the kinds left uncovered, never the values', async () => {
    // The panel needs the severity; the value is the thing being protected.
    const h = harness({ redactionOverride: { applied: ['d1'], coveredOps: [] } });
    await runAgentStep(h.deps, { ...INPUT, screenshot: true });
    const err = JSON.stringify(h.events.find((e) => e.type === 'error' && e.scope === 'bake'));
    expect(err).toMatch(/produced no pixel op/);
    expect(err).not.toMatch(/4111|nobody@example/);
  });
});
