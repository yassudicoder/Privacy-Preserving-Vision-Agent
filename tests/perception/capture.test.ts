import { describe, expect, it } from 'vitest';
import type { ViewportInfo } from '@/contracts/index.ts';
import {
  BrowserCaptureAdapter,
  CAPTURE_MIN_INTERVAL_MS,
  DEFAULT_CAPTURE,
  dataUrlBytes,
  downscaleFactor,
} from '@/perception/index.ts';

/**
 * Screen capture, tested without a browser.
 *
 * The interesting behaviour here is not "does it call the API". It is the
 * pacing. `chrome.tabs.captureVisibleTab` is quota'd at
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2, and exceeding it does not
 * degrade gracefully - the call rejects. An agent loop that runs faster than
 * expected would therefore start failing captures intermittently, which is the
 * kind of bug that reproduces only under load.
 *
 * The spike measured the other half: 722 ms for the first capture, 23 ms warm.
 * So the quota, not the capture itself, is the ceiling worth designing against.
 */

const VIEWPORT: ViewportInfo = {
  cssWidth: 800,
  cssHeight: 600,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
};

/** A clock that only moves when something explicitly advances it. */
function controllable(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let t = 10_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeApi(dataUrl = 'data:image/jpeg;base64,AAAA') {
  const calls: { tabId: number; format: string; quality: number }[] = [];
  let fail: Error | null = null;
  let failTimes = 0;
  return {
    calls,
    failWith(err: Error, times = Number.MAX_SAFE_INTEGER): void {
      fail = err;
      failTimes = times;
    },
    fn: (tabId: number, opts: { format: 'jpeg' | 'png'; quality: number }): Promise<string> => {
      calls.push({ tabId, format: opts.format, quality: opts.quality });
      if (fail !== null && failTimes > 0) {
        failTimes -= 1;
        return Promise.reject(fail);
      }
      return Promise.resolve(dataUrl);
    },
  };
}

function build(opts: { api?: ReturnType<typeof fakeApi>; clock?: ReturnType<typeof controllable> } = {}) {
  const api = opts.api ?? fakeApi();
  const clock = opts.clock ?? controllable();
  let n = 0;
  const adapter = new BrowserCaptureAdapter({
    captureVisibleTab: api.fn,
    now: clock.now,
    sleep: clock.sleep,
    newFrameId: () => `frame-${String(++n)}`,
  });
  return { adapter, api, clock };
}

// ---------------------------------------------------------------------------
// the quota
// ---------------------------------------------------------------------------

describe('captureVisibleTab pacing respects the 2/sec quota', () => {
  it('exposes the interval the quota implies', () => {
    // 2 calls per second. Anything below 500 ms between calls can be rejected.
    expect(CAPTURE_MIN_INTERVAL_MS).toBe(500);
  });

  it('does not wait before the first capture', async () => {
    const { adapter, clock } = build();
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(clock.slept).toEqual([]);
  });

  it('waits out the remainder of the window on a back-to-back capture', async () => {
    const { adapter, clock } = build();
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(clock.slept).toHaveLength(1);
    expect(clock.slept[0]).toBe(500);
  });

  it('waits only the remaining time when some has already passed', async () => {
    const { adapter, clock } = build();
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    clock.advance(300);
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(clock.slept).toEqual([200]);
  });

  it('does not wait at all when the caller was already slow enough', async () => {
    const { adapter, clock } = build();
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    clock.advance(900);
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(clock.slept).toEqual([]);
  });

  it('paces concurrent callers instead of letting them race the quota', async () => {
    // Two overlapping capture() calls is the realistic failure: a loop tick and
    // a manual refresh landing together. Without serialisation both read the
    // same "last capture" timestamp, both decide no wait is needed, and both
    // fire inside the same window.
    const { adapter, api, clock } = build();
    await Promise.all([
      adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE),
      adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE),
      adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE),
    ]);
    expect(api.calls).toHaveLength(3);
    // First is free; the two behind it each wait a full window.
    expect(clock.slept).toEqual([500, 500]);
  });
});

// ---------------------------------------------------------------------------
// the frame it produces
// ---------------------------------------------------------------------------

