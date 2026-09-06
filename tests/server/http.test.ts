// @vitest-environment jsdom
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentServer } from '../../server/agent-http.ts';
import { ScriptedPlanner } from '@/agent-server/server/planner.ts';
import { PROTOCOL_VERSION, parseAction, validateAction } from '@/agent-server/index.ts';
import { validationContextFor } from '@/redaction/index.ts';
import { runPipeline } from '@/harness/index.ts';

/**
 * The server, over real HTTP.
 *
 * `handlePlanRequest` was already tested as a pure function, and that is the
 * part most likely to be right. What was untested is everything AROUND it: body
 * reading, size limits, status mapping, CORS, routing - the wiring that decides
 * whether a correct handler is reachable at all.
 *
 * Binds port 0 so the OS picks a free one; nothing here depends on 8787 being
 * available, which would make the suite fail for a reason unrelated to the code.
 */

const CLICK = '{"type":"click","ref":"REF"}';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createAgentServer({
    planner: new ScriptedPlanner([CLICK]),
    description: 'test',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function contextFor(fixtureId: string, goal: string) {
  return runPipeline(fixtureId, { goal }).context;
}

async function postPlan(body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('the server over real HTTP', () => {
  it('answers /health without claiming a model it does not have', async () => {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { ok: boolean; planner: string; description: string };
    expect(res.status).toBe(200);
    // Names the planner that is actually loaded. "Is a real model wired up" must
    // be answerable without reading startup logs.
    expect(body.planner).toBe('scripted');
  });

  it('turns a real sanitized context into an action the client accepts', async () => {
    /*
     * The full server contract in one test: a context produced by the real
     * redaction pipeline goes over the wire, and what comes back survives the
     * client's own parser and validator - including the ref allowlist.
     */
    const ctx = contextFor('login-form', 'sign in');
    const ref = String(ctx.elements.find((e) => e.role === 'button' && !e.isSensitive)?.ref ?? 'e1');

    const srv = createAgentServer({
      planner: new ScriptedPlanner([CLICK.replace('REF', ref)]),
      description: 'test',
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, context: ctx, clientVersion: 't' }),
      });
      const outcome = (await res.json()) as
        | { ok: true; response: { raw: string; modelId: string } }
        | { ok: false; error: { error: string } };

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const parsed = parseAction(outcome.response.raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.type).toBe('click');
      expect(validateAction(parsed.value, validationContextFor(ctx, [])).ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        srv.close(() => {
          resolve();
        });
      });
    }
  });

  it('returns 200 with ok:false for a refused plan, not an HTTP error', async () => {
    /*
     * A refusal is a protocol outcome, not a transport fault. Mapping it to 4xx
     * would make a rejected forgery indistinguishable from a network problem,
     * and a client retry policy would retry the one thing it must never retry.
     */
    const out = await postPlan({ protocolVersion: 999, context: {}, clientVersion: 't' });
    expect(out.status).toBe(200);
    expect((out.body as { ok: boolean }).ok).toBe(false);
  });

  it('rejects a forged placeholder over the wire', async () => {
    const ctx = contextFor('injection', 'continue');
    const forged = JSON.parse(JSON.stringify(ctx)) as typeof ctx;
    (forged.elements as unknown as { name: unknown }[])[0] = {
      ...forged.elements[0],
      name: { kind: 'page-data', text: '[[PII:EMAIL:1:deadbeef]]', redacted: true, truncated: false },
    };

    const out = await postPlan({
      protocolVersion: PROTOCOL_VERSION,
      context: forged,
      clientVersion: 't',
    });
    const body = out.body as { ok: boolean; error?: { error: string } };
    expect(body.ok).toBe(false);
    // Pinned to the nonce reason: this would still "pass" if the request started
    // being rejected for an unrelated schema complaint.
    expect(body.error?.error).toMatch(/foreign nonce/);
  });

  it('refuses a body over the protocol limit while reading it', async () => {
    // 3 MB against a 2 MB cap. The point is that it is refused, not that it is
    // refused politely.
    const res = await fetch(`${base}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { error: string } };
    expect(body.error.error).toMatch(/exceeds/);
  });

  it('answers the preflight an extension will send', async () => {
    const res = await fetch(`${base}/plan`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('404s anything that is not the plan endpoint', async () => {
    const res = await fetch(`${base}/anything-else`);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed context as NOT retryable', async () => {
    /*
     * Found by POSTing a hand-rolled context at the running server. A context
     * missing `redactionSummary` used to reach the planner and die inside
     * `renderPrompt` with "Cannot read properties of undefined (reading
     * 'byKind')" - reported as RETRYABLE, so a client obeying that would retry a
     * malformed request forever.
     *
     * Every existing test built its context with the real pipeline, so this
     * shape never occurred in the suite.
     */
    const out = await postPlan({
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: 't',
      context: { schemaVersion: 1, elements: [], nonce: 'abcd1234' },
    });
    const body = out.body as { ok: boolean; error: { error: string; retryable: boolean } };
    expect(body.ok).toBe(false);
    expect(body.error.retryable).toBe(false);
    expect(body.error.error).toMatch(/redactionSummary/);
  });
});
