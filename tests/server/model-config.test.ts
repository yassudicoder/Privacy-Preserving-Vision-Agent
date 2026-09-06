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

  it('reports 200 as verified and 404 as NOT FOUND', async () => {
    const reply = (status: number): typeof fetch =>
      (() => Promise.resolve(new Response('{}', { status }))) as unknown as typeof fetch;

    expect((await verifyModel(OPENAI, MODEL, FAKE_KEY, reply(200))).verified).toBe(true);

    const missing = await verifyModel(OPENAI, 'nope', FAKE_KEY, reply(404));
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
