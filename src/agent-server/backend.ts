import {
  type BackendDescriptor,
  type BackendHealth,
  type BackendKind,
  type DeploymentConfig,
  configFor,
  describeBackend,
  isOffDevice,
} from '@/contracts/index.ts';
import { HttpAgentClient } from './client.ts';
import { LocalPlannerClient, type LocalPlannerOptions } from './local-planner.ts';
import { deriveOriginPattern, type OriginResult } from './origin.ts';
import type { AgentClient, PlanOutcome, PlanRequest } from './protocol.ts';

/**
 * One interface, four deployments.
 *
 * WHAT THIS ADDS OVER `AgentClient`. `AgentClient` was already the right
 * abstraction for planning - `plan(request, signal) => PlanOutcome`, with
 * `PlanRequest.context` typed `SanitizedContext` so nothing else can be sent.
 * It was not an abstraction over DEPLOYMENT: the background chose between two
 * concrete classes on `serverOrigin === null`, and the panel learned which one
 * had answered only from a notice string.
 *
 * An `AgentBackend` is an `AgentClient` that can also say what it is
 * (`descriptor`) and whether it is up (`health`). Those two additions are what
 * the settings UI, the health indicator, the "private server unavailable" flow
 * and the privacy receipt are all built from - and every one of them then
 * reports MEASURED state rather than a label.
 *
 * WHAT IT DELIBERATELY DOES NOT ADD. There is no hook here for changing what is
 * sent, no per-backend context transform, no "cloud mode also needs X". The
 * request body is produced once, by the sanitizer, and this layer only chooses a
 * destination for it. A backend that could reshape the payload would be a
 * backend that could unredact it.
 *
 * WHY `on-device` IS ONE OF THE FOUR. Its `plan` reaches no network at all, so
 * it is not a "deployment" in the sense the other three are. It is here because
 * the alternative is worse: if it were a fallback rather than a choice, then
 * every failure of a real backend would silently become it, and the panel would
 * report a successful plan produced by a different agent. Making it selectable
 * means switching to it is an act with a record.
 */

export interface AgentBackend extends AgentClient {
  /** Safe to display, log and persist. Carries no credential - see the type. */
  readonly descriptor: BackendDescriptor;
  /**
   * Is it up, and what does it say it is running?
   *
   * Never throws. An unreachable backend is a normal, reportable state - the
   * whole point of the control is to tell "the private server is down" apart
   * from "the extension is broken", and a rejected promise makes those look the
   * same at the call site.
   */
  health(signal: AbortSignal): Promise<BackendHealth>;
}

/**
 * The on-device baseline, wearing the backend interface.
 *
 * `LocalPlannerClient` is unchanged and unwrapped-into: its `plan` still returns
 * a RAW STRING that `runAgentStep` runs through `parseAction` and
 * `validateAction` exactly as it would bytes from a hostile server. That is
 * deliberate and it is why this composes rather than special-cases - the local
 * path must exercise the same rails, not a shortcut around them.
 */
export class OnDeviceBackend implements AgentBackend {
  readonly descriptor: BackendDescriptor = {
    kind: 'on-device',
    endpoint: null,
    model: 'local-heuristic-baseline',
    offDevice: false,
    authenticated: false,
    // Not "insecure": there is no transport to secure. The panel renders
    // `offDevice: false` rather than a padlock for exactly this reason.
    encrypted: false,
  };

  readonly #inner: LocalPlannerClient;

  constructor(options: LocalPlannerOptions = {}) {
    this.#inner = new LocalPlannerClient(options);
  }

  plan(req: PlanRequest, signal: AbortSignal): Promise<PlanOutcome> {
    return this.#inner.plan(req, signal);
  }

