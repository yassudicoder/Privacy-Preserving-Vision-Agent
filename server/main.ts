import { HeuristicPlanner, type Planner } from '../src/agent-server/server/planner.ts';
import { VlmPlanner } from '../src/agent-server/server/vlm-planner.ts';
import { pathToFileURL } from 'node:url';
import { createAgentServer } from './agent-http.ts';

/**
 * The agent server process.
 *
 * Thin on purpose: read the environment, pick a planner, listen. The HTTP
 * surface is `agent-http.ts` so a test can exercise it without spawning a
 * process, and the request handling is `src/agent-server/server/app.ts` so it
 * can be exercised without HTTP at all.
 *
 * NO SECRETS AND NO DEFAULT THAT REACHES THE NETWORK. Endpoint, model and key
 * all come from the environment. With none set this runs the dependency-free
 * `HeuristicPlanner` and SAYS SO at startup and on /health, rather than
 * silently pointing at somebody's cloud or pretending a model is loaded.
 *
 * IT RUNS UNCHANGED ON A LAPTOP AND ON RENDER. The only thing the host supplies
 * is `PORT`, which was already read from the environment before any of this was
 * deployed anywhere. There is no "production mode", no second entry point and no
 * separate deployment build - a second implementation is a second place for the
 * privacy-relevant checks to be missing.
 */

/**
 * Render (and every other PaaS) assigns the port and expects the process to use
 * it. The 8787 fallback is the local development default and nothing else.
 */
const PORT = Number(process.env['PORT'] ?? 8787);

/**
 * `0.0.0.0`, explicitly.
 *
 * Node's default already binds every interface, so this changes no behaviour -
 * it is written down because a container that binds loopback is unreachable
 * from its own platform's router, the symptom is a health check that never
 * passes, and the cause is invisible in the logs.
 */
const HOST = process.env['HOST'] ?? '0.0.0.0';

/** Where OpenAI's chat-completions API lives. Used only when a key is present. */
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * The model used when `OPENAI_API_KEY` is set and `VLM_MODEL` is not.
 *
 * A default rather than a requirement, because a deployment that starts with the
 * heuristic baseline because somebody forgot one variable is a deployment whose
 * first demo silently is not using the model at all. It must be VISION-CAPABLE:
 * the client sends the redacted screenshot as an image part when one survives
 * the pixel-coverage check, and a text-only model rejects that request outright.
 *
 * THIS PROJECT DOES NOT KNOW WHETHER THIS MODEL EXISTS, and says so rather than
 * assuming. The id is a configuration value chosen by whoever runs the server;
 * nothing in this codebase can confirm an OpenAI catalogue entry from a string.
 * So `verifyModel` below ASKS - one `GET /v1/models/<id>` at startup - and the
 * answer lands in the log and on /health as `vlm.verified`.
 *
 * That check exists because the alternative failure is expensive and late: an id
 * that does not resolve produces a 404 from OpenAI on the first PLAN, which
 * surfaces in the extension as a failed step during a demo, several layers away
 * from the one-line cause. Override with `VLM_MODEL`.
 */
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

/**
 * Derives the model-catalogue URL from a chat-completions URL.
 *
 * `/v1/models/<id>` is part of the OpenAI-compatible surface that vLLM, Ollama
 * and llama.cpp's server all implement, so this works for the same set of
 * endpoints the planner does. Returns null when the URL is not shaped the way
 * this derivation needs, in which case verification is SKIPPED rather than
 * guessed at - reporting `verified: false` for an endpoint we simply could not
 * ask would be worse than reporting that we did not ask.
 */
export function modelCatalogueUrl(endpoint: string, model: string): string | null {
  const marker = '/chat/completions';
  const at = endpoint.indexOf(marker);
  if (at < 0) return null;
  return `${endpoint.slice(0, at)}/models/${encodeURIComponent(model)}`;
}

/** What a model probe found. `null` means the question was never asked. */
export type ModelVerification =
  | { readonly verified: true; readonly detail: string }
  | { readonly verified: false; readonly detail: string }
  | { readonly verified: null; readonly detail: string };

/**
 * Asks the provider whether this model id resolves.
 *
 * THE POINT: a model id is a string somebody typed, and every other way of
 * finding out it was wrong costs a failed step in front of an audience. One
 * request at startup turns "is this model real" from an assumption into a fact
 * the log and /health both carry.
 *
 * Never throws and never blocks startup. An unreachable catalogue is
 * `verified: null` - unknown, not false. The server still starts and still
 * plans: a provider that does not implement `/v1/models` is a legitimate
 * configuration, and refusing to run against one would be this check deciding
 * policy rather than reporting a fact.
 */
