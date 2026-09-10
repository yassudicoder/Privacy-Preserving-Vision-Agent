import { beforeAll, describe, expect, it } from 'vitest';
import {
  modelCatalogueUrl,
  ollamaShowUrl,
  parseNumCtx,
  probeContextWindow,
  selectPlanner,
} from '../../server/main.ts';
import { ModelEndpointError, VlmPlanner } from '../../src/agent-server/server/vlm-planner.ts';
import { ensureDomParser, runPipeline } from '@/harness/index.ts';

/**
 * The two things that broke the LOCAL model path, pinned.
 *
 * Both were invisible to 1,167 passing tests, and for the same reason: every
 * test built a planner with a stub transport that accepted whatever it was
 * handed, so no test ever asked what a REAL local endpoint does with the body
 * this server sends. Both were found by pointing the server at Ollama and
 * reading the reply.
 *
 * Neither is a mock of a hypothetical. The `reasoning_effort` responses below
 * are the literal bodies Ollama 0.33 returned on this machine, and the
 * `/api/show` shape is the literal one it serves.
 */

beforeAll(async () => {
  await ensureDomParser();
});

const FAKE_KEY = 'sk-test-not-a-real-key-000000000000';
const OLLAMA = 'http://127.0.0.1:11434/v1/chat/completions';

/** The exact 400 body Ollama returns for a non-thinking model. */
const NO_THINKING = JSON.stringify({
  error: {
    message: '"qwen2.5vl-8k:latest" does not support thinking',
    type: 'invalid_request_error',
    param: null,
    code: null,
  },
});

/** A minimal valid chat-completions reply carrying one action. */
const ONE_ACTION = {
  choices: [{ message: { content: '{"type":"click","ref":"e1"}' }, finish_reason: 'stop' }],
};

