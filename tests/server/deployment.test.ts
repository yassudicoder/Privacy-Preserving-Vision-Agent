import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAgentServer } from '../../server/agent-http.ts';
import { selectPlanner } from '../../server/main.ts';
import { HttpAgentBackend, PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { ensureDomParser, runPipeline } from '@/harness/index.ts';
import { startMockBackend, type MockBackend } from '../support/mock-backend.ts';

/**
 * What a hosted deployment needs to be true, asserted without deploying.
 *
 * The service that runs on Render is the SAME `server/main.ts` that runs on a
 * laptop - there is no production variant - so everything here is testable in
 * process. What cannot be tested here is Render itself; that is stated in the
 * report rather than implied by a green suite.
 *
 * NO REAL CREDENTIAL APPEARS IN THIS FILE and none is needed. `selectPlanner` is
 * a pure function of an env object, so the OpenAI path is exercised by passing a
 * fake key and asserting the CHOICE, never by calling OpenAI.
 */

const FAKE_KEY = 'sk-test-not-a-real-key-000000000000';

beforeAll(async () => {
  await ensureDomParser();
});

let server: Server | null = null;
const started: MockBackend[] = [];

afterEach(async () => {
  const s = server;
  server = null;
  if (s !== null) {
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  }
  await Promise.all(started.splice(0).map((m) => m.close()));
});

async function listen(options: Parameters<typeof createAgentServer>[0]): Promise<string> {
  const s = createAgentServer(options);
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
}

// --- planner selection -------------------------------------------------------

describe('selectPlanner reads the environment a deployment actually sets', () => {
  it('uses OpenAI when only OPENAI_API_KEY is present', () => {
    /*
     * The whole point of the alias: a Render deployment sets ONE variable. With
     * only `VLM_ENDPOINT`/`VLM_MODEL` accepted, forgetting either silently
     * produced the heuristic baseline - a server that answers, returns valid
     * actions, and never touched a model.
     */
    const choice = selectPlanner({ OPENAI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(choice.vlm).toBe(true);
    expect(choice.model).toBe('gpt-5.6-luna');
    expect(choice.description).toContain('api.openai.com');
  });

  it('honours VLM_MODEL over the default', () => {
    const choice = selectPlanner({
      OPENAI_API_KEY: FAKE_KEY,
      VLM_MODEL: 'gpt-4o',
    } as NodeJS.ProcessEnv);
    expect(choice.model).toBe('gpt-4o');
  });

  it('lets an explicit endpoint win over the OpenAI convenience path', () => {
    // Somebody with their own vLLM box and an OpenAI key in their shell has said
    // which one they mean by setting the endpoint.
    const choice = selectPlanner({
      OPENAI_API_KEY: FAKE_KEY,
      VLM_ENDPOINT: 'http://192.168.1.20:8000/v1/chat/completions',
      VLM_MODEL: 'qwen2.5-vl',
    } as NodeJS.ProcessEnv);
    expect(choice.model).toBe('qwen2.5-vl');
    expect(choice.description).toContain('192.168.1.20');
    expect(choice.description).not.toContain('openai.com');
  });

  it('accepts VLM_API_KEY and OPENAI_API_KEY as the same field', () => {
    const a = selectPlanner({
      VLM_ENDPOINT: 'https://x.example/v1/chat/completions',
      VLM_MODEL: 'm',
      VLM_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv);
    const b = selectPlanner({
      VLM_ENDPOINT: 'https://x.example/v1/chat/completions',
      VLM_MODEL: 'm',
      OPENAI_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv);
    expect(a.description).toBe(b.description);
    expect(a.description).toContain('(authenticated)');
  });

  it('falls back to the baseline with nothing set, and SAYS so', () => {
    const choice = selectPlanner({} as NodeJS.ProcessEnv);
    expect(choice.vlm).toBe(false);
    expect(choice.model).toBeNull();
    expect(choice.description).toMatch(/no model/i);
    // Names the variable to set. A deployment that quietly runs the baseline is
    // the most likely first-run mistake and the least visible one.
    expect(choice.description).toContain('OPENAI_API_KEY');
  });

  it('treats an empty or whitespace value as unset', () => {
    // Render writes an empty string for a variable added and left blank, which
    // would otherwise construct a VlmPlanner with a key of ''.
    for (const value of ['', '   ']) {
      expect(selectPlanner({ OPENAI_API_KEY: value } as NodeJS.ProcessEnv).vlm).toBe(false);
    }
  });

  it('NEVER puts the key in the description', () => {
    /*
     * `description` goes to the startup log AND to /health, which is
     * unauthenticated. This is the single most important assertion in the file.
     */
    for (const env of [
      { OPENAI_API_KEY: FAKE_KEY },
      { VLM_ENDPOINT: 'https://x.example/v1', VLM_MODEL: 'm', VLM_API_KEY: FAKE_KEY },
    ]) {
      const choice = selectPlanner(env as NodeJS.ProcessEnv);
      expect(choice.description).not.toContain(FAKE_KEY);
      expect(choice.description).not.toContain('sk-');
      expect(JSON.stringify(choice)).not.toContain(FAKE_KEY);
    }
  });
});

// --- /health -----------------------------------------------------------------

describe('/health answers what a deployment needs to verify', () => {
  it('reports server, model and auth without any secret', async () => {
    const choice = selectPlanner({
      OPENAI_API_KEY: FAKE_KEY,
      VLM_MODEL: 'gpt-5.6-luna',
    } as NodeJS.ProcessEnv);
    const origin = await listen({
      planner: choice.planner,
      description: choice.description,
      authToken: 'deployment-token',
      vlm: choice.vlm,
      model: choice.model,
    });

    const res = await fetch(`${origin}/health`);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['server']).toBe('ok');
    expect(body['vlm']).toEqual({ configured: true, model: 'gpt-5.6-luna', verified: null });
    expect(body['auth']).toBe(true);
    expect(typeof body['uptimeMs']).toBe('number');

    // THE ASSERTION THAT MATTERS: /health is unauthenticated and public.
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('sk-');
    expect(text).not.toContain('deployment-token');
  });

  it('says configured:false when no model is wired up', async () => {
    /*
     * The most likely first-run mistake on a fresh deployment, and the least
     * visible: the server answers, returns valid actions, and none of them came
     * from a model. One request must be able to tell.
     */
    const choice = selectPlanner({} as NodeJS.ProcessEnv);
    const origin = await listen({
      planner: choice.planner,
      description: choice.description,
      vlm: choice.vlm,
      model: choice.model,
    });
    const body = (await (await fetch(`${origin}/health`)).json()) as Record<string, unknown>;
    expect(body['vlm']).toEqual({ configured: false, model: null, verified: null });
    expect(body['auth']).toBe(false);
  });
});

// --- the extension side ------------------------------------------------------

describe('the extension against a hosted server', () => {
  it('plans through the real client with the deployment token', async () => {
    const { ScriptedPlanner } = await import('@/agent-server/server/planner.ts');
    const origin = await listen({
      planner: new ScriptedPlanner(['{"type":"click","ref":"e1"}']),
      description: 'test',
      authToken: 'deployment-token',
      vlm: true,
      model: 'gpt-5.6-luna',
    });

    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin,
      model: 'gpt-5.6-luna',
      clientVersion: 'test',
      authToken: () => 'deployment-token',
    });

    const context = runPipeline('login-form', { goal: 'sign in' }).context;
    const outcome = await backend.plan(
      { protocolVersion: PROTOCOL_VERSION, context, clientVersion: 'test' },
      new AbortController().signal,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.raw).toBe('{"type":"click","ref":"e1"}');
  });

  it('reports a sleeping server as WAKING, not as unreachable', async () => {
    /*
     * A free instance that has slept accepts the connection and answers nothing
     * until it has woken; a dead one refuses immediately. Both fail a probe, and
     * reporting them identically tells the user their server is down at the exact
     * moment it is coming up - so the first request of the day looks like a
     * broken deployment.
     *
     * Modelled with a listener that never answers, and a 1 ms client timeout.
     */
    const { createServer } = await import('node:http');
    const silent = createServer(() => {
      // Accept and hold. This is what a cold instance looks like from outside.
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;

    try {
      const backend = new HttpAgentBackend({
        kind: 'cloud',
        origin: `http://127.0.0.1:${String(port)}`,
        model: 'gpt-5.6-luna',
        clientVersion: 'test',
      });
      const health = await backend.health(AbortSignal.timeout(1200));

      expect(health.reachable).toBe(false);
      expect(health.waking).toBe(true);
      expect(health.error).toMatch(/waking|answer in time/i);
    } finally {
      await new Promise<void>((resolve) => {
        silent.close(() => {
          resolve();
        });
      });
    }
  });

  it('reports a refused connection as NOT waking', async () => {
    // Nothing is listening. That is a different fact and must read differently -
    // "connecting..." for a dead host promises a wait that will not end.
    const dead = await startMockBackend();
    const origin = dead.origin;
    await dead.close();

    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin,
      model: 'm',
      clientVersion: 'test',
    });
    const health = await backend.health(new AbortController().signal);

    expect(health.reachable).toBe(false);
    expect(health.waking).toBe(false);
    expect(health.error).toMatch(/could not reach/i);
  });
});

// --- upstream errors ---------------------------------------------------------

describe('an error from the model provider', () => {
  it('masks anything credential-shaped before it reaches the extension', async () => {
    /*
     * The provider's raw body is forwarded to the CLIENT and rendered there. A
     * live probe against OpenAI with a bad key came back with
     * `Incorrect API key provided: sk-fake-****...0000` - masked, but by
     * OpenAI's courtesy, not by anything we control. This server is meant to
     * work against any OpenAI-compatible endpoint, and the one that echoes the
     * Authorization header back in a 400 exists.
     */
    const { maskCredentials } = await import('@/agent-server/server/vlm-planner.ts');

    const leaky = [
      'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'bad header: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      '{"api_key":"abcdefghijklmnopqrst"}',
    ].join(' | ');

    const masked = maskCredentials(leaky);
    expect(masked).not.toContain('sk-proj-abcdefghij');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(masked).not.toContain('abcdefghijklmnopqrst');
    // The useful part survives: a 400 naming a bad model id is what turns a
    // five-second fix into a hunt.
    expect(masked).toContain('Incorrect API key provided');
  });

  it('marks a 4xx from the model endpoint NON-retryable', async () => {
    /*
     * Every exception used to become `retryable: true`, so an invalid API key
     * was retried once per step until the loop hit its ceiling - eight requests,
     * eight identical failures, and a stop reason that blamed the page.
     */
    const { ModelEndpointError } = await import('@/agent-server/server/vlm-planner.ts');
    expect(new ModelEndpointError(401, 'unauthorized').retryable).toBe(false);
    expect(new ModelEndpointError(400, 'bad model').retryable).toBe(false);
    // A 5xx or a rate limit genuinely may succeed on another attempt.
    expect(new ModelEndpointError(503, 'overloaded').retryable).toBe(true);
    expect(new ModelEndpointError(429, 'slow down').retryable).toBe(true);
  });

  it('reaches the client as a refusal, not as a crash', async () => {
    const { VlmPlanner } = await import('@/agent-server/server/vlm-planner.ts');
    const { ModelEndpointError } = await import('@/agent-server/server/vlm-planner.ts');

    const origin = await listen({
      planner: new VlmPlanner({
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-5.6-luna',
        apiKey: FAKE_KEY,
        // No network: the transport throws exactly what a bad key produces.
        transport: () => {
          throw new ModelEndpointError(401, 'Incorrect API key provided: sk-***');
        },
      }),
      description: 'test',
      vlm: true,
      model: 'gpt-5.6-luna',
    });

    const context = runPipeline('login-form', { goal: 'sign in' }).context;
    const res = await fetch(`${origin}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, context, clientVersion: 't' }),
    });
    const body = (await res.json()) as { ok: boolean; error?: { retryable?: boolean } };

    // 200 with ok:false - a protocol outcome the client understands. Mapping it
    // onto an HTTP error would make it indistinguishable from a transport fault.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error?.retryable).toBe(false);
  });
});
