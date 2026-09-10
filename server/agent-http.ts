import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_REQUEST_BYTES } from '../src/agent-server/protocol.ts';
import { handlePlanRequest } from '../src/agent-server/server/app.ts';
import type { Planner } from '../src/agent-server/server/planner.ts';
import { parseAction, promptFingerprint } from '../src/agent-server/index.ts';
import { describeTarget } from '../src/contracts/index.ts';
import type { PlanOutcome, PlanRequest } from '../src/agent-server/protocol.ts';

/**
 * The HTTP surface, separated from the process that runs it.
 *
 * `main.ts` reads the environment and listens; this builds the server and
 * nothing else. That split is what makes the server testable: a test can bind
 * port 0, drive a real request through the real handler, and shut down - which
 * is the only way to know the wiring works, as opposed to knowing the pure
 * handler works, which was already covered.
 *
 * OUTSIDE `src/` DELIBERATELY. `boundaries.test.ts` forbids `node:*` anywhere in
 * `src/` except the harness, and that rule is what keeps node-only code out of
 * the extension bundle. This genuinely is a Node program, so it lives where the
 * rule does not have to be bent. `tsconfig.json` still typechecks it.
 */

export interface AgentServerOptions {
  readonly planner: Planner;
  /** Shown on /health so "is a real model wired up" is answerable. */
  readonly description: string;
  /**
   * Require this bearer token on /plan. Null disables auth entirely.
   *
   * Off by default, and that is right for the loopback deployment this project
   * develops against: the server holds no data, and a token typed into a demo
   * script is a credential in a demo script. It exists for the PRIVATE and CLOUD
   * deployments, where the endpoint is reachable by more than the machine it
   * runs on and "anyone who can route to it can spend the GPU" is not a policy.
   *
   * The token is never echoed - not on /health, not in an error body, not in a
   * log line. `tests/server/backend-auth.test.ts` asserts that.
   */
  readonly authToken?: string | null;
  /** Whether a real model is wired up, as opposed to the baseline. Not a secret. */
  readonly vlm?: boolean;
  /** The model id in use, or null for the baseline. Not a secret. */
  readonly model?: string | null;
  /**
   * Whether the provider confirmed the model id resolves.
   *
   * A GETTER, not a value: the probe is asynchronous and the server starts
   * before it finishes. Passing the result would mean either blocking the
   * listen call on a network round trip - which is how a deployment becomes
   * fragile for the sake of a diagnostic - or reporting `null` forever because
   * the value was captured before it arrived.
   *
   * `null` means NOT ASKED or NOT ANSWERABLE, and is deliberately distinct from
   * `false`, which means the provider was asked and said no.
   */
  readonly modelVerified?: () => boolean | null;
  /**
   * How many tokens the model endpoint will actually accept, if it said.
   *
   * A GETTER for the same reason `modelVerified` is one - the probe is
   * asynchronous and the server must not wait for it.
   *
   * WHAT THE CLIENT DOES WITH IT. The extension budgets its prompt to
   * `maxPromptTokens`, which defaults to 30,000. A local model typically serves
   * 4,096 or 8,192, and neither Ollama nor llama.cpp REFUSES an over-long
   * prompt - they truncate it and answer. Measured on this project: the same
   * page and goal produced a correct `type` action at a 5,000-token budget and
   * a give-up `done` at 30,000, against an 8,192-token window. Reporting the
   * number here is what lets the client clamp instead of guessing.
   *
   * `null` means NOT KNOWN - a non-Ollama endpoint, or a model pinning no
   * `num_ctx` - and the client keeps its own default rather than being handed a
   * fabricated ceiling.
   */
  readonly contextWindow?: () => number | null;
  /**
   * Told about every /plan request, AFTER its reply has been written.
   *
   * WHY. A real amazon.in run typed into a search box, re-typed, and aborted,
   * and nothing on either side could say afterwards what the model had typed
   * or why it gave up: the panel showed verbs, and this server logged nothing
   * per request. `main.ts` uses this for a one-line summary and an opt-in trace.
   *
   * After the reply, and inside a try: an observer must never delay a plan or
   * turn a good one into an error.
   */
  readonly onPlan?: (event: PlanEvent) => void;
}

