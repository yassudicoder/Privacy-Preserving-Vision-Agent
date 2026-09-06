/*
 * NODE ENVIRONMENT, NOT JSDOM, and that is load-bearing.
 *
 * These tests drive a real `fetch` at a real listener. Under jsdom the
 * `AbortController` comes from jsdom while `fetch` comes from undici, and undici
 * rejects the foreign signal outright:
 *
 *   RequestInit: Expected signal ("AbortSignal {}") to be an instance of AbortSignal
 *
 * Every request then fails as a TRANSPORT error - which is exactly the failure
 * mode this file is trying to distinguish from a real one, so the suite would
 * have been green on the wrong evidence. `ensureDomParser()` supplies the one
 * DOM API `runPipeline` needs, and everything else stays Node's.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type BackendKind,
  type DeploymentConfig,
  type SanitizedContext,
  alternativesTo,
  backendLabel,
  defaultDeployment,
  describeBackend,
  isBackendKind,
  isOffDevice,
} from '@/contracts/index.ts';
import {
  HttpAgentBackend,
  OnDeviceBackend,
  PROTOCOL_VERSION,
  createAgentBackend,
  deriveBackendOrigin,
} from '@/agent-server/index.ts';
import { ensureDomParser, runPipeline } from '@/harness/index.ts';
import { startMockBackend, type MockBackend } from '../support/mock-backend.ts';

/**
 * ONE EXTENSION, THREE DEPLOYMENTS, ONE BOUNDARY.
 *
 * The claim this file has to earn is not "the cloud backend works". It is that
 * local, private and cloud are indistinguishable from the payload's point of
 * view - same body, same gate, same validation - so that the sentence "privacy
 * enforcement always remains on the user's device" is a property of the code
 * rather than a slogan on a slide.
 *
 * Every off-device test runs against a REAL listener on a real socket, not an
 * injected `fetch`. A stub sees the object the client passed; only a listener
 * sees the bytes that `JSON.stringify` and the HTTP layer actually produced, and
 * every leak this project fears is a leak of bytes.
 */

beforeAll(async () => {
  await ensureDomParser();
});

