import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CaptureAdapter, ChromeOffscreenHost, answerOffscreen } from '@/perception/index.ts';
import {
  DOM_REDACT_CMD,
  DOM_SANITIZE_CMD,
  createInProcessDomPipeline,
  createRemoteDomPipeline,
} from '@/redaction/index.ts';
import { type CapturedFrame, type PanelEvent, redactionNonce } from '@/contracts/index.ts';
import { runAgentStep } from '@/orchestrator/index.ts';
import { PROTOCOL_VERSION } from '@/agent-server/index.ts';

/**
 * The Chrome path, end to end: background -> offscreen -> redact -> sanitize ->
 * background.
 *
 * NO `@vitest-environment jsdom` DOCBLOCK, DELIBERATELY. This file runs in the
 * node environment, which has no `DOMParser` - the same condition as Chrome's
 * MV3 service worker. A DOM is installed ONLY for the duration of each offscreen
 * handler call and removed again immediately, which is what makes this a real
 * test of the split rather than a description of it:
 *
 *   - the "background" half (runAgentStep, the remote pipeline, the host) runs
 *     with NO DOMParser in scope. If any of it touched the DOM, it would throw
 *     exactly as Chrome did.
 *   - the "offscreen" half gets a DOM, as the real offscreen document has.
 *
 * The message channel is the only fake. `answerOffscreen` and
 * `ChromeOffscreenHost.request` are the real two halves of the wire protocol,
 * and `createInProcessDomPipeline` is the real redaction path.
 */

const PAGE = `<!doctype html><html><body>
  <h1>Sign in</h1>
  <label for="e">Email</label>
  <input id="e" name="email" value="user@example.com" data-test-rect="10,10,200,20" />
  <button id="go" data-test-rect="10,40,80,24">Sign in</button>
</body></html>`;

const VIEWPORT = { cssWidth: 1280, cssHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 };

type Globals = Record<string, unknown>;

/**
 * Runs `fn` with a DOM present, then removes it again.
 *
 * This is what the offscreen document has and the service worker does not. The
 * removal is the load-bearing half: without it, the background-side code would
 * find a DOMParser lying around and the test would prove nothing.
 */
async function asOffscreenDocument<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Globals;
  const dom = new JSDOM('');
  g['DOMParser'] = (dom.window as unknown as { DOMParser: unknown }).DOMParser;
  try {
    return await fn();
  } finally {
    // ALWAYS removed, never restored to whatever was there. The background half
    // must be DOM-free for this test to mean anything, and the node environment
    // was observed to supply a DOMParser inconsistently - present in one file,
    // absent in another with identical settings. Depending on that would make
    // the test pass for reasons unrelated to the code.
    delete g['DOMParser'];
  }
}

beforeAll(() => {
  // Establish the service-worker condition up front, whatever the environment
  // happened to provide.
  delete (globalThis as unknown as Globals)['DOMParser'];
});

/** The offscreen document's router, composed exactly as its entrypoint does. */
function offscreenDispatch(): (cmd: string, payload: unknown) => Promise<unknown> {
  // MODULE SCOPE in the real entrypoint, and the equivalent here: redact and
  // sanitize share a retained Document addressed by handle, so they must reach
  // the same instance.
  const dom = createInProcessDomPipeline();

  return async (cmd, payload) => {
    if (cmd === DOM_REDACT_CMD) {
      return asOffscreenDocument(() => dom.redact(payload as Parameters<typeof dom.redact>[0]));
    }
    if (cmd === DOM_SANITIZE_CMD) {
      return asOffscreenDocument(() => dom.sanitize(payload as Parameters<typeof dom.sanitize>[0]));
    }
    if (cmd === 'detect') {
      const frame = payload as CapturedFrame;
      return Promise.resolve({
        frameId: frame.frameId,
        detections: [],
        backend: 'stub',
        modelId: 'test',
        timings: { decodeMs: 0, inferMs: 0, postMs: 0, totalMs: 0 },
      });
    }
    if (cmd === 'release') return Promise.resolve({ ok: true });
    throw new Error(`offscreen: unknown command ${cmd}`);
  };
}

/** A ChromeOffscreenHost whose message channel runs the real offscreen answer. */
function wiredHost(): ChromeOffscreenHost {
  const dispatch = offscreenDispatch();
  return new ChromeOffscreenHost({
    offscreen: {
      createDocument: () => Promise.resolve(),
      closeDocument: () => Promise.resolve(),
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://test${p}`,
      // The real producer. Everything the background receives has been through
      // the same envelope the real offscreen document mints.
      sendMessage: (message: unknown) => {
        const msg = message as { cmd: string; payload: unknown };
        return answerOffscreen(msg.cmd, msg.payload, dispatch) as Promise<unknown>;
      },
      getContexts: () => Promise.resolve([{}]),
    },
  });
}

function captureAdapter(): CaptureAdapter {
  return {
    capture: (_tabId, viewport): Promise<CapturedFrame> =>
      Promise.resolve({
        frameId: 'frame-1',
        dataUrl: 'data:image/jpeg;base64,AA==',
        encodedBytes: 4,
        natural: { width: 1280, height: 800 },
        viewport,
        capturedAt: 1_700_000_000_000,
      }),
  };
}

