import { describe, expect, it } from 'vitest';
import {
  type DomRedactRequest,
  type DomSanitizeRequest,
  DOM_REDACT_CMD,
  DOM_SANITIZE_CMD,
  createInProcessDomPipeline,
  createRemoteDomPipeline,
} from '@/redaction/index.ts';
import { redactionNonce, DEFAULT_BUDGET_POLICY } from '@/contracts/index.ts';

/**
 * The DOM pipeline, tested in a context that has no DOM.
 *
 * WHY THIS FILE EXISTS. `redact()` calls `new DOMParser()`. Chrome's MV3
 * background is a service worker with no DOM, so every Chrome step failed with
 * "redact: DOMParser is not defined", while Firefox - whose background is an
 * event page WITH a DOM - ran the identical code and completed the whole loop.
 * Nothing caught it because every test touching redaction opts into jsdom,
 * `tests/orchestrator/step.test.ts` included. The suite only ever ran this code
 * in an environment resembling the browser where it happened to work.
 *
 * WHY THE GLOBAL IS DELETED EXPLICITLY rather than relying on the environment.
 * The first draft of this file assumed the default node environment has no
 * `DOMParser` and asserted against that. It does not hold reliably: probing it
 * printed `undefined` in one file and `function` in another with identical
 * imports and settings. A guard resting on an ambient property I cannot
 * reproduce is not a guard - this project has shipped four of those already. So
 * the condition under test is created deliberately and restored afterwards,
 * which makes the test say exactly what it means: WITHOUT a DOMParser, this
 * fails loudly.
 */

type Globals = Record<string, unknown>;

/** Runs `fn` with no DOMParser, whatever the ambient environment provides. */
async function withoutDomParser(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as unknown as Globals;
  const had = 'DOMParser' in g;
  const saved = g['DOMParser'];
  delete g['DOMParser'];
  try {
    await fn();
  } finally {
    if (had) g['DOMParser'] = saved;
  }
}

const HTML = '<html><body><button id="go">Search</button></body></html>';

function redactRequest(): DomRedactRequest {
  return {
    handle: 'frame-1',
    html: HTML,
    visionBoxes: [],
    viewport: { cssWidth: 1280, cssHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    nonce: redactionNonce('a1b2c3d4'),
    salt: 'test-salt',
    minConfidence: 0.5,
    frameId: 'frame-1',
    url: 'https://example.invalid/page',
    now: 1_700_000_000_000,
  };
}

function sanitizeRequest(handle = 'frame-1'): DomSanitizeRequest {
  return {
    handle,
    budget: DEFAULT_BUDGET_POLICY,
    viewport: { cssWidth: 1280, cssHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    url: 'https://example.invalid/page',
    taskId: 'task-1',
    step: 1,
    goal: 'search',
    history: [],
    clarifications: [],
    screenshot: null,
  };
}

describe('the in-process pipeline in a context with no DOM', () => {
  it('fails LOUDLY rather than returning an empty result', async () => {
    /*
     * This is the assertion whose absence let the Chrome bug ship. It does not
     * assert that redaction works - it asserts that when it cannot work, the
     * failure is a rejection naming the cause, not a quietly empty context that
     * would sail through sanitize and produce a plan about a page nobody read.
     */
    await withoutDomParser(async () => {
      const pipeline = createInProcessDomPipeline();
      await expect(pipeline.redact(redactRequest())).rejects.toThrow(/DOMParser/);
    });
  });

  it('refuses to sanitize a handle it never redacted', async () => {
    // The second half of the same failure: if redact threw, sanitize must not
    // then invent an empty document.
    const pipeline = createInProcessDomPipeline();
    await expect(pipeline.sanitize(sanitizeRequest())).rejects.toThrow(
      /no redacted document for handle "frame-1"/,
    );
  });
});

describe('the remote pipeline needs no DOM of its own', () => {
  /*
   * The Chrome path. This object is a courier: it must be constructible and
   * callable in a service worker, which is precisely a context without a DOM -
   * so these tests belong in the node environment and would prove nothing under
   * jsdom.
   */

  it('sends redact over the channel and returns the reply unchanged', async () => {
    const sent: { cmd: string; payload: unknown }[] = [];
    const reply = { log: { entries: [] }, detections: [], pixelOps: [] };
    const pipeline = createRemoteDomPipeline((cmd, payload) => {
      sent.push({ cmd, payload });
      return Promise.resolve(reply);
    });

    const out = await pipeline.redact(redactRequest());
    expect(sent[0]?.cmd).toBe(DOM_REDACT_CMD);
    expect(out).toEqual(reply);
  });

  it('sends the HTML as a bare string, because Untrusted cannot be serialised', async () => {
    /*
     * `Untrusted<T>` keeps its payload behind a module-private symbol and symbol
     * keys are not serialised, so `JSON.stringify` of one yields `{}`. Marking
     * the HTML before the hop would deliver an empty object to the offscreen
     * document and redact an empty page - silently, and with a plausible-looking
     * result. The wrapper is applied on ARRIVAL instead.
     */
    let seen: unknown = null;
    const pipeline = createRemoteDomPipeline((_cmd, payload) => {
      seen = payload;
      return Promise.resolve({ log: { entries: [] }, detections: [], pixelOps: [] });
    });

    await pipeline.redact(redactRequest());
    const wire = seen as { html: unknown };
    expect(typeof wire.html).toBe('string');
    // Survives the round trip that a marked value would not.
    expect(JSON.parse(JSON.stringify(wire)) as { html: string }).toHaveProperty('html', HTML);
  });

  it('rebuilds refPaths from entries, because a Map serialises to {}', async () => {
    // Sending a Map would arrive empty and every action would report a miss
    // with no indication why.
    const pipeline = createRemoteDomPipeline(() =>
      Promise.resolve({
        context: { schemaVersion: 1, elements: [] },
        refPaths: [['e1', 'body>button']],
      }),
    );
    const out = await pipeline.sanitize(sanitizeRequest());
    expect(out.refPaths).toEqual([['e1', 'body>button']]);
    expect(new Map(out.refPaths).get('e1')).toBe('body>button');
  });

  it('names the sanitize command', async () => {
    const sent: string[] = [];
    const pipeline = createRemoteDomPipeline((cmd) => {
      sent.push(cmd);
      return Promise.resolve({ context: { schemaVersion: 1 }, refPaths: [] });
    });
    await pipeline.sanitize(sanitizeRequest());
    expect(sent).toEqual([DOM_SANITIZE_CMD]);
  });

  it('propagates a far-side failure instead of swallowing it', async () => {
    const pipeline = createRemoteDomPipeline(() =>
      Promise.reject(new Error('offscreen "dom/redact" failed: boom')),
    );
    await expect(pipeline.redact(redactRequest())).rejects.toThrow(/boom/);
  });
});
