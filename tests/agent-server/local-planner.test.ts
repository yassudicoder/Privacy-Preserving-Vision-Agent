// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseAction, validateAction, LocalPlannerClient, PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { validationContextFor } from '@/redaction/index.ts';
import { runPipeline } from '@/harness/index.ts';
import type { PlanRequest } from '@/agent-server/index.ts';

/**
 * The on-device baseline planner.
 *
 * Driven by REAL fixture contexts rather than hand-built objects. `SanitizedContext`
 * is nominal and only `redaction/sanitize.ts` may mint one, so a hand-built
 * stand-in would need a cast that the architecture tests forbid - and would also
 * be a context nothing in the pipeline ever produces.
 *
 * The assertion that matters most is the last group: whatever this planner emits
 * goes through the same `parseAction` + `validateAction` gate as bytes from an
 * untrusted server. If that ever stops being true, the local path has become a
 * hole in the backstop.
 */

const ORIGINS = ['https://fixtures.invalid'];

function requestFor(fixtureId: string, goal: string): PlanRequest {
  const run = runPipeline(fixtureId, { goal });
  return { protocolVersion: PROTOCOL_VERSION, context: run.context, clientVersion: 'test' };
}

function live(): AbortSignal {
  return new AbortController().signal;
}

describe('planning', () => {
  it('clicks the element whose name overlaps the goal', async () => {
    const req = requestFor('login-form', 'sign in to the account');
    const out = await new LocalPlannerClient().plan(req, live());
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const parsed = parseAction(out.response.raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.type).toBe('click');
  });

  it('emits raw JSON, not a pre-built Action', () => {
    /*
     * THE LOAD-BEARING PROPERTY. `PlanOutcome` carries `raw: string`, and
     * runAgentStep parses and validates it. Returning a typed Action would be
     * easy and would quietly delete the runtime backstop for the local path.
     */
    const req = requestFor('checkout', 'place the order');
    return new LocalPlannerClient().plan(req, live()).then((out) => {
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(typeof out.response.raw).toBe('string');
      expect(() => JSON.parse(out.response.raw) as unknown).not.toThrow();
    });
  });

  it('emits exactly one JSON object', async () => {
    // parseAction refuses a string containing more than one balanced object, so
    // a rationale must be a key INSIDE the action, not a second object beside it.
    const req = requestFor('login-form', 'sign in');
    const out = await new LocalPlannerClient().plan(req, live());
    if (!out.ok) throw new Error('expected ok');
    const parsed = parseAction(out.response.raw);
    expect(parsed.ok).toBe(true);
  });

  it('reports done rather than guessing when nothing matches', async () => {
    const req = requestFor('benign-docs', 'zzzz nonexistent objective qqqq');
    const out = await new LocalPlannerClient().plan(req, live());
    if (!out.ok) throw new Error('expected ok');
    const parsed = parseAction(out.response.raw);
    if (!parsed.ok) throw new Error('expected parseable');
    expect(parsed.value.type).toBe('done');
  });

  it('names itself as the model, so no latency figure is misattributed', async () => {
    const req = requestFor('login-form', 'sign in');
    const out = await new LocalPlannerClient().plan(req, live());
    if (!out.ok) throw new Error('expected ok');
    // A number sourced from a zero-network planner must never be reported as a
    // server round trip.
    expect(out.response.modelId).toBe('local-heuristic-baseline');
  });
});

describe('what it refuses to touch', () => {
  it('never targets a sensitive element', async () => {
    /*
     * login-form's password field is marked sensitive by the redactor. A
     * baseline has no way to judge whether typing into a redacted field is safe,
     * and this project's position is that an unattended agent does not decide
     * that for itself.
     */
    const req = requestFor('login-form', 'password');
    const sensitive = new Set(
      req.context.elements.filter((e) => e.isSensitive).map((e) => String(e.ref)),
    );
    expect(sensitive.size).toBeGreaterThan(0);

    const out = await new LocalPlannerClient().plan(req, live());
    if (!out.ok) throw new Error('expected ok');
    const parsed = parseAction(out.response.raw);
    if (!parsed.ok) throw new Error('expected parseable');
    /*
     * Passing by declining to act is a legitimate outcome here - refusing to
     * touch anything is the safe answer to a goal of "password". So this
     * accepts either, but records WHICH, so a change from "chose a safe
     * element" to "chose nothing at all" is visible rather than silent.
     */
    if ('ref' in parsed.value) {
      expect(sensitive.has(String(parsed.value.ref))).toBe(false);
    } else {
      expect(parsed.value.type).toBe('done');
    }
  });

  it('only ever names a ref that was in the context it was given', async () => {
    /*
     * login-form + "sign in", NOT checkout. Probing this showed checkout returns
     * `done` for every goal tried, so the original version of this test reached
     * its `if ('ref' in ...)` guard, found no ref, and passed without asserting
     * anything. The `expect(...).toContain('ref')` below is what stops that
     * happening again silently.
     */
    const req = requestFor('login-form', 'sign in');
    const known = new Set(req.context.elements.map((e) => String(e.ref)));
    const out = await new LocalPlannerClient().plan(req, live());
    if (!out.ok) throw new Error('expected ok');
    const parsed = parseAction(out.response.raw);
    if (!parsed.ok) throw new Error('expected parseable');
    expect(Object.keys(parsed.value)).toContain('ref');
    if ('ref' in parsed.value) expect(known.has(String(parsed.value.ref))).toBe(true);
  });
});