export async function verifyModel(
  endpoint: string,
  model: string,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelVerification> {
  const url = modelCatalogueUrl(endpoint, model);
  if (url === null) {
    return { verified: null, detail: 'endpoint does not expose a /v1/models catalogue' };
  }
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) {
      return { verified: true, detail: 'the provider lists this model' };
    }
    if (res.status === 404) {
      /*
       * The answer this check exists for. Stated as the provider's answer rather
       * than as our opinion - we asked, it said no.
       */
      return {
        verified: false,
        detail: `the provider does not list "${model}" - check the id against the provider's model catalogue`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      // The KEY is wrong, which says nothing about the model. Distinguished so
      // a bad key is not reported as a bad model id.
      return { verified: null, detail: 'the API key was rejected, so the model could not be checked' };
    }
    return { verified: null, detail: `model catalogue returned ${String(res.status)}` };
  } catch {
    // Offline, DNS, timeout. Unknown - never false.
    return { verified: null, detail: 'could not reach the model catalogue' };
  }
}

export interface PlannerChoice {
  readonly planner: Planner;
  /** One line for /health and the startup log. NEVER contains a credential. */
  readonly description: string;
  /** Whether a real model is wired up, as opposed to the baseline. */
  readonly vlm: boolean;
  /** The model id in use, or null for the baseline. Not a secret. */
  readonly model: string | null;
  /** The chat-completions URL in use. Not a secret. */
  readonly endpoint: string | null;
  /**
   * Probes the provider for this model id. Null when there is nothing to probe.
   *
   * A CLOSURE, not the key plus the endpoint as fields - and the existing test
   * `NEVER puts the key in the description` is what forced it. An `apiKey` field
   * here made `JSON.stringify(choice)` leak the credential, which broke a
   * property this object had had all along: that it is safe to log whole.
   *
   * Same shape as `HttpClientOptions.authToken` on the client, for the same
   * reason. A function holds the secret in a scope nothing can enumerate;
   * `JSON.stringify` of a function yields nothing at all.
   */
  readonly verify: (() => Promise<ModelVerification>) | null;
}

/**
 * Picks the planner from the environment.
 *
 * Two ways in, and the first exists purely so a Render deployment needs one
 * variable instead of three:
 *
 *   OPENAI_API_KEY            -> OpenAI chat-completions, model from VLM_MODEL
 *                                or the default above.
 *   VLM_ENDPOINT + VLM_MODEL  -> any OpenAI-compatible endpoint: vLLM, Ollama,
 *                                llama.cpp's server, Together, Groq, OpenRouter.
 *
 * The second is checked FIRST, so an explicit endpoint always wins over the
 * convenience path. Somebody who has set `VLM_ENDPOINT` to their own vLLM box
 * and also happens to have `OPENAI_API_KEY` in their shell has said which one
 * they mean.
 *
 * `VLM_API_KEY` and `OPENAI_API_KEY` are the same field to `VlmPlanner` - a
 * bearer token for whatever endpoint is in use. Both names are accepted because
 * the project already documented the first and the deployment target expects the
 * second; inventing a third would be worse than accepting two.
 */
export function selectPlanner(env: NodeJS.ProcessEnv): PlannerChoice {
  const endpoint = env['VLM_ENDPOINT'];
  const model = env['VLM_MODEL'];
  const explicitKey = env['VLM_API_KEY'];
  const openaiKey = env['OPENAI_API_KEY'];

  const nonEmpty = (v: string | undefined): string | null =>
    v === undefined || v.trim() === '' ? null : v.trim();

  const endpointSet = nonEmpty(endpoint);
  const modelSet = nonEmpty(model);
  const key = nonEmpty(explicitKey) ?? nonEmpty(openaiKey);

  if (endpointSet !== null && modelSet !== null) {
    return {
      planner: new VlmPlanner({ endpoint: endpointSet, model: modelSet, apiKey: key }),
      // The KEY ITSELF is never included, only whether one is in use.
      description: `${modelSet} at ${endpointSet}${key === null ? ' (no auth)' : ' (authenticated)'}`,
      vlm: true,
      model: modelSet,
      endpoint: endpointSet,
      verify: () => verifyModel(endpointSet, modelSet, key),
    };
  }

  if (nonEmpty(openaiKey) !== null) {
    const chosen = modelSet ?? DEFAULT_OPENAI_MODEL;
    return {
      planner: new VlmPlanner({
        endpoint: endpointSet ?? OPENAI_ENDPOINT,
        model: chosen,
        apiKey: nonEmpty(openaiKey),
      }),
      description: `${chosen} at ${endpointSet ?? OPENAI_ENDPOINT} (authenticated)`,
      vlm: true,
      model: chosen,
      endpoint: endpointSet ?? OPENAI_ENDPOINT,
      verify: () => verifyModel(endpointSet ?? OPENAI_ENDPOINT, chosen, nonEmpty(openaiKey)),
    };
  }

  return {
    planner: new HeuristicPlanner(),
    description:
      'HeuristicPlanner (no model). Set OPENAI_API_KEY, or VLM_ENDPOINT + VLM_MODEL, to use a real VLM.',
    vlm: false,
    model: null,
    endpoint: null,
    verify: null,
  };
}