describe('the captured frame describes itself accurately', () => {
  it('passes the requested format and quality straight through', async () => {
    const { adapter, api } = build();
    await adapter.capture(7, VIEWPORT, { format: 'jpeg', quality: 55, maxEdgePx: 1280 });
    expect(api.calls[0]).toEqual({ tabId: 7, format: 'jpeg', quality: 55 });
  });

  it('derives natural size from the viewport and device pixel ratio', async () => {
    // captureVisibleTab returns the visible viewport at device resolution, so
    // this is exact rather than an estimate - and it avoids decoding the image
    // purely to learn its dimensions, which a service worker cannot do anyway.
    const { adapter } = build();
    const frame = await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(frame.natural).toEqual({ width: 1600, height: 1200 });
  });

  it('treats a missing devicePixelRatio as 1 rather than producing zeros', async () => {
    const { adapter } = build();
    const frame = await adapter.capture(1, { ...VIEWPORT, devicePixelRatio: 0 }, DEFAULT_CAPTURE);
    expect(frame.natural).toEqual({ width: 800, height: 600 });
  });

  it('measures encoded bytes from the payload', async () => {
    const api = fakeApi('data:image/jpeg;base64,QUJDRA==');
    const { adapter } = build({ api });
    const frame = await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(frame.encodedBytes).toBe(dataUrlBytes('data:image/jpeg;base64,QUJDRA=='));
    expect(frame.encodedBytes).toBeGreaterThan(0);
  });

  it('stamps a unique frame id and a capture time', async () => {
    const { adapter } = build();
    const a = await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    const b = await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(a.frameId).not.toBe(b.frameId);
    expect(a.capturedAt).toBeGreaterThan(0);
    // The retained-frame map in the worker is keyed by this. Collisions would
    // bake one screen's redactions onto another.
    expect(b.capturedAt).toBeGreaterThanOrEqual(a.capturedAt);
  });

  it('carries the viewport through unchanged', async () => {
    const { adapter } = build();
    const frame = await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(frame.viewport).toEqual(VIEWPORT);
  });
});

// ---------------------------------------------------------------------------
// failure
// ---------------------------------------------------------------------------

describe('capture failures surface rather than returning a blank frame', () => {
  it('rejects when the tab cannot be captured', async () => {
    // No activeTab grant, or a chrome:// page. Returning an empty frame here
    // would read downstream as "a screen with nothing on it".
    const api = fakeApi();
    api.failWith(new Error('Cannot access contents of the page'));
    const { adapter } = build({ api });
    await expect(adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE)).rejects.toThrow(/Cannot access/);
  });

  it('retries once when the browser reports the quota was exceeded', async () => {
    // Pacing should prevent this, but the quota is enforced per second across
    // the whole extension - another caller can consume it. One retry after a
    // full window is cheap and turns a hard failure into a slow success.
    const api = fakeApi();
    api.failWith(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded'), 1);
    const { adapter, clock } = build({ api });
    const frame = await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(frame.frameId).toBeTruthy();
    expect(api.calls).toHaveLength(2);
    expect(clock.slept).toContain(500);
  });

  it('gives up after the retry rather than looping', async () => {
    const api = fakeApi();
    api.failWith(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded'));
    const { adapter } = build({ api });
    await expect(adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE)).rejects.toThrow(/quota/);
    expect(api.calls).toHaveLength(2);
  });

  it('does not retry a non-quota failure', async () => {
    const api = fakeApi();
    api.failWith(new Error('some other problem'));
    const { adapter } = build({ api });
    await expect(adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE)).rejects.toThrow(/some other/);
    expect(api.calls).toHaveLength(1);
  });

  it('still paces the next call after a failure', async () => {
    // A failed call consumed quota just as surely as a successful one.
    const api = fakeApi();
    api.failWith(new Error('nope'), 1);
    const { adapter, clock } = build({ api });
    await expect(adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE)).rejects.toThrow();
    await adapter.capture(1, VIEWPORT, DEFAULT_CAPTURE);
    expect(clock.slept).toEqual([500]);
  });
});

// ---------------------------------------------------------------------------
// the pure helpers, which had no tests at all
// ---------------------------------------------------------------------------

describe('downscaleFactor', () => {
  it('never upscales', () => {
    expect(downscaleFactor({ width: 100, height: 50 }, 1280)).toBe(1);
    expect(downscaleFactor({ width: 1280, height: 720 }, 1280)).toBe(1);
  });

  it('fits the longest edge', () => {
    expect(downscaleFactor({ width: 2560, height: 1440 }, 1280)).toBeCloseTo(0.5, 10);
    expect(downscaleFactor({ width: 1440, height: 2560 }, 1280)).toBeCloseTo(0.5, 10);
  });

  it('survives a zero-size input instead of dividing by zero', () => {
    expect(downscaleFactor({ width: 0, height: 0 }, 1280)).toBe(1);
  });
});

describe('dataUrlBytes', () => {
  it('measures the decoded payload, not the string length', () => {
    // "ABCD" base64-encodes to QUJDRA== : 4 bytes.
    expect(dataUrlBytes('data:image/jpeg;base64,QUJDRA==')).toBe(4);
  });

  it('accounts for padding', () => {
    expect(dataUrlBytes('data:image/png;base64,QQ==')).toBe(1);
    expect(dataUrlBytes('data:image/png;base64,QUI=')).toBe(2);
    expect(dataUrlBytes('data:image/png;base64,QUJD')).toBe(3);
  });

  it('returns zero for something that is not a data URL', () => {
    expect(dataUrlBytes('')).toBe(0);
    expect(dataUrlBytes('not-a-data-url')).toBe(0);
  });
});