const started: MockBackend[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

async function mock(...args: Parameters<typeof startMockBackend>): Promise<MockBackend> {
  const backend = await startMockBackend(...args);
  started.push(backend);
  return backend;
}

function context(goal = 'sign in'): SanitizedContext {
  return runPipeline('login-form', { goal }).context;
}

function request(ctx: SanitizedContext) {
  return { protocolVersion: PROTOCOL_VERSION, context: ctx, clientVersion: 'test' } as const;
}

function configFor(kind: BackendKind, origin: string, model = 'qwen2.5-vl'): DeploymentConfig {
  const base = defaultDeployment();
  if (!isOffDevice(kind)) return { ...base, backend: kind };
  return { ...base, backend: kind, [kind]: { endpoint: origin, model } };
}

// --- A / B / C: each deployment plans from a SanitizedContext ---------------

describe('every deployment plans from a SanitizedContext and returns one action', () => {
  const CLICK = '{"type":"click","ref":"e1"}';

  it('A. local: SanitizedContext -> loopback agent server -> action', async () => {
    const server = await mock({ script: [CLICK] });
    const backend = createAgentBackend(configFor('local', server.origin), {
      clientVersion: 'test',
    });

    const outcome = await backend.plan(request(context()), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.raw).toBe(CLICK);
    expect(backend.descriptor.kind).toBe('local');
    expect(backend.descriptor.offDevice).toBe(true);
  });

  it('B. private: the identical flow over the identical client', async () => {
    const server = await mock({ script: [CLICK] });
    /*
     * `private` normally REFUSES a loopback origin - see the TLS test below - so
     * this constructs the backend directly rather than through the factory. The
     * point being tested is that the private path is the same code, and a test
     * that could only run over real TLS could not test that at all.
     */
    const backend = new HttpAgentBackend({
      kind: 'private',
      origin: server.origin,
      model: 'qwen2.5-vl',
      clientVersion: 'test',
    });

    const outcome = await backend.plan(request(context()), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(backend.descriptor.kind).toBe('private');
  });

  it('C. cloud: the identical flow, plus a bearer token', async () => {
    const server = await mock({ script: [CLICK], authToken: 'test-token-value' });
    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin: server.origin,
      model: 'hosted-vlm',
      clientVersion: 'test',
      authToken: () => 'test-token-value',
    });

    const outcome = await backend.plan(request(context()), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(backend.descriptor.authenticated).toBe(true);
  });

  it('sends a BYTE-IDENTICAL body from all three', async () => {
    /*
     * THE CENTRAL ASSERTION OF THIS WHOLE FEATURE.
     *
     * If the three bodies differ, then something about the payload depends on
     * where it is going - and the moment that is true, "the privacy boundary
     * does not move with the backend" stops being verifiable by inspection. The
     * bodies are compared as STRINGS, after a real serialisation and a real
     * socket, because that is the artefact that either does or does not contain
     * somebody's email address.
     *
     * `clientVersion` is held constant deliberately: the client overwrites it,
     * so a difference there would be a difference this test should catch.
     */
    const ctx = context('sign in');
    const bodies: string[] = [];

    for (const kind of ['local', 'private', 'cloud'] as const) {
      const server = await mock({ script: [CLICK] });
      const backend = new HttpAgentBackend({
        kind,
        origin: server.origin,
        model: 'same-model',
        clientVersion: 'test',
        ...(kind === 'cloud' ? { authToken: (): string => 'secret-token' } : {}),
      });
      await backend.plan(request(ctx), new AbortController().signal);
      bodies.push(server.bodyText());
    }

    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
    // And the token, present on exactly one of the three, is in none of them.
    for (const body of bodies) expect(body).not.toContain('secret-token');
  });

  it('on-device plans without any server at all', async () => {
    const backend = new OnDeviceBackend();
    const outcome = await backend.plan(request(context()), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(backend.descriptor.offDevice).toBe(false);
    expect(backend.descriptor.endpoint).toBeNull();
    if (!outcome.ok) return;
    /*
     * A RAW STRING, like every other backend. The local planner deliberately
     * does not return a typed Action: doing so would move parsing and the ref
     * allowlist to the wrong side of the trust boundary for exactly one of the
     * four deployments.
     */
    expect(typeof outcome.response.raw).toBe('string');
  });
});

// --- The token never leaves the header --------------------------------------

describe('an access token stays in the header and out of everything else', () => {
  it('travels as an authorization header, never in the body', async () => {
    const server = await mock({ script: ['{"type":"done","summary":"ok"}'] });
    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin: server.origin,
      model: 'hosted',
      clientVersion: 'test',
      authToken: () => 'sk-not-a-real-key-0123456789',
    });

    await backend.plan(request(context()), new AbortController().signal);

    const plan = server.requests.find((r) => r.url === '/plan');
    expect(plan?.headers['authorization']).toBe('Bearer sk-not-a-real-key-0123456789');
    expect(plan?.rawBody).not.toContain('sk-not-a-real-key');
  });

  it('is absent from the descriptor, which is what gets rendered and stored', async () => {
    const server = await mock();
    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin: server.origin,
      model: 'hosted',
      clientVersion: 'test',
      authToken: () => 'sk-not-a-real-key-0123456789',
    });

    // Serialised, because the descriptor is persisted and broadcast as JSON and
    // a nested field would escape a property-by-property check.
    const asJson = JSON.stringify(backend.descriptor);
    expect(asJson).not.toContain('sk-not-a-real-key');
    expect(backend.descriptor.authenticated).toBe(true);
  });

  it('is read at request time, so clearing it takes effect on the next step', async () => {
    const server = await mock({ script: ['{"type":"done","summary":"1"}', '{"type":"done","summary":"2"}'] });
    let token: string | null = 'first-token';
    const backend = new HttpAgentBackend({
      kind: 'private',
      origin: server.origin,
      model: 'm',
      clientVersion: 'test',
      authToken: () => token,
    });

    await backend.plan(request(context()), new AbortController().signal);
    token = null;
    await backend.plan(request(context()), new AbortController().signal);

    const plans = server.requests.filter((r) => r.url === '/plan');
    expect(plans[0]?.headers['authorization']).toBe('Bearer first-token');
    expect(plans[1]?.headers['authorization']).toBeUndefined();
  });
});

