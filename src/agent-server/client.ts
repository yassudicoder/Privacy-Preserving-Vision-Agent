import { EgressBlockedError, NotImplementedError, assertOutboundContext } from '@/contracts/index.ts';
import {
  type AgentClient,
  type PlanOutcome,
  type PlanRequest,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  encodeRequest,
  requestBytes,
} from './protocol.ts';

/**
 * Client half. The extension talks to the server only through this.
 *
 * There is no default endpoint and no key. The user supplies an origin at
 * runtime and grants it through optional_host_permissions. Nothing here reads
 * an environment variable or embeds a URL, because a repo with a baked-in
 * endpoint is a repo one commit away from a baked-in credential.
 *
 * ONE CLIENT, THREE DEPLOYMENTS. Local (loopback), private (an organisation's
 * HTTPS server) and cloud (a hosted HTTPS server) are the SAME code with a
 * different `endpoint` and, optionally, a bearer token. There is deliberately no
 * per-deployment subclass and no per-deployment request shape: a second HTTP
 * path is a second place for the egress check to be forgotten, and the whole
 * claim of this project is that the privacy boundary does not vary with the
 * destination. `tests/agent-server/backend.test.ts` asserts the three produce
 * byte-identical bodies for the same context.
 */

export interface HttpClientOptions {
  readonly endpoint: string;
  readonly clientVersion: string;
  readonly timeoutMs?: number;
  /** Injected so tests never touch the network. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The bearer token for this endpoint, read AT REQUEST TIME.
   *
   * A function rather than a string, and that is the whole design:
   *
   *  - The token is never a field on this object, so it cannot be reached by
   *    anything that gets a reference to the client, and it does not appear if
   *    the client is ever logged or serialised in a diagnostic.
   *  - It is fetched per request, so revoking it takes effect on the next step
   *    rather than on the next service-worker restart.
   *  - It goes into an `authorization` HEADER and nowhere else. It is not in the
   *    body, not in the URL, not in `BackendDescriptor`, not in a `PanelEvent`,
   *    not in the privacy receipt. `tests/agent-server/backend.test.ts` asserts
   *    each of those.
   *
   * Returning null means "no auth", which is the normal case for a loopback
   * server and for any deployment that authenticates by network position.
   */
  readonly authToken?: () => string | null;
}

export class HttpAgentClient implements AgentClient {
  readonly #endpoint: string;
  readonly #clientVersion: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #authToken: () => string | null;

