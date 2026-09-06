import { describe, expect, it, vi } from 'vitest';
import {
  type HostSession,
  type OffscreenCapableRuntime,
  answerOffscreen,
  ChromeOffscreenHost,
  FirefoxBackgroundPageHost,
  OFFSCREEN_PATH,
} from '@/perception/index.ts';

/**
 * The host layer, which had no tests at all.
 *
 * This is the seam where the two browsers stop agreeing, so it is exactly where
 * an untested assumption becomes a bug that only reproduces on one of them.
 * Both backends are driven here against fake extension APIs.
 */

// ---------------------------------------------------------------------------
// Firefox: the background page IS the host
// ---------------------------------------------------------------------------

function fakeSession(): { session: HostSession; closed: () => number; calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  let closes = 0;
  return {
    calls,
    closed: () => closes,
    session: {
      dispatch: (cmd, payload) => {
        calls.push([cmd, payload]);
        return Promise.resolve({ ok: true, cmd });
      },
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    },
  };
}

describe('FirefoxBackgroundPageHost keeps the event page alive only while working', () => {
  it('does NOT acquire the keep-alive in the constructor', async () => {
    /*
     * The bug this replaces. The class documents the keep-alive as scoped to an
     * agent session and released on stop(), and warns that "holding it forever
     * would defeat the point of an event page and inflate idle memory, which is
     * 20% of the score" - then acquired it at construction, which background.ts
     * performs at startup. Constructing the host would have pinned the page
     * alive from the moment the extension loaded.
     */
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const f = fakeSession();

    new FirefoxBackgroundPageHost({
      createSession: () => Promise.resolve(f.session),
      keepAlive: acquire,
    });

    expect(acquire).not.toHaveBeenCalled();
  });

  it('acquires on first start and releases on stop', async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({
      createSession: () => Promise.resolve(f.session),
      keepAlive: acquire,
    });

    await host.ensureStarted();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    await host.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('re-acquires for a second session after a stop', async () => {
    // stop() used to release the keep-alive and nothing ever re-acquired it, so
    // every session after the first ran unprotected.
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({
      createSession: () => Promise.resolve(f.session),
      keepAlive: acquire,
    });

    await host.ensureStarted();
    await host.stop();
    await host.ensureStarted();

    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('does not acquire twice for one session', async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({
      createSession: () => Promise.resolve(f.session),
      keepAlive: acquire,
    });

    await host.ensureStarted();
    await host.ensureStarted();
    await host.ensureStarted();
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('works without a keep-alive at all', async () => {
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({ createSession: () => Promise.resolve(f.session) });
    await expect(host.ensureStarted()).resolves.toBeUndefined();
    await expect(host.stop()).resolves.toBeUndefined();
  });
});

describe('FirefoxBackgroundPageHost spawns the worker exactly once', () => {
  it('creates the session lazily, not at construction', async () => {
    const create = vi.fn(() => Promise.resolve(fakeSession().session));
    const host = new FirefoxBackgroundPageHost({ createSession: create });
    expect(create).not.toHaveBeenCalled();
    await host.ensureStarted();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('creates one session across repeated ensureStarted calls', async () => {
    const create = vi.fn(() => Promise.resolve(fakeSession().session));
    const host = new FirefoxBackgroundPageHost({ createSession: create });
    await host.ensureStarted();
    await host.ensureStarted();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('serialises concurrent starts instead of spawning two workers', async () => {
    // ensureStarted() is documented as safe to call before every request, so
    // concurrent requests racing a cold start is the normal case, not the edge
    // case. Two workers would mean two loaded copies of the model.
    // Definite-assignment: TS narrows a `let` assigned only inside the executor
    // to `never`, even though the executor runs synchronously.
    let resolve!: (s: HostSession) => void;
    const create = vi.fn(
      () =>
        new Promise<HostSession>((r) => {
          resolve = r;
        }),
    );
    const host = new FirefoxBackgroundPageHost({ createSession: create });

    const a = host.ensureStarted();
    const b = host.ensureStarted();
    const c = host.ensureStarted();
    expect(create).toHaveBeenCalledTimes(1);

    resolve(fakeSession().session);
    await Promise.all([a, b, c]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stays unstarted when session creation fails, and can be retried', async () => {
    let attempt = 0;
    const host = new FirefoxBackgroundPageHost({
      createSession: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('worker spawn failed'));
        return Promise.resolve(fakeSession().session);
      },
    });

    await expect(host.ensureStarted()).rejects.toThrow(/worker spawn failed/);
    await expect(host.isRunning()).resolves.toBe(false);
    // The in-flight promise must be cleared, or every later attempt replays the
    // original rejection and the host is permanently dead.
    await expect(host.ensureStarted()).resolves.toBeUndefined();
    await expect(host.isRunning()).resolves.toBe(true);
  });

  it('does not hold the keep-alive when the session failed to start', async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const host = new FirefoxBackgroundPageHost({
      createSession: () => Promise.reject(new Error('nope')),
      keepAlive: acquire,
    });
    await expect(host.ensureStarted()).rejects.toThrow();
    // Either never acquired, or acquired and released - what must not happen is
    // pinning the event page alive for a session that does not exist.
    expect(acquire.mock.calls.length).toBe(release.mock.calls.length);
  });
});

describe('FirefoxBackgroundPageHost request and stop', () => {
  it('starts on demand and forwards cmd and payload', async () => {
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({ createSession: () => Promise.resolve(f.session) });
    const out = await host.request('detect', { frameId: 'x' });
    expect(f.calls).toEqual([['detect', { frameId: 'x' }]]);
    expect(out).toEqual({ ok: true, cmd: 'detect' });
  });

  it('reports its kind', () => {
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({ createSession: () => Promise.resolve(f.session) });
    expect(host.kind).toBe('firefox-background-page');
  });

  it('closes the session on stop and reports not running', async () => {
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({ createSession: () => Promise.resolve(f.session) });
    await host.ensureStarted();
    await expect(host.isRunning()).resolves.toBe(true);
    await host.stop();
    expect(f.closed()).toBe(1);
    await expect(host.isRunning()).resolves.toBe(false);
  });

  it('is safe to stop when it was never started', async () => {
    const f = fakeSession();
    const host = new FirefoxBackgroundPageHost({ createSession: () => Promise.resolve(f.session) });
    await expect(host.stop()).resolves.toBeUndefined();
    expect(f.closed()).toBe(0);
  });

  it('spawns a fresh session after a stop', async () => {
    const create = vi.fn(() => Promise.resolve(fakeSession().session));
    const host = new FirefoxBackgroundPageHost({ createSession: create });
    await host.ensureStarted();
    await host.stop();
    await host.ensureStarted();
    expect(create).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Chrome: the offscreen document
// ---------------------------------------------------------------------------

function fakeChromeApi(
  opts: {
    contexts?: number;
    hasOffscreen?: boolean;
    hasGetContexts?: boolean;
    /**
     * What the offscreen document replies.
     *
     * The default used to be a bare `{ ok: true }` with NO `result` field - so
     * the unwrap step had nothing to drop and the response direction was
     * untestable even if someone had asserted on it. The real listener always
     * sends `{ ok, cmd, result }`; a fake that is tidier than the real thing
     * hides exactly the bug it should catch.
     */
    reply?: (message: unknown) => unknown;
  } = {},
) {
  let contexts = opts.contexts ?? 0;
  const created: { url: string; reasons: readonly string[] }[] = [];
  const sent: unknown[] = [];
  let closes = 0;
  let createFails: Error | null = null;

  const api: OffscreenCapableRuntime = {
    ...(opts.hasOffscreen === false
      ? {}
      : {
          offscreen: {
            createDocument: (o) => {
              if (createFails !== null) return Promise.reject(createFails);
              created.push({ url: o.url, reasons: o.reasons });
              contexts += 1;
              return Promise.resolve();
            },
            closeDocument: () => {
              closes += 1;
              contexts = 0;
              return Promise.resolve();
            },
          },
        }),
    runtime: {
      getURL: (p: string) => `moz-extension://fake${p}`,
      sendMessage: (m: unknown) => {
        sent.push(m);
        const msg = m as { cmd?: string };
        // Mirrors entrypoints/offscreen/main.ts, including the `cmd` echo.
        return Promise.resolve(
          opts.reply === undefined ? { ok: true, cmd: msg.cmd, result: undefined } : opts.reply(m),
        );
      },
      ...(opts.hasGetContexts === false
        ? {}
        : { getContexts: () => Promise.resolve(new Array<unknown>(contexts).fill({})) }),
    },
  };

  return {
    api,
    created,
    sent,
    closes: () => closes,
    failCreateWith: (e: Error) => {
      createFails = e;
    },
    allowCreate: () => {
      createFails = null;
    },
  };
}

describe('ChromeOffscreenHost respects the one-document rule', () => {
  it('creates the document with the WORKERS reason and the right URL', async () => {
    const f = fakeChromeApi();
    const host = new ChromeOffscreenHost(f.api);
    await host.ensureStarted();
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.reasons).toEqual(['WORKERS']);
    expect(f.created[0]?.url).toContain(OFFSCREEN_PATH);
  });

  it('does not create a second document when one already exists', async () => {
    // An extension may have exactly one offscreen document; createDocument
    // throws on the second call.
    const f = fakeChromeApi({ contexts: 1 });
    const host = new ChromeOffscreenHost(f.api);
    await host.ensureStarted();
    expect(f.created).toHaveLength(0);
  });

  it('serialises concurrent starts into one createDocument', async () => {
    const f = fakeChromeApi();
    const host = new ChromeOffscreenHost(f.api);
    await Promise.all([host.ensureStarted(), host.ensureStarted(), host.ensureStarted()]);
    expect(f.created).toHaveLength(1);
  });

  it('never guesses "running" when getContexts is unavailable', async () => {
    // Pre-Chrome-116. A false positive means createDocument throws next call.
    const f = fakeChromeApi({ hasGetContexts: false });
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.isRunning()).resolves.toBe(false);
  });

  it('throws a clear error when the offscreen API is absent', async () => {
    const f = fakeChromeApi({ hasOffscreen: false });
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.ensureStarted()).rejects.toThrow(/Chromium-only|offscreen/i);
  });

  it('clears the in-flight promise so a failed creation can be retried', async () => {
    const f = fakeChromeApi();
    f.failCreateWith(new Error('createDocument blew up'));
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.ensureStarted()).rejects.toThrow(/blew up/);
    f.allowCreate();
    await expect(host.ensureStarted()).resolves.toBeUndefined();
    expect(f.created).toHaveLength(1);
  });

  it('addresses the offscreen document when it sends a request', async () => {
    const f = fakeChromeApi();
    const host = new ChromeOffscreenHost(f.api);
    await host.request('detect', { frameId: 'x' });
    expect(f.sent[0]).toEqual({ target: 'offscreen', cmd: 'detect', payload: { frameId: 'x' } });
  });

  it('closes only when a document is actually open', async () => {
    const f = fakeChromeApi();
    const host = new ChromeOffscreenHost(f.api);
    await host.stop();
    expect(f.closes()).toBe(0);

    await host.ensureStarted();
    await host.stop();
    expect(f.closes()).toBe(1);
  });

  it('reports its kind', () => {
    const f = fakeChromeApi();
    expect(new ChromeOffscreenHost(f.api).kind).toBe('chrome-offscreen');
  });
});

describe('ChromeOffscreenHost speaks the same contract as the Firefox host', () => {
  /**
   * THE UNTESTED DIRECTION.
   *
   * Every existing Chrome test asserted the OUTGOING message and threw the
   * resolved value away, so `request<T>(): Promise<T>` was unverified for this
   * backend. Meanwhile the real implementation returned the reply ENVELOPE:
   * `InitResult.backend` arrived undefined and the panel rendered
   * "undefined, NaN MB in NaN ms"; `VisionResult.detections` arrived undefined
   * and `redact()` threw on `vision.map`.
   *
   * `as T` from `Promise<unknown>` compiles under every strict flag this project
   * enables, so tsc could not see it either. Only asserting the returned value
   * can.
   */

  it('returns the RESULT, not the envelope it arrived in', async () => {
    const init = { backend: 'webgpu', loadMs: 1840, weightBytes: 26_227_993 };
    const f = fakeChromeApi({ reply: (m) => ({ ok: true, cmd: (m as { cmd: string }).cmd, result: init }) });
    const host = new ChromeOffscreenHost(f.api);

    const out = await host.request<typeof init>('init', {});
    expect(out).toEqual(init);
    // The envelope keys must not survive. This is the assertion whose absence
    // let the bug ship.
    expect(out).not.toHaveProperty('ok');
    expect(out).not.toHaveProperty('result');
  });

  it('REJECTS when the offscreen document reports a failure', async () => {
    /*
     * The offscreen listener catches everything and RESOLVES with
     * `{ ok: false, ... }`, because a rejected promise returned from an
     * onMessage listener is delivered as `undefined` and the error is lost.
     *
     * So a failed model load resolved successfully. `initModel`'s `.catch` was
     * unreachable, `modelState` became 'loaded', and the panel reported a model
     * that had never loaded. This is the test that makes that catch reachable.
     */
    const f = fakeChromeApi({
      reply: () => ({ ok: false, cmd: 'init', error: 'no WebGPU adapter' }),
    });
    const host = new ChromeOffscreenHost(f.api);

    await expect(host.request('init', {})).rejects.toThrow(/no WebGPU adapter/);
  });

  it('rejects rather than returning undefined when nothing answered', async () => {
    // No listener: the document was torn down mid-request, or its module threw
    // on load. Returning undefined here surfaces much later as a missing field.
    const f = fakeChromeApi({ reply: () => undefined });
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.request('detect', {})).rejects.toThrow(/no reply/);
  });

  it('names the command in its errors', async () => {
    const f = fakeChromeApi({ reply: () => ({ ok: false, cmd: 'bake', error: 'frame evicted' }) });
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.request('bake', {})).rejects.toThrow(/bake/);
  });

  it('passes a falsy-but-valid result through unharmed', async () => {
    // `ok !== true` is the failure test, not `!result`. A legitimately falsy
    // payload must not be mistaken for an error.
    const f = fakeChromeApi({ reply: () => ({ ok: true, cmd: 'x', result: 0 }) });
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.request<number>('x', {})).resolves.toBe(0);
  });
});

describe('the Chrome wire protocol, both halves against each other', () => {
  /**
   * THE TEST THAT DID NOT EXIST.
   *
   * The envelope was minted in `entrypoints/offscreen/main.ts` and parsed in
   * `perception/host/chrome-offscreen.ts`. `entrypoints/` has no tests by
   * convention, so the producing half was never exercised, and the consuming
   * half was only ever checked for what it SENT. The two drifted - one wrapped,
   * the other never unwrapped - and the result was a model that failed to load
   * reporting as loaded.
   *
   * `answerOffscreen` now lives beside the parser so a test can drive the real
   * producer into the real consumer. The fake here is the MESSAGE CHANNEL, not
   * either half of the protocol.
   */

  /** A sendMessage that runs the real offscreen answer for a given dispatch. */
  function wiredApi(dispatch: (cmd: string, payload: unknown) => Promise<unknown>) {
    const f = fakeChromeApi({
      reply: (m) => {
        const msg = m as { cmd: string; payload: unknown };
        return answerOffscreen(msg.cmd, msg.payload, dispatch);
      },
    });
    return f;
  }

  it('delivers a real result through the real envelope', async () => {
    const init = { backend: 'webgpu', loadMs: 1840, weightBytes: 26_227_993 };
    const f = wiredApi(() => Promise.resolve(init));
    const host = new ChromeOffscreenHost(f.api);

    // The producer wraps, the consumer unwraps, and what comes out is what the
    // dispatch returned - not the envelope it travelled in.
    await expect(host.request('init', {})).resolves.toEqual(init);
  });

  it('turns a far-side throw into a near-side rejection', async () => {
    /*
     * End to end: dispatch throws -> answerOffscreen encodes it (a rejected
     * promise from an onMessage listener would arrive as `undefined` and the
     * error would be lost) -> request re-throws it.
     *
     * Every link in that chain was present except the last, which is why a
     * failed load looked like a successful one.
     */
    const f = wiredApi(() => Promise.reject(new Error('no WebGPU adapter')));
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.request('init', {})).rejects.toThrow(/no WebGPU adapter/);
  });

  it('carries the command name through both halves', async () => {
    const f = wiredApi((cmd) => Promise.reject(new Error(`${cmd} blew up`)));
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.request('bake', {})).rejects.toThrow(/bake/);
  });

  it('passes the payload the caller sent to the dispatch on the far side', async () => {
    const seen: unknown[] = [];
    const f = wiredApi((_cmd, payload) => {
      seen.push(payload);
      return Promise.resolve({ ok: true });
    });
    const host = new ChromeOffscreenHost(f.api);
    await host.request('detect', { frameId: 'f7' });
    expect(seen).toEqual([{ frameId: 'f7' }]);
  });

  it('survives a falsy result, which `ok` and not truthiness must decide', async () => {
    const f = wiredApi(() => Promise.resolve(0));
    const host = new ChromeOffscreenHost(f.api);
    await expect(host.request<number>('x', {})).resolves.toBe(0);
  });
});