/**
 * The token this server requires FROM the extension, if any.
 *
 * Separate from the model key, which is what this server presents TO the model.
 * Two different secrets travelling in opposite directions; conflating them would
 * hand the model provider's credential to every browser that connects.
 *
 * Unset is the loopback default and stays the default: a token in a development
 * script is a credential in a development script. Set it for any deployment
 * whose endpoint more than one machine can route to - which is every hosted one.
 */
function agentAuthToken(env: NodeJS.ProcessEnv): string | null {
  const raw = env['AGENT_AUTH_TOKEN'];
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

/**
 * Filled in by the probe in `start()`, read by /health.
 *
 * Mutable module state rather than a constructor argument because the probe is
 * asynchronous and the server must not wait for it. `null` until answered, and
 * `null` forever if the provider has no catalogue endpoint.
 */
let modelVerified: boolean | null = null;

/**
 * Reads the environment, binds the port, listens.
 *
 * A FUNCTION, and guarded below, because this module is also IMPORTED - by
 * `tests/server/deployment.test.ts` and `tests/server/model-config.test.ts`,
 * which want `selectPlanner`, `verifyModel` and `modelCatalogueUrl` and want
 * nothing to do with a listening socket.
 *
 * It used to run at module scope. So importing it for one pure function bound
 * port 8787 as a side effect, and the second test file to do so died with
 * EADDRINUSE - a failure in one file caused by an import in another, which is
 * about as confusing as a test failure gets. Worse, a passing run left a real
 * agent server listening for as long as the worker lived.
 */
export function start(): void {
  const choice = selectPlanner(process.env);
  const authToken = agentAuthToken(process.env);

  createAgentServer({
    planner: choice.planner,
    description: choice.description,
    authToken,
    vlm: choice.vlm,
    model: choice.model,
    modelVerified: () => modelVerified,
  }).listen(PORT, HOST, () => {
    console.log(`[agent-server] listening on ${HOST}:${String(PORT)}`);
    console.log(`[agent-server] planner: ${choice.description}`);
    /*
     * WHETHER a token is required, never the token. These are the lines most
     * likely to be pasted into an issue or shown on a projector.
     */
    console.log(
      authToken === null
        ? '[agent-server] auth: OFF - any caller that can reach this port may plan'
        : '[agent-server] auth: ON - callers must present the AGENT_AUTH_TOKEN bearer',
    );
    if (!choice.vlm) {
      console.warn(
        '[agent-server] WARNING: no model configured. Every plan will come from the ' +
          'dependency-free baseline, not from a VLM.',
      );
    }
    if (choice.vlm && authToken === null && process.env['RENDER'] !== undefined) {
      /*
       * Named only on a hosted deployment, where it actually matters. A public URL
       * with a model behind it and no token is somebody else's free inference, and
       * the bill arrives before the surprise does.
       */
      console.warn(
        '[agent-server] WARNING: a model is configured and AGENT_AUTH_TOKEN is not set. ' +
          'This endpoint is public - anyone who finds the URL can spend your model quota.',
      );
    }
    console.log('[agent-server] endpoints: POST /plan, GET /health');

    /*
     * ASKED, NOT ASSUMED - and it changes nothing about how the server runs.
     *
     * Fire-and-forget, after listen. The server is already accepting requests by
     * the time this resolves, there is no fallback to another model, and a failed
     * probe does not stop anything: a provider without a `/v1/models` catalogue is
     * a legitimate configuration and refusing to run against one would make this
     * diagnostic into a policy.
     *
     * What it buys is that a mistyped or unavailable model id is named ONCE, here,
     * in one line, instead of surfacing as a failed agent step in front of an
     * audience several layers away from its cause.
     */
    if (choice.verify !== null) {
      void choice.verify().then((result) => {
        modelVerified = result.verified;
        const label =
          result.verified === true ? 'OK' : result.verified === false ? 'NOT FOUND' : 'UNKNOWN';
        const line = `[agent-server] model check: ${choice.model ?? ''} - ${label} (${result.detail})`;
        if (result.verified === false) console.error(line);
        else console.log(line);
      });
    }
  });
}

/*
 * Only when RUN, never when imported.
 *
 * `process.argv[1]` is the script the runtime was pointed at. Compared through
 * `pathToFileURL` because argv carries a filesystem path while `import.meta.url`
 * is a URL, and on Windows those differ in separator AND in drive-letter case -
 * a string compare works on Linux and silently never matches here, which would
 * turn "starts on Render" into "starts nowhere".
 */
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  start();
}
