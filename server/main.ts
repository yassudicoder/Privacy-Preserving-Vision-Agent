import { HeuristicPlanner, type Planner } from '../src/agent-server/server/planner.ts';
import { VlmPlanner } from '../src/agent-server/server/vlm-planner.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderPrompt } from '../src/agent-server/index.ts';
import type { PlanRequest } from '../src/agent-server/protocol.ts';
import { createAgentServer, summarisePlan, type PlanEvent } from './agent-http.ts';

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
/*
 * LOOPBACK BY DEFAULT. `0.0.0.0` listens on every interface, so the
 * unauthenticated local dev server was reachable from the whole LAN (shared
 * wifi), not only this machine. The extension talks to 127.0.0.1, which binding
 * to loopback does not change. Render needs 0.0.0.0 and sets `RENDER`; an
 * explicit `HOST` still wins for any other deployment that means to expose it.
 */
const HOST = process.env['HOST'] ?? (process.env['RENDER'] !== undefined ? '0.0.0.0' : '127.0.0.1');

/** Where OpenAI's chat-completions API lives. Used only when a key is present. */
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * Google AI Studio, through its OpenAI-COMPATIBLE surface.
 *
 * Not the native `generativeLanguage` REST shape - the compatibility layer, so
 * `VlmPlanner` needs no Gemini-specific code at all. Verified against the docs
 * and by probing: same `Authorization: Bearer <key>` header, the same
 * `messages`/`content` parts including `image_url` with a base64 data URL, and
 * a `/models/{id}` catalogue at the sibling path `modelCatalogueUrl` already
 * derives. Parameters it does not recognise are silently ignored rather than
 * rejected, which is what makes one planner serve both providers.
 */
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/**
 * The Gemini model used when a Google key is set and `VLM_MODEL` is not.
 *
 * Vision-capable, which is not optional: the client sends the verified redacted
 * screenshot as an image part whenever one survives the pixel-coverage check,
 * and a text-only model rejects that request outright.
 *
 * The `-lite` tier because of what the task is - pick one ref from a list the
 * client already ranked, deduplicated and budgeted, and name one verb from a
 * ten-item vocabulary. Google documents this tier as their fastest and most
 * cost-effective multimodal model, which is the right shape for a loop that
 * runs up to eight times per task.
 *
 * As with every model id here, this is CONFIGURATION and nothing in this repo
 * can confirm a provider's catalogue from a string. `/health` reports
 * `vlm.verified` from an actual probe; that is the check, not this line.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

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
       * A 404 IS NOT PROOF THE MODEL IS MISSING, and assuming it was would have
       * produced a confidently wrong diagnosis on Google.
       *
       * Measured: `generativelanguage.googleapis.com/v1beta/openai/models/...`
       * answers 404 to an UNAUTHENTICATED request for the catalogue list, for a
       * real model id, and for `definitely-not-a-real-model-xyz` alike - all
       * four with the identical body `Requested entity was not found.` So a
       * missing or rejected key looks exactly like a missing model, and the
       * startup line would have told somebody to fix `VLM_MODEL` when the
       * problem was `GEMINI_API_KEY`.
       *
       * So the 404 is CORROBORATED against the catalogue list. If the list
       * answers 200 the credential works, and a 404 on the specific id is then
       * genuinely "no such model". If the list does not answer 200 we could not
       * authenticate, and the honest report is `null` - unknown - which is the
       * distinction this whole function exists to preserve.
       *
       * One extra request, only on the 404 path, only at startup.
       */
      const listUrl = url.slice(0, url.lastIndexOf('/'));
      try {
        const list = await fetchImpl(listUrl, {
          method: 'GET',
          headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (list.status !== 200) {
          return {
            verified: null,
            detail:
              `the provider answered 404 for "${model}" and also refused the catalogue ` +
              `(${String(list.status)}), so this is more likely a credential problem than a model id`,
          };
        }
      } catch {
        return {
          verified: null,
          detail: `the provider answered 404 for "${model}" and the catalogue could not be reached`,
        };
      }
      // The list answered, so the credential works and the id genuinely does not.
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

/**
 * Derives Ollama's native `/api/show` URL from an OpenAI-compatible one.
 *
 * NATIVE, deliberately, and this is the whole reason this function exists: the
 * OpenAI-compatible surface has NO field reporting a context window. Probed
 * against the running server, `GET /v1/models/qwen2.5vl-8k:latest` answers
 * `{id, object, created, owned_by}` and nothing else. The window is knowable
 * only through Ollama's own API, so this is the one place the server steps
 * outside the compatible surface - and it returns null rather than guessing
 * for every endpoint that is not shaped like Ollama's.
 */
export function ollamaShowUrl(endpoint: string): string | null {
  const marker = '/v1/chat/completions';
  const at = endpoint.indexOf(marker);
  if (at < 0) return null;
  return `${endpoint.slice(0, at)}/api/show`;
}

/**
 * Pulls `num_ctx` out of Ollama's `parameters` blob.
 *
 * `parameters` is newline-separated `name<spaces>value` text, not JSON:
 *
 *     num_ctx                        8192
 *     temperature                    0.0001
 *
 * `num_ctx` IS THE ONE THAT MATTERS, and it is not the same number as
 * `model_info["<arch>.context_length"]`, which sits in the same response and is
 * far more tempting to read. Measured on this machine: the architectural
 * context_length is 128000 while the served num_ctx is 8192. Reporting the
 * former would tell the extension it had a 128k budget on a model serving 8k -
 * a wrong answer that is worse than no answer, because it would be believed.
 */
export function parseNumCtx(parameters: unknown): number | null {
  if (typeof parameters !== 'string') return null;
  const match = /^[ \t]*num_ctx[ \t]+(\d+)[ \t]*$/m.exec(parameters);
  if (match === null) return null;
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** What a context-window probe found. `tokens: null` means it is not known. */
export interface ContextWindow {
  readonly tokens: number | null;
  readonly detail: string;
}

/**
 * Asks the endpoint how many tokens it will actually accept.
 *
 * WHY THIS IS NOT A NICETY. A prompt larger than the served window is not
 * refused by llama.cpp or Ollama - it is TRUNCATED, silently, and the model
 * answers anyway. Measured end to end on this machine, same page, same goal,
 * same model, differing only in the client's budget:
 *
 *   30,000-token budget -> {"type":"done","summary":"..."}
 *    5,000-token budget -> {"type":"type","ref":"e21","text":"privacy"}
 *
 * The second is correct - e21 is the Wikipedia search box. The first is the
 * model being shown a fragment ending mid-prompt and giving up, and it is
 * indistinguishable at the panel from a small model being bad at its job. What
 * gets cut is the END of the prompt, which is where this project deliberately
 * puts the element list, ALREADY DONE and CORRECTION.
 *
 * The client cannot discover this for itself - the OpenAI-compatible body has
 * no such field - so the SERVER asks and reports it on /health, and the
 * extension clamps its budget to the answer.
 *
 * Never throws, never blocks startup, never guesses. An endpoint that is not
 * Ollama, or one whose Modelfile pins no `num_ctx`, is `tokens: null` - and
 * null means UNKNOWN, so the client keeps its own default rather than being
 * handed a fabricated ceiling.
 */
export async function probeContextWindow(
  endpoint: string,
  model: string,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ContextWindow> {
  const url = ollamaShowUrl(endpoint);
  if (url === null) {
    return { tokens: null, detail: 'endpoint is not an Ollama-shaped URL; the window cannot be asked for' };
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) {
      return { tokens: null, detail: `/api/show returned ${String(res.status)}` };
    }
    const body = (await res.json()) as { parameters?: unknown };
    const tokens = parseNumCtx(body.parameters);
    if (tokens === null) {
      /*
       * NOT an error, and not a licence to assume 4096 either.
       *
       * A model whose Modelfile pins no `num_ctx` is served at Ollama's own
       * default, which is a property of the Ollama INSTALL - `OLLAMA_CONTEXT_LENGTH`
       * changes it - and is not reported here. Naming a number we did not read
       * would be the same mistake as reading `context_length` above.
       */
      return {
        tokens: null,
        detail:
          'this model pins no num_ctx, so it runs at the Ollama default ' +
          '(set OLLAMA_CONTEXT_LENGTH, or pin num_ctx in a Modelfile, to make it knowable)',
      };
    }
    return { tokens, detail: `the endpoint serves ${String(tokens)} tokens of context` };
  } catch {
    return { tokens: null, detail: 'could not reach /api/show' };
  }
}

/**
 * Derives Ollama's native `/api/generate` URL from an OpenAI-compatible one.
 * Same derivation, and the same null for anything not shaped like Ollama, as
 * `ollamaShowUrl`.
 */
export function ollamaGenerateUrl(endpoint: string): string | null {
  const show = ollamaShowUrl(endpoint);
  return show === null ? null : `${show.slice(0, -'/api/show'.length)}/api/generate`;
}

/** How long a model stays resident after each plan unless `VLM_KEEP_ALIVE` says otherwise. */
export const DEFAULT_KEEP_ALIVE = '30m';

/**
 * Reads `VLM_KEEP_ALIVE`. `value: null` means do not ask Ollama for anything.
 *
 * Ollama grammar only: a duration (`30m`, `2h`, `90s`) or a bare number of
 * seconds, negative meaning "forever". `0` and `off` both mean OFF here - to
 * Ollama, `0` means "unload right after this request", which would make every
 * plan a cold load and is never what somebody setting this wanted. A value
 * outside the grammar is REPORTED and not sent, rather than silently replaced:
 * a typo in configuration should be named, not quietly worked around.
 */
export function parseKeepAlive(raw: string | undefined): {
  readonly value: string | null;
  readonly problem: string | null;
} {
  const v = (raw ?? '').trim();
  if (v === '') return { value: DEFAULT_KEEP_ALIVE, problem: null };
  if (/^(off|no|false|0)$/i.test(v)) return { value: null, problem: null };
  if (/^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(v)) return { value: v, problem: null };
  return {
    value: null,
    problem: `"${v}" is not a duration Ollama accepts (use e.g. 30m, 2h, -1, or off); keep-alive is OFF`,
  };
}

export interface KeepAliveResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Loads the model and asks Ollama to keep it resident for `keepAlive`.
 *
 * WHY THE SERVER DOES THIS. Ollama unloads an idle model after five minutes by
 * default. A person using the agent reads a page, answers a question, comes back
 * - and the first plan after that pays a full model load. Measured on a real
 * amazon.in run: that step took 8,227 ms against ~1,500 ms warm, and
 * `/api/ps` afterwards listed nothing resident. The extension could only say
 * "waiting"; the fix lives here.
 *
 * DOCUMENTED OLLAMA BEHAVIOUR, not a trick: `POST /api/generate` with a model
 * and no prompt loads it, and `keep_alive` sets how long it stays loaded after
 * that request. The OpenAI-compatible endpoint the planner uses applies the
 * server default instead, so each plan would reset the timer to five minutes -
 * which is why `start()` repeats this after every plan, not only at startup.
 *
 * THE COST IS VRAM, held for the whole window. CLAUDE.md records that Ollama
 * and the extension's WebGPU vision share one 6 GB GPU; a resident model is
 * what the extension already competes with while a task runs. `VLM_KEEP_ALIVE`
 * shortens or disables it.
 */
export async function keepModelLoaded(
  endpoint: string,
  model: string,
  keepAlive: string,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<KeepAliveResult> {
  const url = ollamaGenerateUrl(endpoint);
  if (url === null) return { ok: false, detail: 'endpoint is not an Ollama-shaped URL' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({ model, keep_alive: keepAlive, stream: false }),
      // A cold load was measured at 34 s on this project's GPU; this must outlast it.
      signal: AbortSignal.timeout(120_000),
    });
    await res.text();
    if (res.status !== 200) return { ok: false, detail: `/api/generate returned ${String(res.status)}` };
    return { ok: true, detail: `resident for ${keepAlive} after each plan` };
  } catch {
    return { ok: false, detail: 'could not reach /api/generate' };
  }
}

/** The keep-alive closure for an explicit endpoint, or null when there is nothing to ask. */
function keepAliveFor(
  endpoint: string,
  model: string,
  key: string | null,
  env: NodeJS.ProcessEnv,
): (() => Promise<KeepAliveResult>) | null {
  if (ollamaGenerateUrl(endpoint) === null) return null;
  const { value } = parseKeepAlive(env['VLM_KEEP_ALIVE']);
  if (value === null) return null;
  return () => keepModelLoaded(endpoint, model, value, key);
}

/**
 * Opt-in: every plan IN FULL, as JSON lines under `AGENT_TRACE_DIR`.
 *
 * The prompt exactly as the model received it, the raw reply, the correction
 * if there was one, and the timings - the whole of what is needed to answer
 * "why did it do that" without re-running anything. It is what the amazon.in
 * run that typed, re-typed and aborted needed and did not have.
 *
 * OFF unless set, and it should stay off on a hosted deployment. The prompt is
 * the SANITIZED context - PII already replaced by placeholders - but it is still
 * a record of which pages a user visited and what was on them, and a trace
 * directory is exactly the kind of file that outlives the reason it was made.
 * The screenshot is recorded by size only; the pixels are never written.
 */
export function planTracer(dir: string | undefined): ((event: PlanEvent) => void) | null {
  const root = (dir ?? '').trim();
  if (root === '') return null;
  mkdirSync(root, { recursive: true });
  return (event) => {
    const req = (typeof event.request === 'object' && event.request !== null
      ? event.request
      : {}) as Partial<PlanRequest>;
    let prompt: string | null = null;
    if (event.outcome.ok && req.context !== undefined) {
      try {
        prompt = renderPrompt(req.context, req.correction);
      } catch {
        prompt = null;
      }
    }
    const shot = req.context?.screenshot ?? null;
    const record = {
      at: new Date().toISOString(),
      model: event.outcome.ok ? event.outcome.response.modelId : null,
      ms: event.ms,
      serverMs: event.outcome.ok ? event.outcome.response.serverMs : null,
      bytes: event.bytes,
      image: shot === null ? null : { format: shot.format, base64Chars: shot.base64.length },
      correction: typeof req.correction === 'string' ? req.correction : null,
      prompt,
      raw: event.outcome.ok ? event.outcome.response.raw : null,
      error: event.outcome.ok ? null : event.outcome.error.error,
    };
    const day = record.at.slice(0, 10);
    appendFileSync(join(root, `plans-${day}.jsonl`), `${JSON.stringify(record)}\n`);
  };
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
  /**
   * Asks how many tokens the endpoint will actually accept. Null for the
   * baseline, which has no window and no endpoint.
   *
   * A CLOSURE for the same reason `verify` is one: it needs the key, and a key
   * on this object would put it in `JSON.stringify(choice)`.
   */
  readonly contextWindow: (() => Promise<ContextWindow>) | null;
  /**
   * Loads the model and keeps it resident. Null unless the endpoint is
   * Ollama-shaped and `VLM_KEEP_ALIVE` is not off. A closure for the same reason
   * `verify` is one.
   */
  readonly keepAlive: (() => Promise<KeepAliveResult>) | null;
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
  /*
   * How hard the model may think. Output tokens cost several times input on
   * every current model, and reasoning bills as output - so this is the largest
   * single lever on what a step costs. `low` is the default; set `none` to turn
   * it off entirely, or `medium`/`high` if a page defeats the baseline.
   */
  const reasoning = (env['VLM_REASONING'] ?? '').trim();
  /*
   * `off` MEANS OMIT THE FIELD, and until it existed there was no way to say so.
   *
   * `VlmPlanner` documents `reasoningEffort: null` as "send nothing, which is
   * how an endpoint that rejects the field is served" - and that value was
   * unreachable from here. Unset produced `undefined`, which the planner turns
   * into its `low` default; every other spelling was passed through as a value.
   * So the one configuration an endpoint like Ollama needs could not be
   * expressed, and the escape hatch was decorative.
   *
   * `none` is NOT the same thing and both are kept. `none` is a VALUE the
   * provider is asked to honour - Google maps it onto Gemini's thinking config,
   * and Ollama happens to accept it - whereas `off` means the parameter never
   * appears in the body at all. An endpoint that 400s on the field's mere
   * presence is served only by the second.
   */
  const reasoningOff = /^(off|omit|unset)$/i.test(reasoning);
  /*
   * Three states, and the empty one is not the same as either other.
   *
   *   unset  -> {}                          the planner applies its `low` default
   *   off    -> { reasoningEffort: null }   the field is omitted from the body
   *   value  -> { reasoningEffort: value }  sent as given
   */
  const reasoningSpread: { reasoningEffort?: 'low' | null } = reasoningOff
    ? { reasoningEffort: null }
    : reasoning === ''
      ? {}
      : { reasoningEffort: reasoning as 'low' };
  /*
   * `VLM_MAX_TOKENS`, because this is the knob that actually bit.
   *
   * On a reasoning model the completion budget covers the thinking AND the
   * answer, so a limit sized for "one small JSON object" starves the answer. A
   * real Gemini run came back cut mid-string at 46 characters. The default is
   * now generous; this exists so a deployment that changes model or reasoning
   * level can be retuned without a code change.
   *
   * Bounded on both sides: a value that cannot hold an action is worse than the
   * default, and an unbounded one hands a rambling model the whole bill.
   */
  const maxTokensRaw = Number.parseInt((env['VLM_MAX_TOKENS'] ?? '').trim(), 10);
  const maxTokens = Number.isFinite(maxTokensRaw)
    ? Math.min(8192, Math.max(128, maxTokensRaw))
    : undefined;
  const explicitKey = env['VLM_API_KEY'];
  const openaiKey = env['OPENAI_API_KEY'];
  /*
   * Google AI Studio. Both spellings, because the console calls it a "Gemini
   * API key" and half the ecosystem's tooling exports it as GOOGLE_API_KEY -
   * accepting one and silently ignoring the other is a deployment that runs the
   * heuristic baseline while looking configured.
   */
  const geminiKey = env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'];

  const nonEmpty = (v: string | undefined): string | null =>
    v === undefined || v.trim() === '' ? null : v.trim();

  const endpointSet = nonEmpty(endpoint);
  const modelSet = nonEmpty(model);
  const key = nonEmpty(explicitKey) ?? nonEmpty(geminiKey) ?? nonEmpty(openaiKey);

  if (endpointSet !== null && modelSet !== null) {
    return {
      planner: new VlmPlanner({
        endpoint: endpointSet,
        model: modelSet,
        apiKey: key,
        ...(reasoningSpread as { reasoningEffort?: 'low' | null }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
      // The KEY ITSELF is never included, only whether one is in use.
      description: `${modelSet} at ${endpointSet}${key === null ? ' (no auth)' : ' (authenticated)'}`,
      vlm: true,
      model: modelSet,
      endpoint: endpointSet,
      verify: () => verifyModel(endpointSet, modelSet, key),
      contextWindow: () => probeContextWindow(endpointSet, modelSet, key),
      keepAlive: keepAliveFor(endpointSet, modelSet, key, env),
    };
  }

  /*
   * GEMINI IS CHECKED BEFORE OPENAI, and the order is deliberate rather than
   * alphabetical: a machine with both keys exported has almost always just
   * moved to the newer one, and the startup log names which provider answered
   * so the choice is never a guess. An explicit `VLM_ENDPOINT` still wins over
   * both - naming an endpoint is the least ambiguous thing an operator can do.
   */
  if (nonEmpty(geminiKey) !== null) {
    const chosen = modelSet ?? DEFAULT_GEMINI_MODEL;
    const where = endpointSet ?? GEMINI_ENDPOINT;
    return {
      planner: new VlmPlanner({
        endpoint: where,
        model: chosen,
        apiKey: nonEmpty(geminiKey),
        ...(reasoningSpread as { reasoningEffort?: 'low' | null }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
      description: `${chosen} at ${where} (authenticated)`,
      vlm: true,
      model: chosen,
      endpoint: where,
      verify: () => verifyModel(where, chosen, nonEmpty(geminiKey)),
      contextWindow: () => probeContextWindow(where, chosen, nonEmpty(geminiKey)),
      keepAlive: null,
    };
  }

  if (nonEmpty(openaiKey) !== null) {
    const chosen = modelSet ?? DEFAULT_OPENAI_MODEL;
    return {
      planner: new VlmPlanner({
        endpoint: endpointSet ?? OPENAI_ENDPOINT,
        model: chosen,
        apiKey: nonEmpty(openaiKey),
        ...(reasoningSpread as { reasoningEffort?: 'low' | null }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
      description: `${chosen} at ${endpointSet ?? OPENAI_ENDPOINT} (authenticated)`,
      vlm: true,
      model: chosen,
      endpoint: endpointSet ?? OPENAI_ENDPOINT,
      verify: () => verifyModel(endpointSet ?? OPENAI_ENDPOINT, chosen, nonEmpty(openaiKey)),
      contextWindow: () =>
        probeContextWindow(endpointSet ?? OPENAI_ENDPOINT, chosen, nonEmpty(openaiKey)),
      keepAlive: null,
    };
  }

  return {
    planner: new HeuristicPlanner(),
    description:
      'HeuristicPlanner (no model). Set GEMINI_API_KEY or OPENAI_API_KEY, or VLM_ENDPOINT + VLM_MODEL, to use a real VLM.',
    vlm: false,
    model: null,
    endpoint: null,
    verify: null,
    contextWindow: null,
    keepAlive: null,
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
 * The token window the endpoint reported, or null for "not known".
 *
 * Same shape and same reasoning as `modelVerified` above: filled in by a probe
 * that runs after `listen`, read by /health, and `null` until answered - which
 * for most endpoints is forever, because only Ollama can be asked.
 */
let contextWindowTokens: number | null = null;

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
  const keepAliveSetting = parseKeepAlive(process.env['VLM_KEEP_ALIVE']);
  const trace = planTracer(process.env['AGENT_TRACE_DIR']);
  // Set by the startup preload. Pings after a plan happen only once that has
  // worked, so an endpoint without /api/generate costs one failed request total.
  let keepAliveWorks = false;

  createAgentServer({
    planner: choice.planner,
    description: choice.description,
    authToken,
    vlm: choice.vlm,
    model: choice.model,
    modelVerified: () => modelVerified,
    contextWindow: () => contextWindowTokens,
    onPlan: (event) => {
      console.log(summarisePlan(event));
      trace?.(event);
      // Fire-and-forget: the OpenAI-compatible call just reset Ollama's timer to
      // its default, so this sets it back. See `keepModelLoaded`.
      if (keepAliveWorks && choice.keepAlive !== null) void choice.keepAlive();
    },
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

    /*
     * THE SAME BARGAIN AS THE MODEL CHECK, for the failure that is quieter.
     *
     * A wrong model id fails loudly on the first plan. A prompt larger than the
     * served context window does not fail at all - Ollama and llama.cpp truncate
     * it and the model answers, so the run completes, the panel reports success,
     * and the action is about a page the model saw half of. There is nothing in
     * any log to look at.
     *
     * So it is asked once, here, and reported in a line that names the number
     * beside the client's own default - because the two being far apart is the
     * whole problem and neither is meaningful alone.
     */
    if (choice.contextWindow !== null) {
      void choice.contextWindow().then((result) => {
        contextWindowTokens = result.tokens;
        if (result.tokens === null) {
          console.log(`[agent-server] context window: UNKNOWN (${result.detail})`);
          return;
        }
        console.log(`[agent-server] context window: ${String(result.tokens)} tokens`);
        /*
         * 30,000 is `DEFAULT_BUDGET_POLICY.maxPromptTokens` in the extension.
         * Hard-coded rather than imported: `contracts` is extension code and
         * this is the server, and a cross-boundary import for one number is a
         * worse trade than a number that can drift. The client sends its real
         * budget in `context.budget.tokenBudget`, which is what actually
         * matters; this is a startup hint, not a check.
         */
        if (result.tokens < 30_000) {
          console.log(
            `[agent-server] the extension's default budget is 30,000 prompt tokens and this ` +
              `endpoint serves ${String(result.tokens)}, so a current extension will clamp ` +
              'itself to fit. Raise num_ctx to send more of the page; an over-long prompt ' +
              'would be TRUNCATED here rather than refused.',
          );
        }
      });
    }

    if (keepAliveSetting.problem !== null) {
      console.warn(`[agent-server] VLM_KEEP_ALIVE ${keepAliveSetting.problem}`);
    }
    if (choice.keepAlive !== null) {
      const t0 = Date.now();
      console.log('[agent-server] loading the model into memory so the first plan is warm...');
      void choice.keepAlive().then((result) => {
        keepAliveWorks = result.ok;
        console.log(
          result.ok
            ? `[agent-server] model resident after ${String(Date.now() - t0)} ms; ${result.detail} (VLM_KEEP_ALIVE)`
            : `[agent-server] keep-alive unavailable (${result.detail}); the model will unload when the endpoint decides`,
        );
      });
    }
    if (trace !== null) {
      console.log(
        `[agent-server] TRACE ON: every prompt and reply is appended under ${String(process.env['AGENT_TRACE_DIR'])}`,
      );
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
