// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Action, type CapturedFrame, type PanelEvent, redactionNonce } from '@/contracts/index.ts';
import { createInProcessDomPipeline } from '@/redaction/index.ts';
import { PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { runAgentLoop, resetVisionBreaker } from '@/orchestrator/index.ts';
import type { CaptureAdapter } from '@/perception/index.ts';

/*
 * THE VISION BREAKER IS MODULE-LEVEL STATE.
 *
 * It latches after three consecutive detect failures and, until this hook
 * existed, nothing in the suite ever cleared it - so a tripped breaker leaked
 * from one test into every test after it, and from this file into any file that
 * ran later in the same worker. Those tests would still pass while silently
 * taking the vision-skipped path, asserting nothing about the code they name.
 *
 * `runAgentLoop` now resets the breaker itself at task start, which is what the
 * last describe block in this file pins. The hook stays anyway: it keeps the
 * tests independent of that behaviour, so a regression in the reset shows up as
 * ONE failing test rather than as unrelated tests quietly changing meaning.
 */
beforeEach(() => {
  resetVisionBreaker();
});

/**
 * The loop, and specifically WHEN IT STOPS.
 *
 * The stop conditions are the whole safety story. This runs on a real page on
 * someone's behalf: an unbounded loop driven by a heuristic that cannot tell
 * success from failure is a way to submit a form forty times. Every exit is
 * asserted here, including the ones that should be rare.
 */

const HTML = readFileSync(
  join(process.cwd(), 'src', 'harness', 'fixtures', 'benign-docs.html'),
  'utf8',
);
const VIEWPORT = { cssWidth: 1280, cssHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 };

const capture: CaptureAdapter = {
  capture: (_tabId, viewport): Promise<CapturedFrame> =>
    Promise.resolve({
      frameId: `f${String(Math.floor(viewport.cssWidth))}`,
      dataUrl: 'data:image/jpeg;base64,AA==',
      encodedBytes: 4,
      natural: { width: 1280, height: 800 },
      viewport,
      capturedAt: 1,
    }),
};

const host = {
  kind: 'test' as const,
  isRunning: () => Promise.resolve(true),
  ensureStarted: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  request: <T,>(cmd: string): Promise<T> =>
    Promise.resolve(
      (cmd === 'detect'
        ? {
            frameId: 'f1',
            detections: [],
            backend: 'stub',
            modelId: 't',
            timings: { decodeMs: 0, inferMs: 0, postMs: 0, totalMs: 0 },
          }
        : { ok: true }) as unknown as T,
    ),
};

const INPUT = {
  tabId: 1,
  taskId: 't',
  step: 1,
  goal: 'do the thing',
  url: 'https://fixtures.invalid/benign-docs',
  nonce: redactionNonce('a1b2c3d4'),
  salt: 's',
  allowedOrigins: [],
  captureOptions: { format: 'jpeg' as const, quality: 70, maxEdgePx: 1280 },
  // Vision is off by default now; the breaker tests below are about the vision
  // path, so they ask for it explicitly.
  vision: true,
};

/** A planner that replays a script of raw action strings. */
function scripted(raws: readonly string[]) {
  let i = 0;
  return {
    plan: () => {
      const raw = raws[Math.min(i, raws.length - 1)] ?? '{"type":"done","summary":"end"}';
      i += 1;
      return Promise.resolve({
        ok: true as const,
        response: { protocolVersion: PROTOCOL_VERSION, raw, modelId: 'scripted', serverMs: 0 },
      });
    },
    count: () => i,
  };
}

function deps(
  planner: { plan: (...args: never[]) => Promise<unknown> },
  over: { fingerprints?: string[]; events?: PanelEvent[]; execOk?: boolean } = {},
) {
  let f = 0;
  return {
    snapshot: () => Promise.resolve({ html: HTML, viewport: VIEWPORT }),
    capture,
    host: host as never,
    dom: createInProcessDomPipeline(),
    client: planner as never,
    execute: () => Promise.resolve({ ok: over.execOk ?? true, note: '' }),
    emit: (e: PanelEvent) => over.events?.push(e),
    ...(over.fingerprints === undefined
      ? {}
      : {
          pageFingerprint: (): Promise<string> => {
            const v = over.fingerprints?.[Math.min(f, over.fingerprints.length - 1)] ?? 'x';
            f += 1;
            return Promise.resolve(v);
          },
        }),
  };
}

const FAST = { delayMs: 0 };

describe('stop conditions', () => {
  it('stops on done, and calls that the successful ending', async () => {
    const p = scripted(['{"type":"done","summary":"goal met"}']);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('done');
    expect(out.steps).toBe(1);
  });

  it('stops on abort', async () => {
    const p = scripted(['{"type":"abort","reason":"cannot proceed safely"}']);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('abort');
  });

  it('stops on ask_user, because nothing here can answer', async () => {
    const p = scripted(['{"type":"ask_user","question":"which account?"}']);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('ask_user');
  });

  it('enforces the step ceiling when the planner never finishes', async () => {
    /*
     * ALTERNATING actions on purpose. A planner repeating one action is now
     * caught by `repeating` before the ceiling, so testing the ceiling needs a
     * planner that keeps doing DIFFERENT things without ever finishing.
     */
    const p = scripted([
      '{"type":"scroll","direction":"down"}',
      '{"type":"scroll","direction":"up"}',
      '{"type":"scroll","direction":"down"}',
      '{"type":"scroll","direction":"up"}',
    ]);
    const out = await runAgentLoop(deps(p) as never, INPUT, { ...FAST, maxSteps: 3 });
    expect(out.reason).toBe('max-steps');
    expect(out.steps).toBe(3);
  });

  it('stops when a step fails rather than retrying blindly', async () => {
    const p = scripted(['not json at all']);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('error');
    // The stage is named, which is the most useful thing to report.
    expect(out.error).toMatch(/parse/);
  });

  it('stops when the caller asks, without taking another action first', async () => {
    /*
     * Checked BEFORE the step, so pressing Stop does not buy one more click on
     * the user's page.
     */
    const p = scripted(['{"type":"scroll","direction":"down"}']);
    let calls = 0;
    const out = await runAgentLoop(deps(p) as never, INPUT, {
      ...FAST,
      shouldStop: () => {
        calls += 1;
        return calls > 1;
      },
    });
    expect(out.reason).toBe('cancelled');
    expect(out.steps).toBe(1);
  });

  it('stops when the page stops changing', async () => {
    /*
     * The condition that catches a heuristic re-emitting an action that does
     * nothing. Same fingerprint twice running -> no-progress.
     */
    // Alternating, so `repeating` does not fire first - this is testing the
    // fingerprint detector, which is a different condition.
    const p = scripted([
      '{"type":"scroll","direction":"down"}',
      '{"type":"scroll","direction":"up"}',
      '{"type":"scroll","direction":"down"}',
      '{"type":"scroll","direction":"up"}',
    ]);
    const out = await runAgentLoop(
      deps(p, { fingerprints: ['a', 'same', 'same', 'same'] }) as never,
      INPUT,
      { ...FAST, maxSteps: 8, maxStallSteps: 2 },
    );
    expect(out.reason).toBe('no-progress');
    expect(out.steps).toBeLessThan(8);
  });

  it('keeps going while the page IS changing', async () => {
    // The other half: a changing fingerprint must not trip the stall detector.
    const p = scripted([
      '{"type":"scroll","direction":"down"}',
      '{"type":"scroll","direction":"down"}',
      '{"type":"done","summary":"finished"}',
    ]);
    const out = await runAgentLoop(
      deps(p, { fingerprints: ['a', 'b', 'c', 'd'] }) as never,
      INPUT,
      FAST,
    );
    expect(out.reason).toBe('done');
    expect(out.steps).toBe(3);
  });
});

describe('what the loop tells the panel', () => {
  it('reports each step and the reason it stopped', async () => {
    const events: PanelEvent[] = [];
    const p = scripted(['{"type":"scroll","direction":"down"}']);
    await runAgentLoop(deps(p, { events }) as never, INPUT, { ...FAST, maxSteps: 2 });

    const steps = events.filter((e) => e.type === 'loop/step');
    expect(steps).toHaveLength(2);

    const stopped = events.find((e) => e.type === 'loop/stopped');
    expect(stopped).toBeDefined();
    // "max-steps", not "stopped" - the reason is the part that says whether the
    // task was accomplished.
    expect((stopped as { reason: string }).reason).toBe('max-steps');
  });
});

describe('history', () => {
  it('accumulates across steps so the planner can avoid repeating itself', async () => {
    /*
     * The loop advances history rather than the caller, because the planner's
     * loop-breaker reads it and a caller that forgot to append would silently
     * get an agent that repeats itself.
     */
    const seen: number[] = [];
    const planner = {
      plan: (req: { context: { history: readonly unknown[] } }) => {
        seen.push(req.context.history.length);
        return Promise.resolve({
          ok: true as const,
          response: {
            protocolVersion: PROTOCOL_VERSION,
            raw:
              seen.length >= 3
                ? '{"type":"done","summary":"end"}'
                : '{"type":"scroll","direction":"down"}',
            modelId: 's',
            serverMs: 0,
          },
        });
      },
    };
    await runAgentLoop(deps(planner) as never, INPUT, FAST);
    // 0 on the first step, then one entry per completed step.
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe('the loop drives real actions, not just its own bookkeeping', () => {
  it('passes each planned action to execute', async () => {
    const executed: Action[] = [];
    const p = scripted([
      '{"type":"scroll","direction":"down"}',
      '{"type":"done","summary":"end"}',
    ]);
    const d = {
      ...deps(p),
      execute: (_t: number, action: Action) => {
        executed.push(action);
        return Promise.resolve({ ok: true, note: '' });
      },
    };
    await runAgentLoop(d as never, INPUT, FAST);
    expect(executed.map((a) => a.type)).toEqual(['scroll', 'done']);
  });
});

describe('an agent that repeats itself', () => {
  /*
   * THE CONDITION `no-progress` COULD NOT SEE.
   *
   * Asked to add a product to a cart, qwen2.5:3b clicked the same Add to Cart
   * button on all eight steps. The cart counter went up each time, so the page
   * fingerprint kept CHANGING and the stall detector never fired. It reached 10
   * items and only `max-steps` stopped it. On a real store that is an order.
   */

  it('stops when the same action on the same element repeats', async () => {
    const p = scripted(['{"type":"click","ref":"e1"}']);
    const out = await runAgentLoop(deps(p) as never, INPUT, { ...FAST, maxSteps: 8 });

    expect(out.reason).toBe('repeating');
    // Well before the ceiling, which is the whole point.
    expect(out.steps).toBeLessThan(8);
    expect(out.error).toMatch(/planned .*click.*e1.* times in a row/);
  });

  it('fires even while the page keeps changing', async () => {
    // The distinguishing case. A changing fingerprint must not mask it - that is
    // exactly the shape the cart bug had.
    const p = scripted(['{"type":"click","ref":"e1"}']);
    const out = await runAgentLoop(
      deps(p, { fingerprints: ['a', 'b', 'c', 'd', 'e', 'f'] }) as never,
      INPUT,
      { ...FAST, maxSteps: 8 },
    );
    expect(out.reason).toBe('repeating');
  });

  it('allows one retry, because a click that missed is worth repeating once', async () => {
    const p = scripted([
      '{"type":"click","ref":"e1"}',
      '{"type":"click","ref":"e1"}',
      '{"type":"done","summary":"finished"}',
    ]);
    const out = await runAgentLoop(deps(p) as never, INPUT, { ...FAST, maxRepeats: 3 });
    expect(out.reason).toBe('done');
  });

  it('treats different elements as progress', async () => {
    const p = scripted([
      '{"type":"click","ref":"e1"}',
      '{"type":"click","ref":"e2"}',
      '{"type":"click","ref":"e3"}',
      '{"type":"done","summary":"finished"}',
    ]);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('done');
    expect(out.steps).toBe(4);
  });
});


// ---------------------------------------------------------------------------
// the breaker must have a way back
// ---------------------------------------------------------------------------

describe('a new task gets a fresh look at the environment', () => {
  /** Records which commands reach the host, and fails detect on demand. */
  function countingHost(failDetect: boolean) {
    const cmds: string[] = [];
    return {
      cmds,
      host: {
        kind: 'chrome-offscreen' as const,
        ensureStarted: () => Promise.resolve(),
        isRunning: () => Promise.resolve(true),
        stop: () => Promise.resolve(),
        request: <T,>(cmd: string): Promise<T> => {
          cmds.push(cmd);
          if (cmd === 'detect') {
            if (failDetect) return Promise.reject(new Error('infer exceeded 4000 ms'));
            return Promise.resolve({
              frameId: 'f1',
              detections: [],
              backend: 'stub',
              modelId: 't',
              timings: { decodeMs: 0, inferMs: 0, postMs: 0, totalMs: 0 },
            } as unknown as T);
          }
          return Promise.resolve({ ok: true } as unknown as T);
        },
      },
    };
  }

  function depsWith(planner: { plan: (...a: never[]) => Promise<unknown> }, h: unknown) {
    return {
      snapshot: () => Promise.resolve({ html: HTML, viewport: VIEWPORT }),
      capture,
      host: h as never,
      dom: createInProcessDomPipeline(),
      client: planner as never,
      execute: () => Promise.resolve({ ok: true, note: '' }),
      emit: (): void => {},
    };
  }

  it('clears a latched vision breaker when a task starts', async () => {
    /*
     * THE DEAD EXPORT. `resetVisionBreaker` was exported from the orchestrator,
     * documented in its own comment AND in DECISIONS.md as running on model
     * load, and called from NOWHERE. A repo-wide grep found the definition, the
     * re-export and the two comments - no call sites at all.
     *
     * So the breaker was a one-way latch for the life of the worker. Three
     * timeouts on a contended GPU and every later step silently skipped vision
     * while still reporting ok, which zeroes the vision half of metric 1 (25%)
     * with nothing on any surface saying so. Reloading the extension was the
     * only way back.
     *
     * Model load is the wrong hook regardless: the panel disables the Load model
     * button once a model is loaded, so a test asserting "init clears the
     * breaker" would pass while pinning a path no user can reach.
     */
    const first = countingHost(true);
    // Three failing steps in one run trips the breaker (limit is 3).
    await runAgentLoop(
      depsWith(scripted(['{"type":"click","ref":"e1"}']), first.host) as never,
      INPUT,
      { ...FAST, maxSteps: 3 },
    );
    expect(first.cmds.filter((c) => c === 'detect').length).toBe(3);

    // A NEW task. Vision must be attempted again.
    const second = countingHost(false);
    await runAgentLoop(
      depsWith(scripted(['{"type":"done","summary":"end"}']), second.host) as never,
      INPUT,
      FAST,
    );
    expect(second.cmds).toContain('detect');
  });

  it('does not reset mid-run, so the breaker still saves the cost it exists to save', async () => {
    // The point of the breaker is to stop repaying a timeout that is buying
    // nothing. A reset on every step would make it decorative.
    const h = countingHost(true);
    await runAgentLoop(
      depsWith(scripted(['{"type":"click","ref":"e1"}']), h.host) as never,
      INPUT,
      { ...FAST, maxSteps: 6 },
    );
    // Six steps, but detect attempted only until the limit.
    expect(h.cmds.filter((c) => c === 'detect').length).toBe(3);
  });
});

describe('a task that completes without acting says so', () => {
  /*
   * FROM A REAL AMAZON RUN. Goal "add macbook pro to cart" on a homepage with no
   * MacBook: the model returned `done` on step 1 having touched nothing, and the
   * panel printed "Done."
   *
   * That is the panel asserting something it cannot know, and it is the failure
   * this project keeps meeting - a confident report about something never
   * checked. `done` with zero actions is not necessarily WRONG ("am I signed
   * in?" can be answered by looking), but it is a different outcome and must not
   * read identically.
   */
  it('counts no actions when the first plan is done', async () => {
    const p = scripted(['{"type":"done","summary":"nothing to do"}']);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('done');
    expect(out.actionsTaken).toBe(0);
  });

  it('counts the actions that touched the page', async () => {
    const p = scripted([
      '{"type":"click","ref":"e1"}',
      '{"type":"click","ref":"e1"}',
      '{"type":"done","summary":"finished"}',
    ]);
    const out = await runAgentLoop(deps(p) as never, INPUT, { ...FAST, maxRepeats: 5 });
    expect(out.reason).toBe('done');
    expect(out.actionsTaken).toBe(2);
  });

  it('does not count ask_user as work either', async () => {
    // A question touches nothing. Counting it would let "I asked something" read
    // as "I did something".
    const p = scripted(['{"type":"ask_user","question":"Which one?"}']);
    const out = await runAgentLoop(deps(p) as never, INPUT, FAST);
    expect(out.reason).toBe('ask_user');
    expect(out.actionsTaken).toBe(0);
  });
});

describe('post-action page verification', () => {
  it('says nothing about the first step, which has no baseline', async () => {
    /*
     * The fingerprint is taken AFTER the action, so on step 1 there is no
     * earlier one to compare it with. An earlier version reported step 1 as
     * `changed` - a verification claim about a comparison that never happened,
     * which the receipt then rendered as "the page changed after the action" for
     * step 1 whatever the action did, including nothing.
     */
    const events: PanelEvent[] = [];
    const p = scripted([
      '{"type":"click","ref":"e1"}',
      '{"type":"done","summary":"finished"}',
    ]);
    await runAgentLoop(
      deps(p, { events, fingerprints: ['a', 'b'] }) as never,
      INPUT,
      FAST,
    );

    const verified = events.filter((e) => e.type === 'page/verified');
    expect(verified.map((e) => (e as { step: number }).step)).not.toContain(1);
  });

  it('reports a change once there is something to compare against', async () => {
    const events: PanelEvent[] = [];
    const p = scripted([
      '{"type":"click","ref":"e1"}',
      '{"type":"click","ref":"e2"}',
      '{"type":"done","summary":"finished"}',
    ]);
    await runAgentLoop(
      deps(p, { events, fingerprints: ['a', 'b', 'c'] }) as never,
      INPUT,
      FAST,
    );

    const verified = events.filter((e) => e.type === 'page/verified') as {
      step: number;
      changed: boolean;
    }[];
    expect(verified.length).toBeGreaterThan(0);
    expect(verified[0]?.step).toBe(2);
    expect(verified[0]?.changed).toBe(true);
  });

  it('reports an unchanged page as unchanged, before the stall stops the run', async () => {
    const events: PanelEvent[] = [];
    const p = scripted([
      '{"type":"click","ref":"e1"}',
      '{"type":"click","ref":"e2"}',
      '{"type":"click","ref":"e3"}',
    ]);
    await runAgentLoop(
      deps(p, { events, fingerprints: ['same', 'same', 'same'] }) as never,
      INPUT,
      FAST,
    );

    const verified = events.filter((e) => e.type === 'page/verified') as { changed: boolean }[];
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every((e) => !e.changed)).toBe(true);
  });
});