describe('the Chrome DOM path, background -> offscreen -> background', () => {
  it('produces a sanitized context without a DOM on the background side', async () => {
    // Pre-condition. If this is false the test proves nothing, so it is asserted
    // rather than assumed.
    expect('DOMParser' in (globalThis as unknown as Globals)).toBe(false);

    const host = wiredHost();
    const events: PanelEvent[] = [];
    let plannedContextElements = -1;

    const result = await runAgentStep(
      {
        snapshot: () => Promise.resolve({ html: PAGE, viewport: VIEWPORT }),
        capture: captureAdapter(),
        host,
        // The remote pipeline: what background.ts uses on Chrome.
        dom: createRemoteDomPipeline((cmd, payload) => host.request(cmd, payload)),
        client: {
          plan: (req: { context: { elements: unknown[] } }) => {
            plannedContextElements = req.context.elements.length;
            return Promise.resolve({
              ok: true,
              response: {
                protocolVersion: PROTOCOL_VERSION,
                raw: '{"type":"done","summary":"ok"}',
                modelId: 'test',
                serverMs: 1,
              },
            });
          },
        },
        execute: () => Promise.resolve({ ok: true, note: 'done' }),
        emit: (e: PanelEvent) => events.push(e),
      } as unknown as Parameters<typeof runAgentStep>[0],
      {
        tabId: 1,
        taskId: 'task-1',
        step: 1,
        goal: 'sign in',
        url: 'https://example.invalid/login',
        nonce: redactionNonce('a1b2c3d4'),
        salt: 'test-salt',
        allowedOrigins: [],
        captureOptions: { format: 'jpeg', quality: 70, maxEdgePx: 1280 },
      } as unknown as Parameters<typeof runAgentStep>[1],
    );

    if (!result.ok) throw new Error(`step failed at ${result.stage}: ${result.error}`);

    /*
     * The redaction really happened, on the far side, and a real context came
     * back. Before the pipeline existed this died at the redact stage with
     * "DOMParser is not defined" - which is what this whole file is here to stop
     * recurring.
     */
    expect(plannedContextElements).toBeGreaterThan(0);
    expect(result.outcome.context.elements.length).toBeGreaterThan(0);

    // And the DOM did not leak out of the offscreen half.
    expect('DOMParser' in (globalThis as unknown as Globals)).toBe(false);
  });

  it('carries the redaction back across the boundary', async () => {
    // The email in the fixture must come back redacted, which proves the far
    // side did the real work rather than echoing the input.
    const host = wiredHost();
    const result = await runAgentStep(
      {
        snapshot: () => Promise.resolve({ html: PAGE, viewport: VIEWPORT }),
        capture: captureAdapter(),
        host,
        dom: createRemoteDomPipeline((cmd, payload) => host.request(cmd, payload)),
        client: {
          plan: () =>
            Promise.resolve({
              ok: true,
              response: {
                protocolVersion: PROTOCOL_VERSION,
                raw: '{"type":"done","summary":"ok"}',
                modelId: 'test',
                serverMs: 1,
              },
            }),
        },
        execute: () => Promise.resolve({ ok: true, note: 'done' }),
      } as unknown as Parameters<typeof runAgentStep>[0],
      {
        tabId: 1,
        taskId: 't',
        step: 1,
        goal: 'sign in',
        url: 'https://example.invalid/login',
        nonce: redactionNonce('a1b2c3d4'),
        salt: 'test-salt',
        allowedOrigins: [],
        captureOptions: { format: 'jpeg', quality: 70, maxEdgePx: 1280 },
      } as unknown as Parameters<typeof runAgentStep>[1],
    );

    if (!result.ok) throw new Error(`step failed at ${result.stage}: ${result.error}`);

    // THE LEAK CHECK, across the real boundary: the raw address must not be in
    // anything that would leave the machine.
    expect(JSON.stringify(result.outcome.context)).not.toContain('user@example.com');
  });

  it('reports a far-side failure as a staged failure, not a crash', async () => {
    /*
     * The offscreen document answering `ok:false` must surface as a redact-stage
     * failure. This is the path that previously resolved as SUCCESS, because the
     * host cast the envelope straight to the result type.
     */
    const host = new ChromeOffscreenHost({
      offscreen: { createDocument: () => Promise.resolve(), closeDocument: () => Promise.resolve() },
      runtime: {
        getURL: (p: string) => `chrome-extension://test${p}`,
        sendMessage: (message: unknown) => {
          const msg = message as { cmd: string };
          return answerOffscreen(msg.cmd, undefined, () =>
            Promise.reject(new Error('offscreen exploded')),
          ) as Promise<unknown>;
        },
        getContexts: () => Promise.resolve([{}]),
      },
    });

    const result = await runAgentStep(
      {
        snapshot: () => Promise.resolve({ html: PAGE, viewport: VIEWPORT }),
        capture: captureAdapter(),
        host,
        dom: createRemoteDomPipeline((cmd, payload) => host.request(cmd, payload)),
        client: {
          plan: () =>
            Promise.resolve({
              ok: true,
              response: { protocolVersion: PROTOCOL_VERSION, raw: '{}', modelId: 't', serverMs: 0 },
            }),
        },
        execute: () => Promise.resolve({ ok: true, note: '' }),
      } as unknown as Parameters<typeof runAgentStep>[0],
      {
        tabId: 1,
        taskId: 't',
        step: 1,
        goal: 'g',
        url: 'https://example.invalid/',
        nonce: redactionNonce('a1b2c3d4'),
        salt: 's',
        allowedOrigins: [],
        captureOptions: { format: 'jpeg', quality: 70, maxEdgePx: 1280 },
      } as unknown as Parameters<typeof runAgentStep>[1],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/offscreen exploded/);
  });
});
