import type { SanitizedContext } from '@/contracts/index.ts';
import { renderPrompt } from '../prompt.ts';
import type { Planner } from './planner.ts';

/**
 * The server-side model adapter.
 *
 * Speaks the OpenAI chat-completions shape, which is not a preference for
 * OpenAI - it is the de-facto interface that vLLM, Ollama, llama.cpp's server,
 * Together, Groq and OpenRouter all expose. That means one adapter serves both
 * halves of the brief: an offline-deployable open-weights model behind vLLM or
 * Ollama for the real deliverable, and a cloud-hosted instance of the same
 * weights during the hackathon.
 *
 * MULTIMODAL WHEN THERE IS SOMETHING TO SEE. If the sanitized context carries a
 * baked screenshot, it goes as an image part and the model is a VLM; otherwise
 * the request is text-only. That distinction is the point of the whole project:
 * the image the server receives has already had its pixels redacted on the
 * client, and `BakedScreenshot` is a type only `bakeRedactions()` can mint, so
 * there is no path that sends an unredacted frame here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: trust the model. It returns the raw string
 * exactly as it arrived. Parsing, validation, and the ref allowlist all happen on
 * the CLIENT, in `parseAction` + `validateAction`, precisely because the server
 * is the part that could be compromised. A planner that returned a typed Action
 * would move that decision to the wrong side of the trust boundary.
 *
 * NO SECRETS HERE. The endpoint, model id and key are all constructor arguments;
 * `server/main.ts` reads them from the environment. A test asserts the repo
 * contains no baked-in credentials.
 */