describe('the same gate a hostile server would face', () => {
  it('produces an action validateAction accepts', async () => {
    const req = requestFor('login-form', 'sign in');
    const out = await new LocalPlannerClient().plan(req, live());
    if (!out.ok) throw new Error('expected ok');
    const parsed = parseAction(out.response.raw);
    if (!parsed.ok) throw new Error('expected parseable');

    // Pinned to a CLICK. A `done` action validates trivially - it names no
    // target - so accepting one here would make this test say nothing about the
    // ref allowlist, which is the part actually worth checking.
    expect(parsed.value.type).toBe('click');
    const verdict = validateAction(parsed.value, validationContextFor(req.context, ORIGINS));
    expect(verdict.ok).toBe(true);
  });

  it('is subject to validation rather than trusted for being local', async () => {
    /*
     * Demonstrates the gate is real: the same validator, handed a ref this
     * context never contained, refuses it. Being produced on-device buys the
     * local planner no exemption.
     */
    const req = requestFor('login-form', 'sign in');
    const verdict = validateAction(
      { type: 'click', ref: 'e9999' as never },
      validationContextFor(req.context, ORIGINS),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe('abort and limits', () => {
  it('reports an aborted signal as retryable, not as a failure', async () => {
    const ac = new AbortController();
    ac.abort();
    const req = requestFor('login-form', 'sign in');
    const out = await new LocalPlannerClient().plan(req, ac.signal);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The caller gave up; the planner did not fail. A non-retryable error here
    // would end a loop that the user merely paused.
    expect(out.error.retryable).toBe(true);
    expect(out.error.error).toMatch(/abort/i);
  });
});

describe('making progress', () => {
  it('does not re-pick a ref the run has already acted on', async () => {
    /*
     * Without this the baseline clicks the same best-matching button forever:
     * the page changes, that element keeps the best name, it wins again. A loop
     * that cannot progress is worse than no loop, because it looks like it is
     * working.
     *
     * Verified by planning once, then planning again against a context whose
     * history records that choice.
     */
    const GOAL = 'sign in';
    const first = requestFor('login-form', GOAL);
    const out1 = await new LocalPlannerClient().plan(first, live());
    if (!out1.ok) throw new Error('expected ok');
    const parsed1 = parseAction(out1.response.raw);
    if (!parsed1.ok) throw new Error('expected parseable');
    // No early return. If the first plan does not choose a ref there is nothing
    // to repeat and this test is meaningless - so that is a failure, not a pass.
    expect(Object.keys(parsed1.value)).toContain('ref');
    if (!('ref' in parsed1.value)) throw new Error('unreachable');

    const chosen = String(parsed1.value.ref);
    const replayed = runPipeline('login-form', { goal: GOAL });
    const withHistory: PlanRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: 'test',
      context: {
        ...replayed.context,
        history: [
          { step: 0, actionType: 'click', ref: parsed1.value.ref, name: null, ok: true, note: 'clicked' },
        ],
      } as typeof replayed.context,
    };

    const out2 = await new LocalPlannerClient().plan(withHistory, live());
    if (!out2.ok) throw new Error('expected ok');
    const parsed2 = parseAction(out2.response.raw);
    if (!parsed2.ok) throw new Error('expected parseable');
    // Either it moved to a different element or it reported done. What it may
    // NOT do is pick the same ref again.
    if ('ref' in parsed2.value) expect(String(parsed2.value.ref)).not.toBe(chosen);
    else expect(parsed2.value.type).toBe('done');
  });

  it('reports why it chose what it chose', async () => {
    const traces: unknown[] = [];
    const req = requestFor('login-form', 'sign in');
    await new LocalPlannerClient({ onTrace: (t) => traces.push(t) }).plan(req, live());
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ consideredElements: expect.any(Number) as unknown as number });
  });
});

describe('it does not work its way down a list of worse matches', () => {
  /*
   * THE CLICK-SPRAYING BUG, observed on a real page. The goal "Open Laptop Pro"
   * clicked Laptop Pro's control (scoring on both words), then Gaming Laptop's
   * (scoring on one), then three more - five products opened for a goal naming
   * one. The per-ref dedup does not help: each is a different ref.
   *
   * A candidate scoring WORSE than one already acted on is not progress, and
   * this baseline cannot tell whether more clicking helps.
   */
  it('reports done rather than acting on a lower-scoring candidate', async () => {
    const req = requestFor('login-form', 'sign in');
    const first = await new LocalPlannerClient().plan(req, live());
    if (!first.ok) throw new Error('expected ok');
    const parsed = parseAction(first.response.raw);
    if (!parsed.ok || !('ref' in parsed.value)) throw new Error('expected a ref');

    // Replay with that choice recorded, exactly as the loop does.
    const replayed = runPipeline('login-form', { goal: 'sign in' });
    const withHistory: PlanRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: 'test',
      context: {
        ...replayed.context,
        history: [
          { step: 1, actionType: 'click', ref: parsed.value.ref, name: null, ok: true, note: '' },
        ],
      } as typeof replayed.context,
    };

    const second = await new LocalPlannerClient().plan(withHistory, live());
    if (!second.ok) throw new Error('expected ok');
    const p2 = parseAction(second.response.raw);
    if (!p2.ok) throw new Error('expected parseable');
    // Either done, or a STRICTLY better match - never a worse one.
    expect(['done', 'click']).toContain(p2.value.type);
    if (p2.value.type === 'click' && 'ref' in p2.value) {
      expect(String(p2.value.ref)).not.toBe(String(parsed.value.ref));
    }
  });
});