// --- G: failure never becomes a different backend ---------------------------

describe('G. an unavailable backend does not become another one', () => {
  it('reports a transport failure and plans nothing', async () => {
    /*
     * Bound and immediately closed, so the port is almost certainly refusing.
     * A refused connection is the honest shape of "the private server is down".
     */
    const dead = await startMockBackend();
    const origin = dead.origin;
    await dead.close();

    const backend = new HttpAgentBackend({
      kind: 'private',
      origin,
      model: 'qwen2.5-vl',
      clientVersion: 'test',
      timeoutMs: 2000,
    });

    const outcome = await backend.plan(request(context()), new AbortController().signal);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // `transport` is what the panel keys the "unavailable" prompt on. If this
    // were `protocol`, the prompt would never appear.
    expect(outcome.error.kind).toBe('transport');
  });

  it('classifies 401 as protocol, NOT as unavailable', async () => {
    /*
     * The distinction that decides whether somebody is offered a switch to a
     * cloud provider. A 401 means the server is UP and refused us; "private
     * server unavailable, use cloud instead?" would be a wrong diagnosis
     * attached to a data-sharing decision.
     */
    const server = await mock({ authToken: 'the-right-token' });
    const backend = new HttpAgentBackend({
      kind: 'private',
      origin: server.origin,
      model: 'm',
      clientVersion: 'test',
      authToken: () => 'the-wrong-token',
    });

    const outcome = await backend.plan(request(context()), new AbortController().signal);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('protocol');
    expect(outcome.error.error).toContain('rejected the access token');
  });

  it('classifies 5xx as transport, because that IS the backend being unwell', async () => {
    const server = await mock({ failWith: 503 });
    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin: server.origin,
      model: 'm',
      clientVersion: 'test',
    });

    const outcome = await backend.plan(request(context()), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('transport');
  });

  it('offers alternatives without taking one', () => {
    const config: DeploymentConfig = {
      backend: 'private',
      local: { endpoint: 'http://localhost:8787', model: '' },
      private: { endpoint: 'https://ai.example.com', model: '' },
      cloud: { endpoint: '', model: '' },
    };

    const options = alternativesTo(config, 'private');

    // on-device always, local because it is configured, cloud NOT because it is
    // not - offering a switch to an unconfigured backend offers a second failure.
    expect(options).toEqual(['on-device', 'local']);
    // And the selection is untouched. `alternativesTo` is a pure read.
    expect(config.backend).toBe('private');
  });
});

// --- H: switching ------------------------------------------------------------