/** One answered /plan request, for logging. */
export interface PlanEvent {
  /** The parsed body. Validated only if `outcome.ok`; a refused one is whatever was sent. */
  readonly request: unknown;
  readonly bytes: number;
  /** Wall clock inside this server, reply included. */
  readonly ms: number;
  readonly outcome: PlanOutcome;
}

/**
 * One log line per plan: counts, refs and verbs, and NO page text.
 *
 * `[plan] 113 el, 48.2 KB, no image -> type e4 (1516 ms model, 1522 ms total)`
 *
 * No typed text, no summary, no reason, no element names - on a hosted
 * deployment this line lands in somebody else's log store, and the context it
 * describes is a user's (redacted) browsing. The verb and the ref are enough to
 * see a loop; the full exchange is `AGENT_TRACE_DIR`, which an operator opts into.
 *
 * The reply is parsed here ONLY to name the verb. The client still parses and
 * validates it independently; nothing about what is sent back depends on this.
 */
export function summarisePlan(event: PlanEvent): string {
  const req = (typeof event.request === 'object' && event.request !== null
    ? event.request
    : {}) as Partial<PlanRequest>;
  const ctx = req.context as { elements?: unknown; screenshot?: unknown } | undefined;
  const elements = Array.isArray(ctx?.elements) ? ctx.elements.length : 0;
  const image = ctx?.screenshot !== undefined && ctx.screenshot !== null;
  const head =
    `[plan] ${String(elements)} el, ${(event.bytes / 1024).toFixed(1)} KB, ` +
    `${image ? 'image' : 'no image'}${typeof req.correction === 'string' ? ', re-plan' : ''}`;

  if (!event.outcome.ok) {
    // Already credential-masked at the transport; it is forwarded to the client verbatim.
    return `${head} -> FAILED in ${String(event.ms)} ms: ${event.outcome.error.error.slice(0, 200)}`;
  }
  const { raw, serverMs } = event.outcome.response;
  const parsed = parseAction(raw);
  const what = parsed.ok
    ? `${parsed.value.type}${
        'ref' in parsed.value
          ? ` ${
              // KEYS ONLY: a target's values were copied off the page by the model.
              parsed.value.target !== undefined
                ? describeTarget(parsed.value.target, { values: false })
                : String(parsed.value.ref)
            }`
          : ''
      }` +
      `${parsed.value.type === 'type' && parsed.value.submit ? ' +submit' : ''}`
    : `UNPARSEABLE (${parsed.error.code}, ${String(raw.length)} chars)`;
  return `${head} -> ${what} (${String(serverMs)} ms model, ${String(event.ms)} ms total)`;
}

/**
 * Compares two tokens without leaking their relationship through timing.
 *
 * Whether this matters over a network is arguable - jitter swamps the signal -
 * but the argument is not worth having every time somebody reads this file, and
 * the cost is a fixed-length loop. The LENGTH is compared first and separately,
 * which does leak length; that is accepted, because a length oracle on a random
 * bearer token buys an attacker essentially nothing.
 */
function tokenMatches(expected: string, got: string): boolean {
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  return diff === 0;
}

/** The bearer token on a request, or null. Never logged by any caller. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * CORS, scoped to what an extension needs.
 *
 * `*` is correct rather than lax here: the caller's origin is
 * `chrome-extension://<id>` / `moz-extension://<uuid>`, which differs per
 * install, so there is no fixed origin to name. The server holds no cookies, no
 * sessions and no ambient authority - every request carries everything it acts
 * on - so a permissive origin grants nothing that calling the endpoint directly
 * would not.
 */