  health(): Promise<BackendHealth> {
    // Always up. It is code in this process; there is nothing to probe.
    return Promise.resolve({
      kind: 'on-device',
      reachable: true,
      waking: false,
      // Nothing to authenticate to.
      authRequired: false,
      plannerId: 'local-heuristic-baseline',
      description: 'planning on this device - nothing is sent anywhere',
      error: null,
      checkedAtMs: 0,
    });
  }
}

/**
 * How long a health probe may take.
 *
 * Long enough to survive a free-tier cold start, which is tens of seconds, and
 * bounded so a dead host does not hold the status row forever. A probe that runs
 * out reports `waking: true` rather than a flat failure - see `BackendHealth`.
 */
const HEALTH_TIMEOUT_MS = 45_000;

/**
 * 60 s, not the protocol default of 20 s.
 *
 * A local VLM sharing one laptop GPU with the extension's own model took over
 * 20 s and the step died with "signal timed out" - a timeout tuned for a remote
 * server on a fast link, applied to a model running on the same machine. The
 * same generosity is extended to private and cloud, where a cold model load on
 * the server side has the same shape.
 */
const PLAN_TIMEOUT_MS = 60_000;

/** Chopped hard: this string is SERVER-AUTHORED and lands in our UI. */
const MAX_DESCRIPTION_CHARS = 200;

export interface HttpBackendOptions {
  readonly kind: BackendKind;
  /** Origin only. `/plan` and `/health` are appended here, not by the caller. */
  readonly origin: string;
  readonly model: string | null;
  readonly clientVersion: string;
  /** Read at request time. See `HttpClientOptions.authToken`. */
  readonly authToken?: () => string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * The one HTTP backend. Local, private and cloud are three of these.
 *
 * The ONLY differences between the three instances are the origin, whether a
 * token function is supplied, and what `deriveBackendOrigin` was willing to
 * accept for that kind. Everything downstream - the request body, the egress
 * gate inside `HttpAgentClient`, the response handling, the parse and the
 * validation - is one code path.
 */
export class HttpAgentBackend implements AgentBackend {
  readonly descriptor: BackendDescriptor;

  readonly #client: HttpAgentClient;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #authToken: () => string | null;
  readonly #now: () => number;

  constructor(opts: HttpBackendOptions) {
    if (!isOffDevice(opts.kind)) {
      throw new Error(`HttpAgentBackend cannot serve the "${opts.kind}" kind`);
    }
    if (opts.origin === '') throw new Error('HttpAgentBackend: origin is required');

    this.#origin = opts.origin.replace(/\/+$/, '');
    this.#authToken = opts.authToken ?? ((): null => null);
    /*
     * BOUND to the global scope. `this.#fetch = globalThis.fetch` stores the
     * function unbound, and a SERVICE WORKER's fetch checks its receiver and
     * throws "Illegal invocation" - which broke every Chrome step at the plan
     * stage while Firefox, whose background is an event page, ran the identical
     * code. Same trap as `HttpAgentClient`; the health probe needs its own copy.
     */
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#now = opts.now ?? ((): number => Date.now());

    this.#client = new HttpAgentClient({
      endpoint: `${this.#origin}/plan`,
      clientVersion: opts.clientVersion,
      timeoutMs: opts.timeoutMs ?? PLAN_TIMEOUT_MS,
      authToken: this.#authToken,
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    });

    this.descriptor = {
      kind: opts.kind,
      endpoint: this.#origin,
      model: opts.model === '' ? null : opts.model,
      offDevice: true,
      // Whether a token EXISTS, evaluated now for display. The token itself is
      // never read into this object.
      authenticated: (this.#authToken() ?? '') !== '',
      encrypted: this.#origin.startsWith('https://'),
    };
  }

  plan(req: PlanRequest, signal: AbortSignal): Promise<PlanOutcome> {
    return this.#client.plan(req, signal);
  }