describe('H. switching between backends', () => {
  /*
   * A NOTE ON WHY THESE MOVE BETWEEN LOOPBACK ENDPOINTS.
   *
   * `private` and `cloud` refuse a non-https origin by design, so neither can be
   * pointed at a plaintext mock through `createAgentBackend` - which is the
   * policy working, and it is asserted directly further down. Switching itself
   * is about the FACTORY reading a changed config, and that is fully exercised
   * between two `local` endpoints and an `on-device` selection. The kind-specific
   * half is covered by the descriptor test below, which needs no socket.
   */
  it('sends the next step to a different destination when the config changes', async () => {
    const one = await mock({ script: ['{"type":"done","summary":"a"}'], modelId: 'model-one' });
    const two = await mock({ script: ['{"type":"done","summary":"b"}'], modelId: 'model-two' });

    let config = configFor('local', one.origin);
    const first = createAgentBackend(config, { clientVersion: 'test' });
    await first.plan(request(context()), new AbortController().signal);

    config = { ...config, local: { endpoint: two.origin, model: 'other' } };
    const second = createAgentBackend(config, { clientVersion: 'test' });
    await second.plan(request(context()), new AbortController().signal);

    expect(one.requests.filter((r) => r.url === '/plan')).toHaveLength(1);
    expect(two.requests.filter((r) => r.url === '/plan')).toHaveLength(1);
    // The BODIES are the same; only the destination moved.
    expect(one.bodyText()).toBe(two.bodyText());
  });

  it('stops reaching the network entirely when switched to on-device', async () => {
    const server = await mock({ script: ['{"type":"done","summary":"a"}'] });
    const config = configFor('local', server.origin);

    await createAgentBackend(config, { clientVersion: 'test' }).plan(
      request(context()),
      new AbortController().signal,
    );
    await createAgentBackend({ ...config, backend: 'on-device' }, { clientVersion: 'test' }).plan(
      request(context()),
      new AbortController().signal,
    );

    // One request, from the first backend. The on-device step touched no socket.
    expect(server.requests.filter((r) => r.url === '/plan')).toHaveLength(1);
  });

  it('builds the kind the config names, with its own endpoint policy', () => {
    const config: DeploymentConfig = {
      backend: 'private',
      local: { endpoint: 'http://localhost:8787', model: 'qwen2.5-vl' },
      private: { endpoint: 'https://ai.organization.internal', model: 'qwen2.5-vl' },
      cloud: { endpoint: 'https://api.example.com', model: 'hosted-vlm' },
    };

    const priv = createAgentBackend(config, { clientVersion: 'test' });
    expect(priv.descriptor.kind).toBe('private');
    expect(priv.descriptor.endpoint).toBe('https://ai.organization.internal');
    expect(priv.descriptor.encrypted).toBe(true);

    const cloud = createAgentBackend({ ...config, backend: 'cloud' }, { clientVersion: 'test' });
    expect(cloud.descriptor.kind).toBe('cloud');
    expect(cloud.descriptor.endpoint).toBe('https://api.example.com');

    const local = createAgentBackend({ ...config, backend: 'local' }, { clientVersion: 'test' });
    expect(local.descriptor.kind).toBe('local');
    // Stated, not hidden: loopback http is not encrypted and the panel says so.
    expect(local.descriptor.encrypted).toBe(false);
  });

  it('refuses to select an off-device backend with no endpoint', () => {
    expect(() => createAgentBackend(configFor('cloud', ''), { clientVersion: 'test' })).toThrow(
      /no server URL/,
    );
  });

  it('does not silently degrade an unconfigured selection to on-device', () => {
    /*
     * The refusal above matters BECAUSE of this. Returning an OnDeviceBackend
     * here would plan the step with a completely different agent while the panel
     * still displayed "Cloud AI" - the quiet substitution this whole change
     * exists to prevent, wearing the costume of a helpful default.
     */
    let built: unknown = null;
    try {
      built = createAgentBackend(configFor('private', ''), { clientVersion: 'test' });
    } catch {
      built = 'threw';
    }
    expect(built).toBe('threw');
  });
});

// --- Endpoint policy ---------------------------------------------------------