function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  /*
   * `authorization` IS NOT OPTIONAL HERE once a token is in play.
   *
   * It is not a CORS-safelisted request header, so a cross-origin POST carrying
   * it triggers a preflight, and a preflight that does not name it in
   * `Access-Control-Allow-Headers` FAILS. The extension would then see a bare
   * "Failed to fetch" with no request ever reaching this server and nothing in
   * its log - the same silent shape as the private-network-access header below,
   * which cost a debugging session to find.
   *
   * Declared unconditionally rather than only when auth is on: the header list
   * says what the server WILL accept, and an unauthenticated deployment
   * accepting an authorization header it then ignores costs nothing.
   */
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  /*
   * PRIVATE NETWORK ACCESS, and it is not optional on Chrome.
   *
   * The extension's origin is `chrome-extension://...`, which is a SECURE
   * context, and `http://localhost` is a PRIVATE network address. Chrome treats
   * secure-to-private as a request that needs explicit consent from the target:
   * it sends `Access-Control-Request-Private-Network: true` on the preflight and
   * refuses the real request unless the server answers with this header.
   *
   * Without it the failure surfaces in the extension as a bare "Failed to
   * fetch", with nothing on either side naming the cause - the server never sees
   * the POST at all, so its log stays empty and it looks like the server is
   * down.
   *
   * Safe here specifically because this server holds no cookies, no sessions and
   * no ambient authority: a request carries everything it acts on, so consenting
   * to be reached from a browser page grants nothing that running `curl` would
   * not.
   */
  res.setHeader('access-control-allow-private-network', 'true');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Reads a body, refusing anything over the protocol's own limit. */
async function readBody(req: IncomingMessage): Promise<string> {
  let chunks: Buffer[] = [];
  let size = 0;
  let over = false;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;

    /*
     * Enforced WHILE READING, not after. Buffering an unbounded body and then
     * measuring it turns a size limit into a memory-exhaustion bug: the check
     * reports the right number having already paid the cost.
     *
     * But going over does NOT abort the read. Bailing out mid-upload leaves the
     * client still sending into a handler that has stopped listening, and it
     * then sees ECONNRESET rather than the 400 explaining what it did wrong -
     * measured, not assumed: the first two attempts here did exactly that.
     *
     * So the buffer is dropped and the rest of the body is DRAINED and
     * discarded. Memory stays bounded at the cap while the response stays
     * deliverable.
     */
    if (!over && size > MAX_REQUEST_BYTES) {
      over = true;
      chunks = [];
    }
    if (over) {
      // A body that never ends would otherwise be drained forever. Ten times
      // the cap is enough to be polite to an honest client and no more.
      if (size > MAX_REQUEST_BYTES * 10) break;
      continue;
    }
    chunks.push(buf);
  }

  if (over) throw new Error(`request exceeds ${String(MAX_REQUEST_BYTES)} bytes`);
  return Buffer.concat(chunks).toString('utf8');
}