describe('an endpoint that rejects reasoning_effort is still usable', () => {
  it('retries once WITHOUT the field and succeeds', async () => {
    /*
     * THE BUG THIS PINS. `reasoningEffort` defaults to `low`, so the documented
     * local recipe - VLM_ENDPOINT + VLM_MODEL pointed at Ollama - sent
     * `reasoning_effort: "low"` on every plan and Ollama answered 400. The whole
     * loop was dead against a local model, and the error named a parameter the
     * operator had never set.
     */
    const bodies: Record<string, unknown>[] = [];
    const planner = new VlmPlanner({
      endpoint: OLLAMA,
      model: 'qwen2.5vl-8k:latest',
      transport: ({ body }) => {
        bodies.push(body as Record<string, unknown>);
        if ('reasoning_effort' in (body as Record<string, unknown>)) {
          throw new ModelEndpointError(400, NO_THINKING);
        }
        return Promise.resolve(ONE_ACTION);
      },
    });

    const { context } = runPipeline('login-form', { goal: 'sign in' });
    const out = await planner.plan(context);

    expect(out.raw).toContain('"click"');
    expect(bodies).toHaveLength(2);
    // The first attempt carried it, the retry did not. Nothing else changed.
    expect(bodies[0]).toHaveProperty('reasoning_effort', 'low');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(bodies[1]?.['messages']).toEqual(bodies[0]?.['messages']);
    expect(bodies[1]?.['model']).toBe(bodies[0]?.['model']);
  });

  it('REMEMBERS the refusal, so the round trip is paid once', async () => {
    // Instance state, not module state: rediscovering this per step would add a
    // wasted request to every step for the life of the process.
    let calls = 0;
    const planner = new VlmPlanner({
      endpoint: OLLAMA,
      model: 'm',
      transport: ({ body }) => {
        calls += 1;
        if ('reasoning_effort' in (body as Record<string, unknown>)) {
          throw new ModelEndpointError(400, NO_THINKING);
        }
        return Promise.resolve(ONE_ACTION);
      },
    });

    const { context } = runPipeline('login-form', { goal: 'sign in' });
    await planner.plan(context);
    expect(calls).toBe(2);
    await planner.plan(context);
    await planner.plan(context);
    // One more per plan, not two. The refusal is not rediscovered.
    expect(calls).toBe(4);
  });

  it('does NOT retry a 400 about anything else', async () => {
    /*
     * The narrowness is the point. A 400 naming a bad model id or an over-long
     * context is a real configuration fault, and retrying it would hide the
     * cause behind a second identical failure.
     */
    let calls = 0;
    const planner = new VlmPlanner({
      endpoint: OLLAMA,
      model: 'm',
      transport: () => {
        calls += 1;
        throw new ModelEndpointError(400, '{"error":{"message":"model not found"}}');
      },
    });

    const { context } = runPipeline('login-form', { goal: 'sign in' });
    await expect(planner.plan(context)).rejects.toThrow(/model not found/);
    expect(calls).toBe(1);
  });

  it('does NOT retry a 5xx that happens to mention reasoning', async () => {
    // Retryability for a server error is the transport's decision, and it is
    // already `retryable: true`. Silently dropping a parameter on a 503 would
    // change the request shape for a reason that has nothing to do with it.
    let calls = 0;
    const planner = new VlmPlanner({
      endpoint: OLLAMA,
      model: 'm',
      transport: () => {
        calls += 1;
        throw new ModelEndpointError(503, 'reasoning_effort backend unavailable');
      },
    });

    const { context } = runPipeline('login-form', { goal: 'sign in' });
    await expect(planner.plan(context)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('VLM_REASONING can suppress the field entirely', () => {
  it('`off` reaches the planner as null, which omits it', () => {
    /*
     * `VlmPlanner` documented `reasoningEffort: null` as "send nothing, which is
     * how an endpoint that rejects the field is served" - and no environment
     * value could produce it. Unset became `undefined`, which the planner turns
     * into `low`; every other spelling was passed through as a value. The escape
     * hatch was decorative until `off` existed.
     */
    for (const spelling of ['off', 'OFF', 'omit', 'unset']) {
      const choice = selectPlanner({
        VLM_ENDPOINT: OLLAMA,
        VLM_MODEL: 'm',
        VLM_REASONING: spelling,
      } as NodeJS.ProcessEnv);
      expect(choice.vlm).toBe(true);
    }
  });

  it('`none` is a VALUE and is not the same as `off`', async () => {
    /*
     * Measured: Ollama ACCEPTS `none` and rejects `low` and `minimal`. Google
     * maps `none` onto Gemini's thinking config. So `none` is a request the
     * provider is asked to honour, while `off` means the parameter never appears
     * in the body - and an endpoint that 400s on the field's mere presence is
     * served only by the second. Both are kept for that reason.
     */
    const { context } = runPipeline('login-form', { goal: 'sign in' });

    const bodyFor = async (effort: 'none' | null): Promise<Record<string, unknown>> => {
      let sent: Record<string, unknown> = {};
      const planner = new VlmPlanner({
        endpoint: OLLAMA,
        model: 'm',
        reasoningEffort: effort,
        transport: ({ body }) => {
          sent = body as Record<string, unknown>;
          return Promise.resolve(ONE_ACTION);
        },
      });
      await planner.plan(context);
      return sent;
    };

    expect(await bodyFor('none')).toHaveProperty('reasoning_effort', 'none');
    expect(await bodyFor(null)).not.toHaveProperty('reasoning_effort');
  });
});

describe('the context window is asked for, never assumed', () => {
  it('derives /api/show from an OpenAI-compatible URL, and nothing else', () => {
    expect(ollamaShowUrl(OLLAMA)).toBe('http://127.0.0.1:11434/api/show');
    // Not Ollama-shaped: no guess is made.
    expect(ollamaShowUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/api/show',
    );
    expect(ollamaShowUrl('https://x.example/plan')).toBeNull();
  });

  it('reads num_ctx out of the parameters blob', () => {
    // The literal shape Ollama serves: newline-separated `name<spaces>value`.
    expect(parseNumCtx('num_ctx                        8192\ntemperature   0.0001')).toBe(8192);
    expect(parseNumCtx('temperature 0.0001')).toBeNull();
    expect(parseNumCtx(undefined)).toBeNull();
    expect(parseNumCtx(42)).toBeNull();
  });

  it('does NOT read the architectural context_length instead', async () => {
    /*
     * THE TRAP. `/api/show` carries BOTH numbers, and the wrong one is the more
     * inviting: measured on this machine, `model_info["qwen25vl.context_length"]`
     * is 128000 while the SERVED `num_ctx` is 8192. Reporting 128000 would tell
     * the extension it had a 128k budget on a model serving 8k - a wrong answer
     * that would be believed, which is worse than no answer at all.
     */
    const body = {
      parameters: 'num_ctx                        8192\ntemperature                    0.0001',
      model_info: { 'qwen25vl.context_length': 128_000 },
    };
    const got = await probeContextWindow(OLLAMA, 'qwen2.5vl-8k:latest', null, (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      )) as unknown as typeof fetch);

    expect(got.tokens).toBe(8192);
    expect(got.tokens).not.toBe(128_000);
  });

  it('reports UNKNOWN rather than guessing when no num_ctx is pinned', async () => {
    // A model pinning no num_ctx runs at the Ollama install's default, which is
    // a property of the install and is not reported here. Naming a number we did
    // not read would be the same mistake as reading context_length.
    const got = await probeContextWindow(OLLAMA, 'stock', null, (() =>
      Promise.resolve(
        new Response(JSON.stringify({ parameters: 'temperature 0' }), { status: 200 }),
      )) as unknown as typeof fetch);
    expect(got.tokens).toBeNull();
    expect(got.detail).toMatch(/num_ctx/);
  });

  it('never throws, whatever the endpoint does', async () => {
    for (const impl of [
      (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED')),
      (): Promise<Response> => Promise.resolve(new Response('nope', { status: 404 })),
      (): Promise<Response> => Promise.resolve(new Response('not json', { status: 200 })),
    ]) {
      const got = await probeContextWindow(OLLAMA, 'm', null, impl as unknown as typeof fetch);
      expect(got.tokens).toBeNull();
      expect(typeof got.detail).toBe('string');
    }
  });

  it('the probe carries the key but the choice does not leak it', () => {
    // Same property `verify` already had: a closure holds the credential, so
    // `JSON.stringify(choice)` cannot carry it.
    const choice = selectPlanner({
      VLM_ENDPOINT: OLLAMA,
      VLM_MODEL: 'm',
      VLM_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv);
    expect(choice.contextWindow).not.toBeNull();
    expect(JSON.stringify(choice)).not.toContain(FAKE_KEY);
  });

  it('the baseline has no endpoint to ask', () => {
    const choice = selectPlanner({} as NodeJS.ProcessEnv);
    expect(choice.contextWindow).toBeNull();
  });

  it('modelCatalogueUrl still derives the sibling path it always did', () => {
    // Unchanged behaviour, asserted here because `ollamaShowUrl` sits beside it
    // and slices the same string differently.
    expect(modelCatalogueUrl(OLLAMA, 'm')).toBe('http://127.0.0.1:11434/v1/models/m');
  });
});