  /**
   * `GET /health`, which `server/agent-http.ts` already serves.
   *
   * It answers `{ ok, planner, description, prompt }` and is explicit that the
   * API key is never echoed, only whether one is in use. That is the contract
   * this relies on; the description is still neutralised and capped below,
   * because a server we do not control writing text into our panel is the same
   * class of problem as an `ask_user` question.
   */
  async health(signal: AbortSignal): Promise<BackendHealth> {
    const at = this.#now();
    const base = {
      kind: this.descriptor.kind,
      checkedAtMs: at,
      waking: false,
      authRequired: null,
    } as const;
    const token = this.#authToken();
    const headers: Record<string, string> = {};
    if (token !== null && token !== '') headers['authorization'] = `Bearer ${token}`;

    try {
      const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
      const res = await this.#fetch(`${this.#origin}/health`, {
        method: 'GET',
        headers,
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!res.ok) {
        return {
          ...base,
          reachable: false,
          plannerId: null,
          description: null,
          error: `health check returned ${String(res.status)}`,
        };
      }
      const body: unknown = await res.json();
      const parsed = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      return {
        ...base,
        reachable: true,
        plannerId: typeof parsed['planner'] === 'string' ? safeText(parsed['planner']) : null,
        description:
          typeof parsed['description'] === 'string' ? safeText(parsed['description']) : null,
        // A BOOLEAN the server publishes about itself, never a credential.
        // Absent on an older server, which is `null` - not `false`.
        authRequired: typeof parsed['auth'] === 'boolean' ? parsed['auth'] : null,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      /*
       * TIMED OUT is not the same fact as REFUSED, and a free hosting tier makes
       * the difference matter. A sleeping instance accepts the connection and
       * answers nothing until it has woken; a dead one refuses immediately.
       * Reporting both as "unavailable" tells a user their server is down at the
       * moment it is coming up.
       *
       * Matched on the DOMException name first, which is what `AbortSignal.timeout`
       * actually produces, with the message as a fallback for engines that word
       * it differently.
       */
      const name = err instanceof Error ? err.name : '';
      const timedOut = name === 'TimeoutError' || /timed?\s*out|timeout/i.test(message);
      return {
        ...base,
        reachable: false,
        waking: timedOut,
        plannerId: null,
        description: null,
        /*
         * "Failed to fetch" alone names neither the endpoint nor a next step,
         * and it is what the browser says for a refused connection, a blocked
         * preflight and a DNS failure alike. The ORIGIN is the one thing this
         * layer knows that the user does not - and it is not a secret, it is
         * what they typed.
         */
        error: timedOut
          ? `${this.#origin} did not answer in time - it may be waking from sleep`
          : /failed to fetch|fetch failed|networkerror|network error|load failed|econnrefused|enotfound/i.test(message)
            ? `could not reach ${this.#origin}`
            : safeText(message),
      };
    }
  }
}

/**
 * Server text, made safe to render.
 *
 * Control characters stripped to a space, whitespace collapsed, hard length cap.
 * Not `neutralize()` from contracts, which also defangs prompt fence tokens -
 * that matters for text going INTO a prompt and is irrelevant here, and the cap
 * is the property that actually matters for a status line.
 */
function safeText(raw: string): string {
  /*
   * Written as ESCAPES, never as literal bytes. `contracts/untrusted.ts` makes
   * the same choice for the same reason: a regex containing an actual control
   * character is invisible in a diff, does not survive a copy-paste intact, and
   * cannot be reviewed. C0 controls, DEL, and the C1 range.
   */
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_DESCRIPTION_CHARS
    ? `${cleaned.slice(0, MAX_DESCRIPTION_CHARS)}...`
    : cleaned;
}

