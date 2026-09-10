import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_ALIVE,
  keepModelLoaded,
  ollamaGenerateUrl,
  parseKeepAlive,
  selectPlanner,
} from '../../server/main.ts';
import { summarisePlan } from '../../server/agent-http.ts';
import { PROTOCOL_VERSION } from '../../src/agent-server/protocol.ts';

const OLLAMA = 'http://127.0.0.1:11434/v1/chat/completions';

/**
 * Keeping a local model resident between plans.
 *
 * From a real amazon.in run: the first plan after the user answered a question
 * took 8,227 ms against ~1,500 ms warm, and Ollama's `/api/ps` afterwards listed
 * nothing loaded. Ollama unloads an idle model after five minutes, and a person
 * reading a page and typing an answer takes longer than that.
 */
describe('keeping a local model resident', () => {
  it('derives the native /api/generate URL only from an Ollama-shaped endpoint', () => {
    expect(ollamaGenerateUrl(OLLAMA)).toBe('http://127.0.0.1:11434/api/generate');
    expect(
      ollamaGenerateUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
    ).toBeNull();
  });

  it('defaults to 30m, treats 0 and off as OFF, and REPORTS a typo instead of replacing it', () => {
    expect(parseKeepAlive(undefined)).toEqual({ value: DEFAULT_KEEP_ALIVE, problem: null });
    expect(parseKeepAlive('2h').value).toBe('2h');
    expect(parseKeepAlive('-1').value).toBe('-1');
    // To Ollama, 0 means "unload after this request" - every plan a cold load.
    for (const off of ['off', 'OFF', '0', 'false']) {
      expect(parseKeepAlive(off)).toEqual({ value: null, problem: null });
    }
    const typo = parseKeepAlive('30 minutes');
    expect(typo.value).toBeNull();
    expect(typo.problem).toMatch(/30 minutes/);
  });

  it('asks /api/generate with the model, the duration and no prompt', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown });
      return new Response('{"done":true,"done_reason":"load"}', { status: 200 });
    }) as typeof fetch;

    const result = await keepModelLoaded(OLLAMA, 'qwen2.5vl-8k:latest', '30m', null, fake);

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      {
        url: 'http://127.0.0.1:11434/api/generate',
        body: { model: 'qwen2.5vl-8k:latest', keep_alive: '30m', stream: false },
      },
    ]);
  });

  it('reports a 404 as unavailable instead of throwing', async () => {
    const fake = (async () => new Response('404 page not found', { status: 404 })) as typeof fetch;
    const result = await keepModelLoaded(OLLAMA, 'm', '30m', null, fake);
    expect(result).toEqual({ ok: false, detail: '/api/generate returned 404' });
  });

  it('is wired for an explicit Ollama endpoint and for nothing else', () => {
    expect(selectPlanner({ VLM_ENDPOINT: OLLAMA, VLM_MODEL: 'm' }).keepAlive).not.toBeNull();
    expect(
      selectPlanner({ VLM_ENDPOINT: OLLAMA, VLM_MODEL: 'm', VLM_KEEP_ALIVE: 'off' }).keepAlive,
    ).toBeNull();
    expect(selectPlanner({ GEMINI_API_KEY: 'not-a-real-key' }).keepAlive).toBeNull();
    expect(selectPlanner({}).keepAlive).toBeNull();
  });
});

describe('one log line per plan, and no page text in it', () => {
  const answered = (raw: string) => ({
    ok: true as const,
    response: { protocolVersion: PROTOCOL_VERSION, raw, modelId: 'm', serverMs: 1516 },
  });

  it('names the verb, the ref and the submit flag', () => {
    const line = summarisePlan({
      request: { context: { elements: [1, 2, 3], screenshot: null } },
      bytes: 49_357,
      ms: 1522,
      outcome: answered('{"type":"type","ref":"e4","text":"iPhone 17 Pro","submit":true}'),
    });
    expect(line).toBe('[plan] 3 el, 48.2 KB, no image -> type e4 +submit (1516 ms model, 1522 ms total)');
  });

  it('never carries what the model typed, summarised or gave as a reason', () => {
    // The line lands in a hosted log store; the context it describes is a
    // user's browsing. The full exchange is AGENT_TRACE_DIR, opted into.
    for (const raw of [
      '{"type":"type","ref":"e4","text":"SECRET-TYPED"}',
      '{"type":"abort","reason":"SECRET-REASON"}',
      '{"type":"done","summary":"SECRET-SUMMARY"}',
      '{"type":"ask_user","question":"SECRET-QUESTION"}',
    ]) {
      expect(summarisePlan({ request: {}, bytes: 10, ms: 1, outcome: answered(raw) })).not.toMatch(/SECRET/);
    }
  });

  it('says UNPARSEABLE rather than guessing a verb', () => {
    const line = summarisePlan({
      request: {},
      bytes: 10,
      ms: 1,
      outcome: answered('The image is a screenshot of the Amazon India website.'),
    });
    expect(line).toMatch(/-> UNPARSEABLE \(no-json-found, \d+ chars\)/);
  });
});

describe('the plan log names a target by its keys, never its values', () => {
  it('logs the tag and which fields were used, and none of the page text', () => {
    const line = summarisePlan({
      request: {},
      bytes: 10,
      ms: 1,
      outcome: {
        ok: true as const,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          raw: '{"type":"click","target":{"tag":"button","text":"SECRET-TEXT","within":"SECRET-CARD"}}',
          modelId: 'm',
          serverMs: 5,
        },
      },
    });
    expect(line).toContain('-> click <button> [text,within]');
    expect(line).not.toMatch(/SECRET/);
  });
});