  constructor(opts: HttpClientOptions) {
    this.#endpoint = opts.endpoint;
    this.#clientVersion = opts.clientVersion;
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#authToken = opts.authToken ?? ((): null => null);
    /*
     * BOUND to the global scope, deliberately.
     *
     * `this.#fetch = globalThis.fetch` stores the function unbound, so
     * `this.#fetch(...)` calls it with `this` set to this client. A Window
     * tolerates that; a SERVICE WORKER does not - `WorkerGlobalScope.fetch`
     * checks its receiver and throws:
     *
     *   Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation
     *
     * So every Chrome step died at the plan stage while Firefox, whose
     * background is an event page, ran the identical code. Same shape as the
     * DOMParser split: one engine's background is a worker and the other's is
     * not, and code that ignores the difference works in exactly one of them.
     */
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async plan(request: PlanRequest, signal: AbortSignal): Promise<PlanOutcome> {
    /*
     * THE EGRESS GATE. FIRST, BEFORE ANYTHING ELSE, ON EVERY DEPLOYMENT.
     *
     * This is the last line of code that runs before a socket write, and it is
     * the only one that sees the payload after every transport hop has already
     * happened. That matters more than it sounds: `SanitizedContext` is nominal
     * and minted in exactly one file, but on Chrome the context is built in the
     * offscreen document and JSON-serialised back here, where
     * `receiveSanitizedContext` RE-BRANDS a plain object. From that moment the
     * type is a claim about provenance, not a fact about the bytes in hand.
     * `assertOutboundContext` re-checks the bytes.
     *
     * It is HERE rather than in the orchestrator - or rather, it is here AS WELL
     * - because this is the choke point all three off-device deployments share.
     * Local, private and cloud are one class with one endpoint field, so a
     * check placed here cannot be true of one deployment and false of another.
     * That is the literal implementation of "privacy must not depend on
     * backend": there is no second code path to forget.
     *
     * IT FAILS CLOSED. A violation returns a non-retryable refusal and NO
     * request is made. It does not strip the offending field and send the rest:
     * a payload produced by a pipeline that has just been shown to be wrong
     * about this page is not a payload to salvage.
     */
    try {
      assertOutboundContext(request.context);
    } catch (err) {
      if (!(err instanceof EgressBlockedError)) throw err;
      return {
        ok: false,
        error: {
          protocolVersion: PROTOCOL_VERSION,
          // Not retryable: the same payload would fail the same way, and the
          // fix is upstream in redaction, not in the transport.
          retryable: false,
          // WE refused. Never reported as a backend being down - offering to
          // switch backends over our own gate firing would be exactly wrong.
          kind: 'refused',
          error: err.message,
        },
      };
    }

    // The client owns its own version string; a caller cannot misreport it.
    const req: PlanRequest = { ...request, clientVersion: this.#clientVersion };
    const bytes = requestBytes(req);
    if (bytes > MAX_REQUEST_BYTES) {
      return {
        ok: false,
        error: {
          protocolVersion: PROTOCOL_VERSION,
          error: `request is ${String(bytes)} bytes, over the ${String(MAX_REQUEST_BYTES)} limit`,
          retryable: false,
          kind: 'protocol',
        },
      };
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    /*
     * Read here, per request, and spread into the headers - never stored on
     * this object and never put in the body. A server that logs request bodies
     * (most do) would otherwise be logging the token for every step.
     */
    const token = this.#authToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null && token !== '') headers['authorization'] = `Bearer ${token}`;

    try {
      const res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers,
        body: encodeRequest(req),
        signal: combined,
      });
      if (!res.ok) {
        /*
         * A 404 ON /plan IS ALMOST ALWAYS THE WRONG ORIGIN.
         *
         * A real run pointed the agent at http://localhost:8080 - the test SITE,
         * not the agent server on 8787 - and got `server returned 404`, which
         * reads like the server is broken rather than like it is not an agent
         * server at all. Two ports on one machine and one field between them.
         *
         * Named rather than diagnosed: this cannot know what the origin should
         * be, only that whatever answered does not serve /plan.
         */
        const hint =
          res.status === 404
            ? ' - this origin does not serve /plan; check it is the agent server and not the page'
            : /*
               * 401/403 IS ALMOST ALWAYS THE TOKEN, and the token is the one
               * thing this layer must not print. Naming the cause without
               * quoting the credential is the whole point of this branch: a
               * private or cloud deployment that requires auth otherwise fails
               * with a bare "server returned 401", which reads like the server
               * is broken rather than like it did not recognise us.
               */
              res.status === 401 || res.status === 403
              ? token === null || token === ''
                ? ' - the server requires authentication and no access token is set for this backend'
                : ' - the server rejected the access token set for this backend'
              : '';
        return {
          ok: false,
          error: {
            protocolVersion: PROTOCOL_VERSION,
            error: `server returned ${String(res.status)}${hint}`,
            retryable: res.status >= 500,
            /*
             * 5xx IS the backend being unwell; 4xx is this request being wrong.
             * A 401 is emphatically NOT "unavailable" - the server is up and
             * said no - so it must not open the "switch to cloud" prompt.
             */
            kind: res.status >= 500 ? 'transport' : 'protocol',
          },
        };
      }
      const body: unknown = await res.json();
      if (typeof body !== 'object' || body === null) {
        return {
          ok: false,
          error: {
            protocolVersion: PROTOCOL_VERSION,
            error: 'response was not an object',
            retryable: false,
            kind: 'protocol',
          },
        };
      }
      const parsed = body as Record<string, unknown>;
      if (parsed['ok'] === false) {
        const e = (parsed['error'] ?? {}) as Record<string, unknown>;
        return {
          ok: false,
          error: {
            protocolVersion: PROTOCOL_VERSION,
            error: typeof e['error'] === 'string' ? e['error'] : 'server refused the request',
            retryable: e['retryable'] === true,
            // The server answered. Whatever it said, it is not unreachable.
            kind: 'protocol',
          },
        };
      }
      /*
       * THE SERVER SENDS AN ENVELOPE, and this used to read the flat shape.
       *
       * `server/agent-http.ts` responds with the whole `PlanOutcome`:
       *   { ok: true, response: { protocolVersion, raw, modelId, serverMs } }
       * while this function read `raw`/`modelId`/`serverMs` off the TOP level.
       * All three were undefined, so `raw` fell back to `''`, `parseAction('')`
       * failed with `empty-input`, and the step died at the parse stage - after
       * the panel had already reported a successful server round trip.
       *
       * That is the THIRD envelope mismatch in this project (the offscreen host
       * and the offscreen dispatch were the first two), and it has the same
       * cause every time: one side wraps, the other side reads through, and no
       * test spans both.
       *
       * The `: parsed` fallback accepts a flat body too - a plain
       * `{raw, modelId, serverMs}` from some other server implementation is a
       * legitimate shape, and refusing it would buy nothing.
       */
      const env =
        typeof parsed['response'] === 'object' && parsed['response'] !== null
          ? (parsed['response'] as Record<string, unknown>)
          : parsed;
      return {
        ok: true,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          raw: typeof env['raw'] === 'string' ? env['raw'] : '',
          modelId: typeof env['modelId'] === 'string' ? env['modelId'] : 'unknown',
          serverMs: typeof env['serverMs'] === 'number' ? env['serverMs'] : 0,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      /*
       * "Failed to fetch" on its own is useless - it is what the browser says
       * for a refused connection, a blocked preflight and a DNS failure alike,
       * and it names neither the endpoint nor a next step. The endpoint is the
       * one thing this layer knows that the user does not.
       */
      /*
       * BOTH WORD ORDERS, and that is not paranoia.
       *
       * A browser says "Failed to fetch"; Node's undici - which the tests run
       * against - says "fetch failed". A pattern matching only the first passed
       * every browser-shaped test and reported a bare "fetch failed" the moment
       * anything ran outside one, which is exactly the useless message this
       * branch exists to replace.
       */
      const detail = /failed to fetch|fetch failed|networkerror|network error|load failed|econnrefused|enotfound/i.test(message)
        ? `could not reach ${this.#endpoint} - is the agent server running? (npm run server)`
        : message;
      return {
        ok: false,
        // A throw from `fetch` means the request did not complete: refused
        // connection, DNS, blocked preflight, timeout. That is the backend being
        // unreachable, and it is the one case that should offer a switch.
        error: { protocolVersion: PROTOCOL_VERSION, error: detail, retryable: true, kind: 'transport' },
      };
    }
  }
}

/** Placeholder for the real transport work. Scaffold only. */
export class UnimplementedAgentClient implements AgentClient {
  plan(): Promise<PlanOutcome> {
    throw new NotImplementedError('AgentClient transport');
  }
}