describe('what each deployment will accept as an endpoint', () => {
  it('lets local use loopback http, which is the existing development flow', () => {
    const derived = deriveBackendOrigin('local', 'http://localhost:8787/plan');
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value.origin).toBe('http://localhost:8787');
    // The PATTERN drops the port - a match pattern's host may not carry one.
    expect(derived.value.pattern).toBe('http://localhost/*');
  });

  it('refuses loopback http for private and cloud', () => {
    for (const kind of ['private', 'cloud'] as const) {
      const derived = deriveBackendOrigin(kind, 'http://localhost:8787');
      expect(derived.ok, kind).toBe(false);
      if (derived.ok) continue;
      expect(derived.error).toMatch(/https/);
    }
  });

  it('refuses plaintext to a remote host for every kind', () => {
    for (const kind of ['local', 'private', 'cloud'] as const) {
      const derived = deriveBackendOrigin(kind, 'http://ai.example.com');
      expect(derived.ok, kind).toBe(false);
    }
  });

  it('accepts https for private and cloud', () => {
    for (const kind of ['private', 'cloud'] as const) {
      const derived = deriveBackendOrigin(kind, 'https://ai.organization.internal:8443/agent');
      expect(derived.ok, kind).toBe(true);
      if (!derived.ok) continue;
      expect(derived.value.origin).toBe('https://ai.organization.internal:8443');
      // Path dropped. The user granted a HOST, not a URL.
      expect(derived.value.origin).not.toContain('/agent');
    }
  });

  it('refuses wildcards and embedded credentials whatever the kind', () => {
    for (const kind of ['local', 'private', 'cloud'] as const) {
      expect(deriveBackendOrigin(kind, 'https://*.example.com').ok, kind).toBe(false);
      expect(deriveBackendOrigin(kind, 'https://user:pw@ai.example.com').ok, kind).toBe(false);
      expect(deriveBackendOrigin(kind, '<all_urls>').ok, kind).toBe(false);
    }
  });

  it('has no endpoint for on-device', () => {
    expect(deriveBackendOrigin('on-device', 'https://ai.example.com').ok).toBe(false);
  });
});

// --- Health -----------------------------------------------------------------

describe('health is measured, not declared', () => {
  it('reports the planner the server actually names', async () => {
    const server = await mock({ plannerId: 'qwen2.5vl:3b' });
    const backend = new HttpAgentBackend({
      kind: 'private',
      origin: server.origin,
      // The CONFIGURED model, deliberately different from what the server says.
      model: 'what-the-operator-typed',
      clientVersion: 'test',
    });

    const health = await backend.health(new AbortController().signal);

    expect(health.reachable).toBe(true);
    // The measurement wins over the setting. A settings field silently
    // overriding a measurement is how a demo describes a model that never ran.
    expect(health.plannerId).toBe('qwen2.5vl:3b');
    expect(backend.descriptor.model).toBe('what-the-operator-typed');
  });

  it('reports unreachable rather than throwing', async () => {
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
    expect(health.error).not.toBeNull();
    expect(health.plannerId).toBeNull();
  });

  it('never carries a token into the health result', async () => {
    const server = await mock({ authToken: 'health-token-value' });
    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin: server.origin,
      model: 'm',
      clientVersion: 'test',
      authToken: () => 'health-token-value',
    });

    const health = await backend.health(new AbortController().signal);
    expect(JSON.stringify(health)).not.toContain('health-token-value');
  });

  it('answers instantly for on-device, because there is nothing to probe', async () => {
    const health = await new OnDeviceBackend().health();
    expect(health.reachable).toBe(true);
    expect(health.kind).toBe('on-device');
  });
});

// --- The descriptor is safe to render ---------------------------------------

