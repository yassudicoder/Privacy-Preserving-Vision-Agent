import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAgentServer } from '../../server/agent-http.ts';
import { ScriptedPlanner } from '@/agent-server/server/planner.ts';
import { HttpAgentBackend, PROTOCOL_VERSION } from '@/agent-server/index.ts';
import { ensureDomParser, runPipeline } from '@/harness/index.ts';

/**
 * The server half of the private/cloud deployment: it can require a token, and
 * it must never leak one.
 *
 * Driven end to end against the REAL `HttpAgentBackend` rather than with `fetch`
 * by hand. The point is that the token the extension holds and the token the
 * server expects meet correctly through the actual client - a hand-written
 * request would test this file's idea of the header rather than the client's.
 *
 * The token here is generated in this file. `npm test` needs no API key, no
 * network and no configuration; a suite only the key-holder can run is a suite
 * most people cannot run.
 */

const TOKEN = 'test-only-token-e3a91c47';

let server: Server | null = null;

beforeAll(async () => {
  await ensureDomParser();
});

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
});

async function listen(options: Parameters<typeof createAgentServer>[0]): Promise<string> {
  const s = createAgentServer(options);
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
}

function request() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    context: runPipeline('login-form', { goal: 'sign in' }).context,
    clientVersion: 'test',
  } as const;
}

describe('an agent server that requires a token', () => {
  const CLICK = '{"type":"click","ref":"e1"}';

  it('refuses a request with no token, before reading the body', async () => {
    const origin = await listen({
      planner: new ScriptedPlanner([CLICK]),
      description: 'test',
      authToken: TOKEN,
    });

    const res = await fetch(`${origin}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request()),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok?: boolean; error?: { error?: string } };
    expect(body.ok).toBe(false);
    // The reply must not disclose the expected token, nor any part of it.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('gives the same answer for a missing token and a wrong one', async () => {
    /*
     * Distinguishing them would tell an attacker whether their FORMAT is right,
     * which is the most useful single bit they can be given while guessing.
     */
    const origin = await listen({
      planner: new ScriptedPlanner([CLICK]),
      description: 'test',
      authToken: TOKEN,
    });

    const missing = await fetch(`${origin}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request()),
    });
    const wrong = await fetch(`${origin}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
      body: JSON.stringify(request()),
    });

    expect(missing.status).toBe(wrong.status);
    expect(await missing.text()).toBe(await wrong.text());
  });

  it('accepts the right token through the real client', async () => {
    const origin = await listen({
      planner: new ScriptedPlanner([CLICK]),
      description: 'test',
      authToken: TOKEN,
    });

    const backend = new HttpAgentBackend({
      kind: 'private',
      origin,
      model: 'qwen2.5-vl',
      clientVersion: 'test',
      authToken: () => TOKEN,
    });

    const outcome = await backend.plan(request(), new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.raw).toBe(CLICK);
  });

  it('says a token is REQUIRED on /health, and never what it is', async () => {
    const origin = await listen({
      planner: new ScriptedPlanner([CLICK]),
      description: 'qwen2.5-vl at an internal endpoint (authenticated)',
      authToken: TOKEN,
    });

    const res = await fetch(`${origin}/health`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ ok: true, auth: true });
    expect(text).not.toContain(TOKEN);
  });

  it('leaves /health unauthenticated, deliberately', async () => {
    /*
     * It reveals a planner id and a one-line description and nothing else - no
     * context, no model output, no ability to spend a GPU. Requiring a token to
     * ask "are you alive" would make the UNAVAILABLE case indistinguishable from
     * the MISCONFIGURED one, which is the distinction the probe exists to draw.
     */
    const origin = await listen({
      planner: new ScriptedPlanner([CLICK]),
      description: 'test',
      authToken: TOKEN,
    });
    const res = await fetch(`${origin}/health`);
    expect(res.status).toBe(200);
  });

  it('names authorization in the CORS allow-headers, or the browser never sends it', async () => {
    /*
     * `authorization` is not a CORS-safelisted request header, so a cross-origin
     * POST carrying it triggers a preflight - and a preflight that does not list
     * it FAILS. The extension would see a bare "Failed to fetch" with nothing in
     * the server log, because the POST never arrives. Exactly the silent shape of
     * the private-network-access bug this server already carries a comment about.
     */
    const origin = await listen({ planner: new ScriptedPlanner([CLICK]), description: 'test' });
    const res = await fetch(`${origin}/plan`, { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'authorization',
    );
  });
});

describe('an agent server with no token configured', () => {
  it('accepts an unauthenticated request, which is the loopback default', async () => {
    const origin = await listen({
      planner: new ScriptedPlanner(['{"type":"done","summary":"ok"}']),
      description: 'test',
    });

    const backend = new HttpAgentBackend({
      kind: 'local',
      origin,
      model: 'm',
      clientVersion: 'test',
    });

    const outcome = await backend.plan(request(), new AbortController().signal);
    expect(outcome.ok).toBe(true);
  });

  it('reports auth:false on /health so the panel can say a token is not needed', async () => {
    const origin = await listen({
      planner: new ScriptedPlanner(['{"type":"done","summary":"ok"}']),
      description: 'test',
    });
    const body = (await (await fetch(`${origin}/health`)).json()) as { auth?: boolean };
    expect(body.auth).toBe(false);
  });

  it('ignores a token it was not asked for, rather than rejecting it', async () => {
    // An unauthenticated deployment that 401'd on an unexpected header would be
    // an unnecessary way to fail after somebody switches a server's auth off.
    const origin = await listen({
      planner: new ScriptedPlanner(['{"type":"done","summary":"ok"}']),
      description: 'test',
    });
    const res = await fetch(`${origin}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer whatever' },
      body: JSON.stringify(request()),
    });
    expect(res.status).toBe(200);
  });
});
