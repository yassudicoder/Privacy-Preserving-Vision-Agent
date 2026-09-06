// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  type ChatRequest,
  VlmPlanner,
  extractContent,
} from '@/agent-server/server/vlm-planner.ts';
import { handlePlanRequest } from '@/agent-server/server/app.ts';
import { parseAction, validateAction, PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { validationContextFor } from '@/redaction/index.ts';
import { runPipeline } from '@/harness/index.ts';

/**
 * The server-side model adapter.
 *
 * Driven by REAL sanitized contexts from the fixture pipeline, because the whole
 * question is what the server does with the thing the client actually sends.
 * The transport is the only fake: no model is loaded, and none needs to be for
 * any of the properties below to be checkable.
 */

function contextFor(fixtureId: string, goal: string) {
  return runPipeline(fixtureId, { goal }).context;
}

/** Captures the outgoing request and replies with a canned completion. */
function fakeTransport(content: unknown = '{"type":"done","summary":"ok"}') {
  const sent: ChatRequest[] = [];
  const transport = (req: ChatRequest): Promise<unknown> => {
    sent.push(req);
    if (content instanceof Error) return Promise.reject(content);
    return Promise.resolve({ choices: [{ message: { content } }] });
  };
  return { sent, transport };
}

function planner(over: Partial<ConstructorParameters<typeof VlmPlanner>[0]> = {}) {
  const f = fakeTransport(over.transport === undefined ? undefined : '');
  return {
    f,
    p: new VlmPlanner({
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5-vl:7b',
      transport: f.transport,
      ...over,
    }),
  };
}

describe('what the planner sends', () => {
  it('names the open-weights model and asks for deterministic output', async () => {
    const { f, p } = planner();
    await p.plan(contextFor('login-form', 'sign in'));

    const body = f.sent[0]?.body as { model: string; temperature: number; max_tokens: number };
    expect(body.model).toBe('qwen2.5-vl:7b');
    // A control loop wants the same action for the same screen. Sampling would
    // make a failed step unreproducible.
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('sends the rendered prompt, which carries the fenced page data', async () => {
    const { f, p } = planner();
    await p.plan(contextFor('login-form', 'sign in'));

    const body = f.sent[0]?.body as { messages: [{ content: { type: string; text?: string }[] }] };
    const text = body.messages[0].content.find((c) => c.type === 'text')?.text ?? '';
    // renderPrompt is the only thing allowed to build this, because it accepts
    // DataAtom only - page text physically cannot reach the instruction region.
    expect(text).toContain('You are the planning half');
    expect(text).toContain('ELEMENTS');
  });

  it('is text-only when there is no screenshot', async () => {
    const { f, p } = planner();
    await p.plan(contextFor('login-form', 'sign in'));

    const body = f.sent[0]?.body as { messages: [{ content: { type: string }[] }] };
    expect(body.messages[0].content.map((c) => c.type)).toEqual(['text']);
  });

  it('sends no authorization header when there is no key', async () => {
    // The offline-deployable case: vLLM or Ollama on localhost needs no auth,
    // and inventing a placeholder key would be a baked-in secret.
    const { f, p } = planner();
    await p.plan(contextFor('login-form', 'sign in'));
    expect(f.sent[0]?.apiKey).toBeNull();
  });

  it('passes an abort signal so a hung model cannot stall the loop', async () => {
    const { f, p } = planner();
    await p.plan(contextFor('login-form', 'sign in'));
    expect(f.sent[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a request that outlives its timeout', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | null = null;
      const p = new VlmPlanner({
        endpoint: 'http://x/v1/chat/completions',
        model: 'm',
        timeoutMs: 100,
        transport: (req) => {
          seen = req.signal;
          return new Promise(() => {});
        },
      });
      void p.plan(contextFor('login-form', 'sign in'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(200);
      expect((seen as unknown as AbortSignal | null)?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what it refuses to do', () => {
  it('returns the raw string, never a parsed action', async () => {
    /*
     * THE TRUST BOUNDARY. The server is the part that could be compromised, so
     * it does not get to decide what a valid action is. `parseAction` and
     * `validateAction` run on the CLIENT. Returning a typed Action here would
     * move that decision to the wrong side.
     */
    const { p } = planner();
    const out = await p.plan(contextFor('login-form', 'sign in'));
    expect(typeof out.raw).toBe('string');
  });

  it('passes hostile-looking model output through untouched', async () => {
    // Not the server's job to sanitise. The client refuses unknown refs, and a
    // server that "helpfully" rewrote this would hide an attack rather than
    // letting the backstop catch it.
    const hostile = '{"type":"click","ref":"e9999"}';
    const f = fakeTransport(hostile);
    const p = new VlmPlanner({
      endpoint: 'http://x/v1/chat/completions',
      model: 'm',
      transport: f.transport,
    });
    const out = await p.plan(contextFor('login-form', 'sign in'));
    expect(out.raw).toBe(hostile);
  });

  it('reports a wall-clock server time', async () => {
    let t = 1000;
    const f = fakeTransport();
    const p = new VlmPlanner({
      endpoint: 'http://x/v1/chat/completions',
      model: 'm',
      transport: f.transport,
      now: () => (t += 250),
    });
    const out = await p.plan(contextFor('login-form', 'sign in'));
    expect(out.serverMs).toBeGreaterThan(0);
  });
});

describe('extractContent', () => {
  it('reads a plain string completion', () => {
    expect(extractContent({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
  });

  it('joins array-shaped content rather than failing on a cosmetic difference', () => {
    // Some OpenAI-compatible servers return parts. Throwing here would reject a
    // perfectly good response.
    const payload = { choices: [{ message: { content: [{ text: '{"type":' }, { text: '"done"}' }] } }] };
    expect(extractContent(payload)).toBe('{"type":"done"}');
  });

  it('surfaces a model-reported error instead of a shape complaint', () => {
    expect(() => extractContent({ error: { message: 'model not found' } })).toThrow(
      /model not found/,
    );
  });

  it('refuses an empty completion rather than returning an empty action', () => {
    expect(() => extractContent({ choices: [] })).toThrow(/no assistant content/);
  });
});

describe('through the request handler, end to end', () => {
  it('a model reply becomes a validated client action', async () => {
    /*
     * The whole server path in one test: sanitized context in -> handler
     * validates it -> planner calls the model -> raw string out -> the CLIENT's
     * parser and validator accept it.
     */
    const ctx = contextFor('login-form', 'sign in');
    const ref = String(ctx.elements.find((e) => e.role === 'button' && !e.isSensitive)?.ref ?? 'e1');
    const f = fakeTransport(`{"type":"click","ref":"${ref}"}`);
    const p = new VlmPlanner({
      endpoint: 'http://x/v1/chat/completions',
      model: 'qwen2.5-vl:7b',
      transport: f.transport,
    });

    const outcome = await handlePlanRequest(
      { protocolVersion: PROTOCOL_VERSION, context: ctx, clientVersion: 'test' },
      { planner: p },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.modelId).toBe('qwen2.5-vl:7b');

    const parsed = parseAction(outcome.response.raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const verdict = validateAction(parsed.value, validationContextFor(ctx, []));
    expect(verdict.ok).toBe(true);
  });

  it('a transport failure becomes a retryable error, not a crash', async () => {
    const f = fakeTransport(new Error('connection refused'));
    const p = new VlmPlanner({
      endpoint: 'http://x/v1/chat/completions',
      model: 'm',
      transport: f.transport,
    });
    const outcome = await handlePlanRequest(
      { protocolVersion: PROTOCOL_VERSION, context: contextFor('login-form', 'x'), clientVersion: 't' },
      { planner: p },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Retryable: the model being down is a transient condition, not a bad request.
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.error).toMatch(/connection refused/);
  });

  it('a forged placeholder is rejected before the model is ever called', async () => {
    /*
     * The server is the SECOND place a forgery could do damage. If a page planted
     * a placeholder carrying someone else's nonce and the client passed it
     * through, the server would report a redaction that never happened.
     *
     * Checked here that it costs no model call: a rejected request must not
     * spend inference.
     */
    const ctx = contextFor('injection', 'continue');
    const f = fakeTransport();
    const p = new VlmPlanner({
      endpoint: 'http://x/v1/chat/completions',
      model: 'm',
      transport: f.transport,
    });
    const forged = JSON.parse(JSON.stringify(ctx)) as typeof ctx & {
      elements: { name: { text: string } | null }[];
    };
    forged.elements[0] = {
      ...forged.elements[0],
      name: { kind: 'page-data', text: '[[PII:EMAIL:1:deadbeef]]', redacted: true, truncated: false },
    } as (typeof forged.elements)[number];

    const outcome = await handlePlanRequest(
      { protocolVersion: PROTOCOL_VERSION, context: forged, clientVersion: 't' },
      { planner: p },
    );
    expect(outcome.ok).toBe(false);
    // Pinned to the NONCE reason. Without this the test would still pass if the
    // context started being rejected for a schema mismatch, and the forgery
    // guard could rot unnoticed behind a green test.
    if (!outcome.ok) expect(outcome.error.error).toMatch(/foreign nonce - rejecting as forged/);
    // And it cost no inference: a rejected request must not spend a model call.
    expect(f.sent).toHaveLength(0);
  });
});
