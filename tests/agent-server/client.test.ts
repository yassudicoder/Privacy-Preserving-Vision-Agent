// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { HttpAgentClient, PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { runPipeline } from '@/harness/index.ts';

/**
 * The HTTP client, and specifically HOW it calls `fetch`.
 *
 * `this.#fetch = globalThis.fetch` stores the function unbound, so
 * `this.#fetch(...)` invokes it with `this` set to the client. A Window
 * tolerates that. A SERVICE WORKER does not:
 *
 *   Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation
 *
 * So every Chrome step died at the plan stage while Firefox - whose background
 * is an event page, not a worker - ran the identical code and reached the
 * server. Nothing caught it because every test injected `fetchImpl`, which is an
 * ordinary function with no opinion about its receiver, so the real default was
 * never exercised.
 */

function request() {
  const ctx = runPipeline('login-form', { goal: 'sign in' }).context;
  return { protocolVersion: PROTOCOL_VERSION, context: ctx, clientVersion: 'test' };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the default fetch is callable from a service worker', () => {
  it('invokes fetch with the global as its receiver, not the client', async () => {
    /*
     * A stand-in for `WorkerGlobalScope.fetch`, which checks its receiver. This
     * is what the browser does and what no test was doing.
     */
    let receiver: unknown = 'never called';
    const strict = function (this: unknown): Promise<Response> {
      receiver = this;
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            raw: '{"type":"done","summary":"ok"}',
            modelId: 'test',
            serverMs: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    globalThis.fetch = strict as unknown as typeof fetch;

    // NO fetchImpl: this is the path the extension actually takes.
    const client = new HttpAgentClient({
      endpoint: 'http://localhost:8787/plan',
      clientVersion: 'test',
    });

    const out = await client.plan(request(), new AbortController().signal);

    // The receiver must be the global. Anything else is the bug.
    expect(receiver === globalThis || receiver === undefined).toBe(true);
    expect(out.ok).toBe(true);
  });

  it('surfaces an Illegal invocation as a retryable plan error, not a crash', async () => {
    // Even with the binding correct, a transport that throws must not take the
    // step down - it becomes an outcome the loop can report.
    globalThis.fetch = (() => {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
    }) as unknown as typeof fetch;

    const client = new HttpAgentClient({
      endpoint: 'http://localhost:8787/plan',
      clientVersion: 'test',
    });
    const out = await client.plan(request(), new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toMatch(/Illegal invocation/);
  });
});

describe('the client reads what the server actually sends', () => {
  /*
   * THE MISSING SPAN. `handlePlanRequest` was tested, `HttpAgentClient` was
   * tested, and nothing put one's output into the other's input. The server
   * wrapped its reply in a `PlanOutcome` envelope; the client read the fields
   * off the top level. Every field came back undefined, `raw` defaulted to `''`,
   * and the step died at `parseAction` with `empty-input` - AFTER the panel had
   * reported a healthy server round trip.
   *
   * Third time in this project. Same shape each time: one side wraps, the other
   * reads through, no test spans both.
   */

  function respondWith(body: unknown): void {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;
  }

  const ACTION = '{"type":"click","ref":"e2"}';

  it('unwraps the PlanOutcome envelope the real server returns', async () => {
    // Byte-for-byte the shape server/agent-http.ts writes.
    respondWith({
      ok: true,
      response: {
        protocolVersion: PROTOCOL_VERSION,
        raw: ACTION,
        modelId: 'heuristic-baseline',
        serverMs: 0.055,
      },
    });

    const client = new HttpAgentClient({ endpoint: 'http://x/plan', clientVersion: 't' });
    const out = await client.plan(request(), new AbortController().signal);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The assertion whose absence let this ship: raw must be the ACTION, not ''.
    expect(out.response.raw).toBe(ACTION);
    expect(out.response.modelId).toBe('heuristic-baseline');
  });

  it('still accepts a flat body from some other server', async () => {
    respondWith({ protocolVersion: PROTOCOL_VERSION, raw: ACTION, modelId: 'flat', serverMs: 1 });
    const client = new HttpAgentClient({ endpoint: 'http://x/plan', clientVersion: 't' });
    const out = await client.plan(request(), new AbortController().signal);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.response.raw).toBe(ACTION);
  });

  it('surfaces a server refusal instead of reporting an empty success', async () => {
    /*
     * `{ok:false}` arrives with HTTP 200, because a refusal is a protocol
     * outcome rather than a transport fault. Reading through the envelope would
     * turn it into ok:true with raw:'' - a rejected forgery presented as a model
     * that answered with nothing.
     */
    respondWith({
      ok: false,
      error: { protocolVersion: PROTOCOL_VERSION, error: 'foreign nonce', retryable: false },
    });
    const client = new HttpAgentClient({ endpoint: 'http://x/plan', clientVersion: 't' });
    const out = await client.plan(request(), new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toMatch(/foreign nonce/);
    expect(out.error.retryable).toBe(false);
  });
});

describe('an unreachable server says so usefully', () => {
  it('names the endpoint and the remedy instead of "Failed to fetch"', async () => {
    /*
     * "Failed to fetch" is what the browser says for a refused connection, a
     * blocked preflight and a DNS failure alike. It names neither the endpoint
     * nor a next step, and it was the entire error the panel showed while the
     * server simply was not running.
     */
    globalThis.fetch = (() =>
      Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;

    const client = new HttpAgentClient({
      endpoint: 'http://localhost:8787/plan',
      clientVersion: 't',
    });
    const out = await client.plan(request(), new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toContain('http://localhost:8787/plan');
    expect(out.error.error).toMatch(/npm run server/);
    // Retryable: starting the server makes it work, which is the definition.
    expect(out.error.retryable).toBe(true);
  });

  it('passes a specific error through unchanged', async () => {
    // Only the useless generic one is rewritten. A message that already says
    // something must not be replaced by a guess.
    globalThis.fetch = (() =>
      Promise.reject(new Error('certificate has expired'))) as unknown as typeof fetch;
    const client = new HttpAgentClient({ endpoint: 'http://x/plan', clientVersion: 't' });
    const out = await client.plan(request(), new AbortController().signal);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toBe('certificate has expired');
  });
});


describe('a 404 names the likely cause', () => {
  /*
   * A real run pointed the agent at http://localhost:8080 - the test SITE, not
   * the agent server on 8787 - and the panel said `server returned 404`. That
   * reads like the server is broken rather than like it is not an agent server
   * at all. Two ports on one machine and one field between them.
   */
  it('says the origin does not serve /plan', async () => {
    const client = new HttpAgentClient({
      endpoint: 'http://localhost:8080/plan',
      clientVersion: 'test',
      fetchImpl: () =>
        Promise.resolve(new Response('not found', { status: 404 })) as unknown as Promise<Response>,
    });
    const out = await client.plan(request(), new AbortController().signal);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.error).toMatch(/404/);
      expect(out.error.error).toMatch(/does not serve \/plan/);
      // Not retryable: re-sending identical bytes to a server without the route
      // cannot start working.
      expect(out.error.retryable).toBe(false);
    }
  });

  it('leaves other statuses unembellished', async () => {
    const client = new HttpAgentClient({
      endpoint: 'http://localhost:8787/plan',
      clientVersion: 'test',
      fetchImpl: () =>
        Promise.resolve(new Response('boom', { status: 503 })) as unknown as Promise<Response>,
    });
    const out = await client.plan(request(), new AbortController().signal);
    if (!out.ok) {
      expect(out.error.error).toMatch(/503/);
      expect(out.error.error).not.toMatch(/does not serve/);
      expect(out.error.retryable).toBe(true);
    }
  });
});