/**
 * What a given deployment kind will accept as an endpoint.
 *
 * `deriveOriginPattern` already refuses wildcards, embedded credentials,
 * unreachable single-label hosts, IPv6 literals, and plaintext to anything but
 * loopback. That is the floor for every kind. This adds the per-kind rule on
 * top:
 *
 *  - `local` may be loopback http. That is the development flow this project
 *    already has (`npm run server` on 8787) and it must keep working.
 *  - `private` and `cloud` must be HTTPS, FULL STOP. Plaintext to a remote host
 *    puts the sanitized context on the wire in the clear, which undoes the point
 *    of having redacted it. `deriveOriginPattern` would already refuse
 *    `http://ai.example.com`; what this adds is refusing `http://localhost` for
 *    those kinds - because a "private organisation server" on loopback is
 *    someone mis-selecting the mode, and letting it through means the panel
 *    would display "Private Organization Server, encrypted: no" as a normal
 *    state.
 *
 * TLS VERIFICATION IS NOT TOUCHED ANYWHERE. There is no option here or anywhere
 * else in this codebase to skip it; `fetch` in an extension has no such knob and
 * none is being added. A self-signed private server is a trust decision for the
 * browser's certificate store, made once by an administrator, not something an
 * extension setting should be able to wave through per request.
 */
export function deriveBackendOrigin(kind: BackendKind, raw: string): OriginResult {
  if (!isOffDevice(kind)) {
    return { ok: false, error: 'the on-device backend has no endpoint' };
  }
  const derived = deriveOriginPattern(raw);
  if (!derived.ok) return derived;

  if (kind !== 'local' && !derived.value.origin.startsWith('https://')) {
    return {
      ok: false,
      error:
        `${kind === 'private' ? 'a private organization server' : 'a cloud endpoint'} must use ` +
        'https - use the Local AI backend for a loopback server',
    };
  }
  return derived;
}

export interface BackendFactoryOptions {
  readonly clientVersion: string;
  /**
   * Reads the token for one backend kind, at request time.
   *
   * Injected rather than read here because the token lives in the background's
   * session storage and this function must remain callable from a test with no
   * browser. Returning null is the normal case.
   */
  readonly authTokenFor?: (kind: BackendKind) => string | null;
  readonly fetchImpl?: typeof fetch;
  readonly localPlanner?: LocalPlannerOptions;
  readonly now?: () => number;
}

/**
 * Builds the backend the config selects. The whole of "backend switching".
 *
 * Switching is a matter of building a different object from a different config
 * and calling the same `plan`. Nothing is cached across a switch - a new object
 * is constructed per step - so a changed endpoint or a revoked token takes
 * effect immediately rather than at the next service-worker restart.
 *
 * Throws for a selected-but-unconfigured off-device backend. That is a
 * deliberate refusal rather than a fall back to `on-device`: falling back would
 * plan the step with a different agent while every downstream event still said
 * the task ran, which is the exact class of quiet substitution this whole change
 * exists to prevent.
 */
export function createAgentBackend(
  config: DeploymentConfig,
  options: BackendFactoryOptions,
): AgentBackend {
  const kind = config.backend;
  if (kind === 'on-device') return new OnDeviceBackend(options.localPlanner ?? {});

  const entry = configFor(config, kind);
  if (entry.endpoint === '') {
    throw new Error(
      `the ${kind} backend is selected but has no server URL - set one in the panel, ` +
        'or switch to on-device planning',
    );
  }

  const derived = deriveBackendOrigin(kind, entry.endpoint);
  if (!derived.ok) {
    throw new Error(`the ${kind} backend URL is not usable: ${derived.error}`);
  }

  const readToken = (): string | null => options.authTokenFor?.(kind) ?? null;

  return new HttpAgentBackend({
    kind,
    origin: derived.value.origin,
    model: entry.model === '' ? null : entry.model,
    clientVersion: options.clientVersion,
    authToken: readToken,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * The descriptor for a config, without building a backend.
 *
 * For the panel and for `runTask`'s pre-flight, both of which want to SAY which
 * backend is selected without constructing a client - and, in the panel's case,
 * cannot construct one at all, since it has no access to the token.
 */
export function backendDescriptorFor(
  config: DeploymentConfig,
  hasToken: boolean,
): BackendDescriptor {
  return describeBackend(config, hasToken);
}
