import { beforeAll, describe, expect, it } from 'vitest';
import { modelCatalogueUrl, selectPlanner, verifyModel } from '../../server/main.ts';
import { VlmPlanner } from '@/agent-server/server/vlm-planner.ts';
import { bakeRedactions, createImage } from '@/redaction/index.ts';
import { ensureDomParser, runPipeline } from '@/harness/index.ts';

/**
 * Which model runs, and what actually reaches it.
 *
 * The model id is configuration - a string somebody typed into Render. Nothing
 * in this repo can confirm a provider's catalogue from source, so the questions
 * this file answers are the ones that ARE answerable here: does the configured
 * id survive unchanged all the way to the request body, does the image that goes
 * with it come from the redaction pipeline, and does anything raw come with it.
 *
 * NO REAL CREDENTIAL APPEARS HERE and none is needed. Every request is served by
 * an injected transport; nothing in this file reaches the network.
 */

const FAKE_KEY = 'sk-test-not-a-real-key-000000000000';
const MODEL = 'gpt-5.6-luna';
const OPENAI = 'https://api.openai.com/v1/chat/completions';

beforeAll(async () => {
  await ensureDomParser();
});

// --- the default -------------------------------------------------------------

describe('the configured model', () => {
  it('defaults to gpt-5.6-luna when only a key is set', () => {
    const choice = selectPlanner({ OPENAI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(choice.model).toBe(MODEL);
    expect(choice.vlm).toBe(true);
  });

  it('NEVER substitutes another model', () => {
    /*
     * The rule the whole configuration rests on. If an unrecognised or
     * unreachable id could quietly become a different one, a typo would produce
     * a working demo powered by something nobody chose - and every receipt line
     * naming the model would be wrong while looking right.
     */
    for (const env of [
      { OPENAI_API_KEY: FAKE_KEY },
      { OPENAI_API_KEY: FAKE_KEY, VLM_MODEL: MODEL },
      { VLM_ENDPOINT: OPENAI, VLM_MODEL: MODEL, VLM_API_KEY: FAKE_KEY },
    ]) {
      const choice = selectPlanner(env as NodeJS.ProcessEnv);
      expect(choice.model).toBe(MODEL);
      expect(JSON.stringify(choice)).not.toContain('gpt-4o');
    }
  });

  it('holds the key in a CLOSURE, so the choice stays safe to log whole', () => {
    /*
     * `description` reaches the startup log and the unauthenticated /health, and
     * the object itself is the kind of thing that ends up in a console.log while
     * debugging. An `apiKey` FIELD here would have leaked through
     * JSON.stringify - the existing deployment test caught exactly that.
     */
    const choice = selectPlanner({ OPENAI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(choice.endpoint).toBe(OPENAI);
    expect(choice.description).not.toContain(FAKE_KEY);
    expect(choice.description).not.toContain('sk-');

    // The whole object, not just the description.
    expect(JSON.stringify(choice)).not.toContain(FAKE_KEY);
    expect(Object.values(choice)).not.toContain(FAKE_KEY);

    // The closure still works - the key is reachable to the prober and nowhere
    // else. A property that is unreachable AND non-functional is not a win.
    expect(typeof choice.verify).toBe('function');
  });
});

// --- what actually leaves the server ----------------------------------------

describe('the request that leaves the server', () => {
  it('names the configured model and carries the BAKED screenshot as an image', async () => {
    /*
     * The far end of the chain this project exists to make safe. Everything
     * upstream already ran in the browser; this asserts what the server finally
     * puts on the wire.
     *
     * Four things at once, because they are only meaningful together: the
     * configured model, an image part, the sanitized text, and the ABSENCE of
     * anything raw.
     */
    let sent: Record<string, unknown> | null = null;
    const planner = new VlmPlanner({
      endpoint: OPENAI,
      model: MODEL,
      apiKey: FAKE_KEY,
      transport: (req) => {
        sent = req.body as Record<string, unknown>;
        return Promise.resolve({
          choices: [{ message: { content: '{"type":"done","summary":"ok"}' } }],
        });
      },
    });

    /*
     * Minted the ONLY way it can be: through `bakeRedactions`, over an RGBA
     * buffer, with an injected encoder. `BakedScreenshot` is nominal and this is
     * its sole constructor, so an image reaching the request at all is an image
     * that went through the redaction path.
     */
    const { screenshot: baked } = bakeRedactions(createImage(8, 8), [], () => ({
      base64: 'REDACTEDPIXELS',
      format: 'jpeg',
    }));

    const base = runPipeline('checkout', { goal: 'pay the invoice' }).context;
    const context = { ...base, screenshot: baked } as typeof base;

    await planner.plan(context);

    expect(sent).not.toBeNull();
    const body = sent as unknown as {
      model: string;
      messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[];
    };

    // 1. The configured model, verbatim.
    expect(body.model).toBe(MODEL);

    const parts = body.messages[0]?.content ?? [];
    const image = parts.find((p) => p.type === 'image_url');
    const text = parts.find((p) => p.type === 'text');

    // 2. An image part exists, and it is the baked one.
    expect(image).toBeDefined();
    expect(image?.image_url?.url ?? '').toContain('REDACTEDPIXELS');

    // 3. The sanitized context is there as text. The goal is USER-authored.
    expect(text?.text ?? '').toContain('pay the invoice');

    /*
     * 4. THE ASSERTION THAT MATTERS. The checkout fixture's card number and
     * email are the literals its truth file names. Neither may appear anywhere
     * in the outgoing body - not in the prompt, not in an element name, not in
     * a value. Nor may the key, which travels as a header.
     */
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain('4111111111111111');
    expect(wire).not.toContain('ada@example.com');
    expect(wire).not.toContain(FAKE_KEY);
  });

  it('sends no image when the context has none, rather than reaching for one', async () => {
    /*
     * The visible consequence of the fail-closed screenshot path. A step whose
     * image was refused upstream - uncovered redactions, ops that did not land -
     * plans TEXT-ONLY. It must not capture a second frame to make up for it,
     * which would be the exact bypass the architecture forbids.
     */
    let sent: Record<string, unknown> | null = null;
    const planner = new VlmPlanner({
      endpoint: OPENAI,
      model: MODEL,
      apiKey: FAKE_KEY,
      transport: (req) => {
        sent = req.body as Record<string, unknown>;
        return Promise.resolve({
          choices: [{ message: { content: '{"type":"done","summary":""}' } }],
        });
      },
    });

    const context = runPipeline('login-form', { goal: 'sign in' }).context;
    expect(context.screenshot).toBeNull();
    await planner.plan(context);

    const body = sent as unknown as { messages: { content: { type: string }[] }[] };
    expect(body.messages[0]?.content.some((p) => p.type === 'image_url')).toBe(false);
  });
});

// --- verification ------------------------------------------------------------

describe('verifyModel asks rather than assumes', () => {
  it('derives the catalogue URL from a chat-completions endpoint', () => {
    expect(modelCatalogueUrl(OPENAI, MODEL)).toBe(`https://api.openai.com/v1/models/${MODEL}`);
    // An endpoint with no /chat/completions cannot be derived from, and says so
    // rather than guessing a path whose 404 would read as a missing model.
    expect(modelCatalogueUrl('https://weird.example/generate', 'm')).toBeNull();
  });

  it('reports 200 as verified, and 404 as NOT FOUND only once corroborated', async () => {
    /*
     * The 404 arm needs the catalogue LIST to answer 200, because a bare 404
     * proves nothing: Google returns it unauthenticated for real ids, fake ids
     * and the list alike. See the corroboration tests below for the measurement.
     */
    const reply = (status: number): typeof fetch =>
      (() => Promise.resolve(new Response('{}', { status }))) as unknown as typeof fetch;

    expect((await verifyModel(OPENAI, MODEL, FAKE_KEY, reply(200))).verified).toBe(true);

    const corroborating = ((url: string) =>
      Promise.resolve(
        url.endsWith('/models')
          ? new Response('{"data":[]}', { status: 200 })
          : new Response('{}', { status: 404 }),
      )) as unknown as typeof fetch;

    const missing = await verifyModel(OPENAI, 'nope', FAKE_KEY, corroborating);
    expect(missing.verified).toBe(false);
    expect(missing.detail).toContain('nope');
  });

  it('reports UNKNOWN - never false - when it could not ask', async () => {
    /*
     * The distinction that keeps this from doing harm. A rejected key, an
     * offline host and a provider with no catalogue all mean "we do not know",
     * and reporting any of them as `false` would tell somebody their correct
     * model id is wrong.
     */
    const badKey = await verifyModel(OPENAI, MODEL, 'bad', (() =>
      Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof fetch);
    expect(badKey.verified).toBeNull();

    const offline = await verifyModel(OPENAI, MODEL, FAKE_KEY, (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch);
    expect(offline.verified).toBeNull();

    expect((await verifyModel('https://weird.example/generate', 'm', null)).verified).toBeNull();
  });

  it('sends the key as a header, never in the URL', async () => {
    let seenUrl = '';
    let seenAuth = '';
    await verifyModel(OPENAI, MODEL, FAKE_KEY, ((url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>)['authorization'] ?? '';
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch);

    expect(seenUrl).not.toContain(FAKE_KEY);
    expect(seenAuth).toBe(`Bearer ${FAKE_KEY}`);
  });
});

describe('a 429 is two different situations', () => {
  it('treats an exhausted balance as NON-retryable and says so plainly', async () => {
    /*
     * OpenAI returns 429 for rate limiting AND for an empty balance, and they
     * are opposites. Rate limiting clears on its own; a balance does not clear
     * until somebody pays, so every retry is another failed step.
     *
     * Observed verbatim in a real run, buried on the fourth line of a JSON blob:
     *   "You have no credits remaining." / "code": "credit_balance_exhausted"
     */
    const { ModelEndpointError } = await import('@/agent-server/server/vlm-planner.ts');
    const body =
      '{ "error": { "message": "You have no credits remaining.", "type": "insufficient_quota", "code": "credit_balance_exhausted" } }';

    const quota = new ModelEndpointError(429, body);
    expect(quota.retryable).toBe(false);
    // The useful sentence is now first, not fourth.
    expect(quota.message).toMatch(/^the model provider has no credits remaining/);
    // The provider's own text is still carried - losing it turns a five-second
    // fix into a hunt.
    expect(quota.message).toContain('credit_balance_exhausted');
  });

  it('still treats a genuine rate limit as retryable', async () => {
    const { ModelEndpointError } = await import('@/agent-server/server/vlm-planner.ts');
    const limited = new ModelEndpointError(429, '{"error":{"code":"rate_limit_exceeded"}}');
    expect(limited.retryable).toBe(true);
  });
});

describe('token cost levers', () => {
  it('sends reasoning_effort low by default - output tokens cost several times input', async () => {
    /*
     * THE DOMINANT COST VARIABLE, and nothing was setting it. Reasoning tokens
     * bill as OUTPUT, and on gpt-5.6-luna output is $1.20/MTok against $0.20 in
     * - six to one. A request whose visible answer is a 40-token JSON object
     * can cost more in invisible reasoning than in its entire 2,200-token
     * prompt.
     *
     * `low` because of what the task is: pick one ref from a list the client
     * already ranked, deduplicated and budgeted, and name one verb from a
     * ten-item vocabulary.
     */
    let sent: Record<string, unknown> | null = null;
    const planner = new VlmPlanner({
      endpoint: OPENAI,
      model: MODEL,
      apiKey: FAKE_KEY,
      transport: (req) => {
        sent = req.body as Record<string, unknown>;
        return Promise.resolve({ choices: [{ message: { content: '{"type":"done","summary":""}' } }] });
      },
    });
    await planner.plan(runPipeline('login-form', { goal: 'sign in' }).context);
    expect((sent as unknown as { reasoning_effort?: string }).reasoning_effort).toBe('low');
  });

  it('omits the field entirely when explicitly null, for endpoints that reject it', async () => {
    // vLLM, Ollama and llama.cpp do not all know this field. An unknown key is
    // a 400 on some of them, so "send nothing" has to be expressible.
    let sent: Record<string, unknown> | null = null;
    const planner = new VlmPlanner({
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5vl:3b',
      apiKey: null,
      reasoningEffort: null,
      transport: (req) => {
        sent = req.body as Record<string, unknown>;
        return Promise.resolve({ choices: [{ message: { content: '{"type":"done","summary":""}' } }] });
      },
    });
    await planner.plan(runPipeline('login-form', { goal: 'sign in' }).context);
    expect(Object.keys(sent as unknown as object)).not.toContain('reasoning_effort');
  });

  it('keeps the prompt prefix free of per-step values, so a cache can hold it', async () => {
    /*
     * The redaction COUNTS used to sit in the preamble, directly after the
     * static rules - and they change every step. That put a volatile string at
     * ~925 tokens, so the byte-identical prefix two steps of one task share
     * ended there, and no provider that discounts a repeated prefix could match
     * more than that.
     *
     * The legend is static and stays up top; the counts describe THIS page and
     * moved inside the fence with the rest of the page data.
     */
    const { renderPrompt, FENCE_OPEN } = await import('@/agent-server/index.ts');
    const a = runPipeline('checkout', { goal: 'pay' }).context;
    const b = runPipeline('profile-pii', { goal: 'pay' }).context;

    const prefixOf = (p: string): string => p.slice(0, p.indexOf(FENCE_OPEN));
    // Two DIFFERENT pages, same task shape: the preamble must be identical.
    expect(prefixOf(renderPrompt(a))).toBe(prefixOf(renderPrompt(b)));
    // And it must still carry the rules the model needs.
    expect(prefixOf(renderPrompt(a))).toContain('REDACTION SCHEME');
    // The volatile counts moved into the fenced page data.
    expect(renderPrompt(a)).toMatch(/redacted: .*session nonce/);
  });
});

// --- Google AI Studio --------------------------------------------------------

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

describe('Google AI Studio', () => {
  it('picks Gemini from GEMINI_API_KEY alone, on the OpenAI-compatible endpoint', () => {
    const choice = selectPlanner({ GEMINI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(choice.vlm).toBe(true);
    expect(choice.endpoint).toBe(GEMINI);
    expect(choice.model).toBe('gemini-3.5-flash-lite');
  });

  it('accepts GOOGLE_API_KEY as the same variable', () => {
    /*
     * The console calls it a "Gemini API key" and half the ecosystem's tooling
     * exports GOOGLE_API_KEY. Accepting one and ignoring the other produces a
     * deployment that runs the heuristic baseline while looking configured -
     * the most likely first-run mistake and the least visible one.
     */
    const a = selectPlanner({ GEMINI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    const b = selectPlanner({ GOOGLE_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(b.endpoint).toBe(a.endpoint);
    expect(b.model).toBe(a.model);
  });

  it('prefers Gemini over OpenAI when both keys are present, and says so', () => {
    const choice = selectPlanner({
      GEMINI_API_KEY: FAKE_KEY,
      OPENAI_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv);
    expect(choice.endpoint).toBe(GEMINI);
    // The startup log and /health both carry this, so which provider answered
    // is never a guess.
    expect(choice.description).toContain('generativelanguage.googleapis.com');
  });

  it('lets an explicit VLM_ENDPOINT beat both keys', () => {
    const choice = selectPlanner({
      GEMINI_API_KEY: FAKE_KEY,
      VLM_ENDPOINT: 'http://192.168.1.20:8000/v1/chat/completions',
      VLM_MODEL: 'qwen2.5-vl',
    } as NodeJS.ProcessEnv);
    expect(choice.endpoint).toBe('http://192.168.1.20:8000/v1/chat/completions');
  });

  it('never puts a Google key in the description or anywhere enumerable', () => {
    const choice = selectPlanner({ GEMINI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(choice.description).not.toContain(FAKE_KEY);
    expect(JSON.stringify(choice)).not.toContain(FAKE_KEY);
    expect(Object.values(choice)).not.toContain(FAKE_KEY);
  });

  it('derives the catalogue URL Google actually serves', () => {
    // Verified against the live host: this exact path answers, and the sibling
    // /models list is what the corroboration below calls.
    expect(modelCatalogueUrl(GEMINI, 'gemini-3.5-flash-lite')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-3.5-flash-lite',
    );
  });
});

describe('a 404 from the model catalogue is corroborated, not believed', () => {
  it('reports UNKNOWN when the catalogue list also refuses', async () => {
    /*
     * MEASURED against the live host. Unauthenticated, Google answers 404 to
     * the catalogue list, to a real model id, and to
     * `definitely-not-a-real-model-xyz` alike - all with the identical body
     * "Requested entity was not found.". So a missing or rejected key is
     * indistinguishable from a missing model, and believing the 404 would tell
     * somebody to fix VLM_MODEL when the problem is their API key.
     */
    const calls: string[] = [];
    const fake = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('{"error":{"code":404}}', { status: 404 }));
    }) as unknown as typeof fetch;

    const r = await verifyModel(GEMINI, 'gemini-3.5-flash-lite', FAKE_KEY, fake);
    expect(r.verified).toBeNull();
    expect(r.detail).toMatch(/credential/i);
    // It asked the specific model FIRST, then the list - one extra request, and
    // only on the 404 path.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
  });

  it('reports NOT FOUND only when the catalogue list answers 200', async () => {
    // The list answering proves the credential works, so a 404 on the specific
    // id is then genuinely "no such model" and worth saying plainly.
    const fake = ((url: string) =>
      Promise.resolve(
        url.endsWith('/models')
          ? new Response('{"data":[]}', { status: 200 })
          : new Response('{}', { status: 404 }),
      )) as unknown as typeof fetch;

    const r = await verifyModel(GEMINI, 'nope', FAKE_KEY, fake);
    expect(r.verified).toBe(false);
    expect(r.detail).toContain('nope');
  });

  it('still reports verified on a 200, with no second request', async () => {
    const calls: string[] = [];
    const fake = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const r = await verifyModel(GEMINI, 'gemini-3.5-flash-lite', FAKE_KEY, fake);
    expect(r.verified).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