describe('BackendDescriptor', () => {
  it('has no field capable of holding a secret', () => {
    const config: DeploymentConfig = {
      backend: 'cloud',
      local: { endpoint: '', model: '' },
      private: { endpoint: '', model: '' },
      cloud: { endpoint: 'https://api.example.com', model: 'vlm-1' },
    };
    const descriptor = describeBackend(config, true);
    expect(Object.keys(descriptor).sort()).toEqual([
      'authenticated',
      'encrypted',
      'endpoint',
      'kind',
      'model',
      'offDevice',
    ]);
    expect(descriptor.authenticated).toBe(true);
    expect(descriptor.encrypted).toBe(true);
  });

  it('marks a loopback local backend as unencrypted rather than pretending', () => {
    const config = configFor('local', 'http://localhost:8787');
    const descriptor = describeBackend(config, false);
    expect(descriptor.encrypted).toBe(false);
    expect(descriptor.offDevice).toBe(true);
  });

  it('never claims authentication for on-device', () => {
    const descriptor = describeBackend(defaultDeployment(), true);
    expect(descriptor.authenticated).toBe(false);
    expect(descriptor.endpoint).toBeNull();
  });

  it('names every kind', () => {
    for (const kind of ['on-device', 'local', 'private', 'cloud'] as const) {
      expect(isBackendKind(kind)).toBe(true);
      expect(backendLabel(kind).length).toBeGreaterThan(0);
    }
    expect(isBackendKind('sneaky')).toBe(false);
  });

  it('defaults to on-device with nothing configured', () => {
    const config = defaultDeployment();
    expect(config.backend).toBe('on-device');
    expect(config.local.endpoint).toBe('');
    expect(config.private.endpoint).toBe('');
    expect(config.cloud.endpoint).toBe('');
  });
});

// --- the credential is bound to a HOST, not to a slot ------------------------

describe('a token belongs to the host it was entered for', () => {
  it('is not carried across when the endpoint is re-pointed', async () => {
    /*
     * THE LEAK THIS PINS.
     *
     * The token map was keyed by BACKEND KIND. There is one `cloud` slot, so
     * pointing it at provider A, setting A's token, then later retyping the same
     * row as provider B kept the token - and the panel's own success path calls
     * a health check immediately, so provider A's bearer credential reached
     * provider B before a single agent step ran. No warning; the panel said only
     * "Access token: set for this backend".
     *
     * Keying by ORIGIN makes it structurally impossible: a re-pointed endpoint is
     * a different key, so there is simply no token and the request goes out
     * unauthenticated. This test models the background's lookup exactly - resolve
     * the token THROUGH the current endpoint, never from a slot.
     */
    const providerA = await mock({ script: ['{"type":"done","summary":"a"}'] });
    const providerB = await mock({ script: ['{"type":"done","summary":"b"}'] });

    // Keyed by origin, the way `background.ts` stores it.
    const tokens: Record<string, string> = { [providerA.origin]: 'sk-provider-a-secret' };

    const backendFor = (origin: string): HttpAgentBackend =>
      new HttpAgentBackend({
        kind: 'cloud',
        origin,
        model: 'hosted',
        clientVersion: 'test',
        authToken: () => tokens[origin] ?? null,
      });

    await backendFor(providerA.origin).plan(request(context()), new AbortController().signal);
    // The user retypes the same row with a different host. Nothing else changes.
    await backendFor(providerB.origin).plan(request(context()), new AbortController().signal);

    const aPlan = providerA.requests.find((r) => r.url === '/plan');
    const bPlan = providerB.requests.find((r) => r.url === '/plan');
    expect(aPlan?.headers['authorization']).toBe('Bearer sk-provider-a-secret');
    // The whole point: provider B sees no credential at all.
    expect(bPlan?.headers['authorization']).toBeUndefined();
    expect(providerB.bodyText()).not.toContain('sk-provider-a-secret');
    for (const r of providerB.requests) {
      expect(JSON.stringify(r.headers)).not.toContain('sk-provider-a-secret');
    }
  });

  it('does not leak through the health probe either', async () => {
    // The health check is what fires FIRST after a re-save, so it is the request
    // that would have leaked before any step ran.
    const providerB = await mock();
    const tokens: Record<string, string> = { 'https://provider-a.example': 'sk-provider-a-secret' };
    const backend = new HttpAgentBackend({
      kind: 'cloud',
      origin: providerB.origin,
      model: 'hosted',
      clientVersion: 'test',
      authToken: () => tokens[providerB.origin] ?? null,
    });

    await backend.health(new AbortController().signal);

    const health = providerB.requests.find((r) => r.url === '/health');
    expect(health?.headers['authorization']).toBeUndefined();
  });
});