export function createAgentServer(options: AgentServerOptions): Server {
  const { planner, description } = options;
  const authToken = options.authToken ?? null;
  const vlmConfigured = options.vlm ?? false;
  const modelId = options.model ?? null;
  const modelVerified = options.modelVerified ?? ((): null => null);
  const contextWindow = options.contextWindow ?? ((): null => null);
  const onPlan = options.onPlan;
  const startedAt = Date.now();

  return createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      /*
       * `prompt` is a hash of the STATIC prompt rules.
       *
       * renderPrompt runs here, in the server, not in the extension bundle. Two
       * prompt fixes were written, tested, built into the extension and never
       * served, because only the extension was rebuilt. Both times the next run
       * looked identical and the obvious reading was that the fix had failed.
       * This makes "is the server running the prompt I just wrote" one request.
       *
       * The API KEY IS NEVER ECHOED here, only whether one is in use.
       */
      json(res, 200, {
        ok: true,
        planner: planner.id,
        description,
        prompt: promptFingerprint(),
        /*
         * WHETHER auth is required, never the token.
         *
         * The extension's health probe uses this to say "this endpoint expects a
         * token and you have not set one" instead of letting the first real step
         * fail with a 401 that reads like the server is broken. A boolean is the
         * whole of what it needs.
         *
         * /health itself is deliberately UNAUTHENTICATED. It reveals a planner
         * id and a one-line description and nothing else - no context, no
         * output, no ability to spend a GPU - and requiring a token to ask "are
         * you alive" would make the unavailable case indistinguishable from the
         * misconfigured one, which is the distinction the probe exists to draw.
         */
        auth: authToken !== null,
        /*
         * WHAT A DEPLOYMENT NEEDS TO VERIFY, in the three facts somebody
         * actually asks about: is the process up, is a model wired in, and is
         * the endpoint protected.
         *
         * `model` is an ID, not a credential - the same string that appears in
         * the startup log and in `PlanResponse.modelId`. `vlm: false` means every
         * plan is coming from the dependency-free baseline, which is the failure
         * a fresh deployment is most likely to have and least likely to notice:
         * it answers, it returns valid actions, and none of them came from a
         * model.
         *
         * `uptimeMs` exists for the free tier. A value in the low seconds means
         * the instance just cold-started, which is the difference between "this
         * server is slow" and "this server had been asleep".
         */
        server: 'ok',
        /*
         * `configured` and `verified` are DIFFERENT QUESTIONS and both are
         * reported. `configured: true` means a model id and a key are present -
         * it says nothing about whether the id resolves. `verified` is the
         * provider's own answer to that, and `null` means we did not get one
         * (no catalogue endpoint, unreachable, or a rejected key). Collapsing
         * them would let a typo in the id read as a healthy deployment right up
         * until the first plan.
         */
        vlm: {
          configured: vlmConfigured,
          model: modelId,
          verified: modelVerified(),
          /*
           * The token window the endpoint said it serves, or null for
           * "could not ask". The client clamps its prompt budget to this;
           * see `AgentServerOptions.contextWindow` for why a wrong number
           * here is worse than no number.
           */
          contextWindow: contextWindow(),
        },
        uptimeMs: Date.now() - startedAt,
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/plan') {
      json(res, 404, { error: 'POST /plan' });
      return;
    }

    if (authToken !== null) {
      const presented = bearerOf(req);
      if (presented === null || !tokenMatches(authToken, presented)) {
        /*
         * 401 BEFORE THE BODY IS READ. An unauthenticated caller must not be
         * able to make this process buffer up to 2 MB, and there is nothing in
         * the body worth reading to decide this.
         *
         * The reply names neither the expected token nor how the presented one
         * differed - "missing" and "wrong" are one message on purpose, because
         * distinguishing them tells an attacker whether their format is right.
         */
        res.setHeader('connection', 'close');
        json(res, 401, {
          ok: false,
          error: {
            protocolVersion: 1,
            error: 'this agent server requires a valid access token',
            retryable: false,
          },
        });
        return;
      }
    }

    void (async (): Promise<void> => {
      try {
        const text = await readBody(req);
        const body = JSON.parse(text) as unknown;
        const started = Date.now();
        const outcome = await handlePlanRequest(body, { planner });
        /*
         * 200 even for a refused plan. `ok:false` is a protocol outcome the
         * client already understands; mapping it onto an HTTP error would make a
         * rejected forgery indistinguishable from a transport fault, and the
         * client would retry something it should never retry.
         */
        json(res, 200, outcome);
        if (onPlan !== undefined) {
          try {
            onPlan({ request: body, bytes: Buffer.byteLength(text), ms: Date.now() - started, outcome });
          } catch {
            // An observer failing is not the client's problem, and the reply is already sent.
          }
        }
      } catch (err) {
        /*
         * The request stream is in an indeterminate state here: a body rejected
         * for size was refused MID-READ, so the client is very likely still
         * sending. Answering and leaving the connection open strands those
         * unread bytes on a keep-alive socket, and the NEXT request on that
         * connection hangs - which is how this was found, by a later test in the
         * same file timing out rather than by this one failing.
         *
         * `connection: close` is the whole fix. Node then closes the socket
         * gracefully once the response has been written, discarding whatever
         * the client was still sending.
         *
         * NOT `socket.destroy()`, which was the first attempt: it resets the
         * connection before the 400 has flushed, so the client gets ECONNRESET
         * instead of the error explaining what it did wrong - trading a hang for
         * a less informative failure.
         */
        res.setHeader('connection', 'close');
        json(res, 400, {
          ok: false,
          error: {
            protocolVersion: 1,
            error: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        });
      }
    })();
  });
}