/** One message part. Text, or an image the client already redacted. */
type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export interface ChatRequest {
  readonly url: string;
  readonly apiKey: string | null;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

/**
 * Performs the HTTP call. Injected so the planner is testable without a model,
 * and so `node:*` never has to be imported inside `src/`.
 */
export type ChatTransport = (req: ChatRequest) => Promise<unknown>;

export interface VlmPlannerOptions {
  /** Full chat-completions URL, e.g. http://localhost:11434/v1/chat/completions */
  readonly endpoint: string;
  /** Open-weights model id, e.g. qwen2.5-vl:7b or llava:13b. */
  readonly model: string;
  /** Null for a local server that needs no auth, which is the offline case. */
  readonly apiKey?: string | null;
  readonly transport?: ChatTransport;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  /**
   * How hard the model may think before answering, where the endpoint supports it.
   *
   * THIS IS THE DOMINANT COST VARIABLE and nothing was setting it. On a model
   * priced at $0.20 in / $1.20 out per MTok, an output token costs SIX input
   * tokens - and reasoning tokens bill as output. A request whose visible answer
   * is a 40-token JSON object can therefore cost more in invisible reasoning
   * than in the entire 2,200-token prompt.
   *
   * `low` because of what the task actually is: pick one ref from a list that
   * was already ranked, deduplicated and budgeted on the client, and name one
   * verb from a ten-item vocabulary. The hard part - deciding which elements are
   * worth showing - happened before the request left the browser.
   *
   * Sent only when set, and ignored by endpoints that do not know the field, so
   * this stays compatible with vLLM, Ollama and llama.cpp. Google's
   * OpenAI-compatible layer maps it onto Gemini's thinking configuration and
   * documents `minimal` alongside the rest - hence the extra member. Note that
   * Gemini's Pro and 3-series models cannot turn reasoning off at all, so
   * `none` is a request there, not a guarantee.
   */
  readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | null;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * One action is a small object - about 40 tokens - and 160 was set on that
 * reasoning. It is wrong for a REASONING model, and a real Amazon run is how
 * that surfaced.
 *
 * On the OpenAI-compatible surface `max_tokens` bounds the whole completion,
 * and on a model with `reasoning_effort` set that budget covers the INTERNAL
 * reasoning tokens as well as the visible answer. Gemini 3.5 Flash Lite spent
 * most of 160 thinking and the reply was cut mid-string:
 *
 *     {"type":"type","ref":"e12","text":"macbook pro
 *
 * 46 characters, valid as far as it goes, and unparseable. The action itself was
 * RIGHT - the correct ref, the correct verb, the correct text - and the run died
 * on a budget set for a model that does not think before answering.
 *
 * 1024 leaves room for the reasoning and still bounds a rambling model. The
 * original concern stands and is why this is capped at all: every generated
 * token is sustained GPU load on a local deployment, and a model that rambles
 * cannot produce a better action for having done so.
 */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * An upstream model endpoint answered with an error status.
 *
 * A distinct type so `handlePlanRequest` can tell a 401 from a 503. Every
 * exception used to become `retryable: true`, which told the extension to try an
 * invalid API key again - forever, at one step per attempt.
 */
/**
 * A 429 that means "you have no money", not "you are going too fast".
 *
 * OpenAI returns 429 for BOTH, and they are opposite situations. Rate limiting
 * clears on its own and is worth waiting out; an exhausted balance does not
 * clear until somebody pays, and every retry is another failed step in front of
 * whoever is watching. Matched on the machine-readable `code`/`type` fields
 * rather than the prose, which is localised and rewritten.
 */
const QUOTA_EXHAUSTED = /insufficient_quota|credit_balance_exhausted|billing_hard_limit/i;

export class ModelEndpointError extends Error {
  readonly status: number;
  /**
   * Whether another attempt could plausibly succeed.
   *
   * 5xx and a genuine rate-limit 429 are worth retrying. A 4xx is a
   * configuration fault, and so is a 429 carrying a quota code - see above.
   */
  readonly retryable: boolean;

  constructor(status: number, detail: string) {
    const quota = status === 429 && QUOTA_EXHAUSTED.test(detail);
    super(
      quota
        ? // Said plainly and FIRST. The raw provider body follows, but the
          // useful sentence was previously the fourth line of a JSON blob.
          `the model provider has no credits remaining - add billing to the API ` +
          `account and try again (provider said: ${detail})`
        : `model endpoint returned ${String(status)}: ${detail}`,
    );
    this.name = 'ModelEndpointError';
    this.status = status;
    this.retryable = !quota && (status >= 500 || status === 429);
  }
}

/**
 * Masks anything credential-shaped in an upstream error body.
 *
 * WHY THIS IS NOT PARANOIA. The provider's raw response is forwarded to the
 * EXTENSION - `handlePlanRequest` puts the thrown message into `PlanError.error`,
 * which the client renders. A live probe against OpenAI with a bad key returned:
 *
 *   Incorrect API key provided: sk-fake-************************0000
 *
 * OpenAI masked it. That is OpenAI's courtesy, not our guarantee, and this
 * server is meant to work against any OpenAI-compatible endpoint - vLLM, Ollama,
 * llama.cpp, Together, Groq, a proxy somebody wrote in an afternoon. The one
 * that echoes the Authorization header back in a 400 exists, and the first time
 * anyone finds out would be a key in a browser's error list.
 *
 * The detail is still forwarded: a 400 naming a bad model id or an over-length
 * context is what turns a five-second fix into a hunt. Only the key shapes go.
 */
export function maskCredentials(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(api[_-]?key|authorization|token)("?\s*[:=]\s*"?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2***');
}

/** The default transport. `fetch` is global in Node 18+ and in every browser. */
const fetchTransport: ChatTransport = async ({ url, apiKey, body, signal }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    // Body included, MASKED: a 400 from vLLM names the actual problem (bad model
    // id, context too long) and losing it turns a five-second fix into a hunt -
    // but this string is forwarded to the extension, so it goes through
    // `maskCredentials` first.
    const detail = await res.text().catch(() => '');
    throw new ModelEndpointError(res.status, maskCredentials(detail).slice(0, 400));
  }
  return res.json();
};

/**
 * Thrown when the model was cut off mid-answer rather than choosing to stop.
 *
 * A DISTINCT ERROR, because the two produce identical-looking rubbish and need
 * opposite responses. A real run reported `unparseable action: no-json-found (no
 * JSON object in the model output)` over the text
 * `{"type":"type","ref":"e12","text":"macbook pro` - which is a JSON object, and
 * the right one. The provider had already said `finish_reason: "length"`; nobody
 * read it. "The model did not answer in JSON" sends someone to rewrite the
 * prompt; "the reply was cut off" sends them to the token limit, which is where
 * the fault actually was.
 */
export class TruncatedCompletionError extends Error {
  readonly partial: string;
  /**
   * NOT retryable, and that is the same lesson `ModelEndpointError` already
   * learned. The budget does not change between attempts, so the reply is cut at
   * the same place every time. Left retryable it costs one wasted step per step
   * until the loop hits its ceiling, and the user watches eight identical
   * failures instead of one actionable one.
   */
  readonly retryable = false;
  constructor(partial: string) {
    super(
      `the model's reply was cut off at the token limit (finish_reason: length) after ${String(
        partial.length,
      )} characters - raise max_tokens, or lower reasoning_effort so more of the budget reaches the answer`,
    );
    this.name = 'TruncatedCompletionError';
    this.partial = partial;
  }
}

/** Pulls the assistant text out of a chat-completions response. */
export function extractContent(payload: unknown): string {
  const body = payload as {
    choices?: readonly {
      message?: { content?: unknown };
      finish_reason?: unknown;
    }[];
    error?: { message?: unknown };
  } | null;

  if (body === null || typeof body !== 'object') {
    throw new Error('model response was not an object');
  }
  if (body.error !== undefined) {
    const msg = body.error.message;
    throw new Error(`model returned an error: ${typeof msg === 'string' ? msg : 'unknown'}`);
  }

  const choice = body.choices?.[0];
  const truncated = choice?.finish_reason === 'length';

  const content = choice?.message?.content;
  if (typeof content === 'string') {
    /*
     * CHECKED BEFORE RETURNING, not after parsing fails. The text is returned
     * unchanged when the model stopped on its own; when it was cut off, the
     * caller is told THAT rather than being left to infer it from a parse
     * failure that names the wrong cause.
     */
    if (truncated) throw new TruncatedCompletionError(content);
    return content;
  }

  /*
   * Some servers return content as an array of parts rather than a string.
   * Joining the text parts is correct; throwing here would fail against a
   * perfectly good response for a cosmetic difference in shape.
   */
  if (Array.isArray(content)) {
    const joined = content
      .map((p) => (typeof p === 'object' && p !== null ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
    if (joined !== '') {
      if (truncated) throw new TruncatedCompletionError(joined);
      return joined;
    }
  }

  if (truncated) throw new TruncatedCompletionError('');

  throw new Error('model response contained no assistant content');
}

export class VlmPlanner implements Planner {
  readonly id: string;

  readonly #endpoint: string;
  readonly #model: string;
  readonly #apiKey: string | null;
  readonly #transport: ChatTransport;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #reasoningEffort: string | null;
  readonly #now: () => number;

  constructor(options: VlmPlannerOptions) {
    if (options.endpoint === '') throw new Error('VlmPlanner: endpoint is required');
    if (options.model === '') throw new Error('VlmPlanner: model is required');

    this.#endpoint = options.endpoint;
    this.#model = options.model;
    this.#apiKey = options.apiKey ?? null;
    this.#transport = options.transport ?? fetchTransport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    // `undefined` means "use the low default"; an explicit `null` means "send
    // nothing", which is how an endpoint that rejects the field is served.
    this.#reasoningEffort =
      options.reasoningEffort === undefined ? 'low' : options.reasoningEffort;
    this.#now = options.now ?? ((): number => Date.now());

    // Reported back to the client as `modelId` and shown in the panel. The
    // MODEL is the identity that matters for a latency figure, not "vlm".
    this.id = options.model;
  }

  /** The message content: text always, plus the redacted image when there is one. */
  #content(ctx: SanitizedContext, correction?: string): readonly ContentPart[] {
    const parts: ContentPart[] = [];
    const shot = ctx.screenshot;
    if (shot !== null) {
      /*
       * THE IMAGE GOES FIRST, AND THAT ORDER IS LOAD-BEARING.
       *
       * It used to be appended after the text, which put a screenshot of a web
       * page at the very END of the request. On a real Amazon page the model
       * answered:
       *
       *   "The image is a screenshot of the Amazon India website. Here are the
       *    key elements visible in the image: 1. **Header Section**: ..."
       *
       * 621 characters of description and no JSON. A vision model handed a UI
       * screenshot as the last thing it reads does what it was overwhelmingly
       * trained to do with one: caption it.
       *
       * This is the third time in this project that a small model acted on
       * whatever came last - history above the element list was ignored, a
       * correction below it was obeyed. Putting the image first leaves
       * `Respond with one JSON action object.` as the final thing in the
       * request.
       *
       * A data URL, so nothing is uploaded anywhere else and the bytes travel in
       * the same request the text does. These pixels have already been through
       * `bakeRedactions`, which is why `opsApplied` is worth stating in the
       * prompt - the model should know regions were removed rather than guess
       * that the page had blank boxes in it.
       */
      parts.push({
        type: 'image_url',
        image_url: { url: `data:image/${shot.format};base64,${shot.base64}` },
      });
    }
    parts.push({ type: 'text', text: renderPrompt(ctx, correction) });
    return parts;
  }

  async plan(ctx: SanitizedContext, correction?: string): Promise<{ raw: string; serverMs: number }> {
    const started = this.#now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    try {
      const payload = await this.#transport({
        url: this.#endpoint,
        apiKey: this.#apiKey,
        signal: controller.signal,
        body: {
          model: this.#model,
          ...(this.#reasoningEffort === null
            ? {}
            : { reasoning_effort: this.#reasoningEffort }),
          // Deterministic. This is a control loop, not a creative task, and a
          // reproducible action is worth more than a varied one.
          temperature: 0,
          max_tokens: this.#maxTokens,
          messages: [{ role: 'user', content: this.#content(ctx, correction) }],
        },
      });

      // Raw, unparsed, untrusted. The client validates.
      return { raw: extractContent(payload), serverMs: this.#now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
