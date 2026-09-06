import {
  type CapturedFrame,
  type ViewportInfo,
  NotImplementedError,
} from '@/contracts/index.ts';

/**
 * Screen capture.
 *
 * `chrome.tabs.captureVisibleTab` can only be called from the background
 * context - not a content script, not the offscreen document - and needs either
 * activeTab (granted by a user gesture) or a host permission for the tab.
 *
 * The result is a data URL rather than an ImageBitmap on purpose: extension
 * runtime messaging is JSON-serialised, so bitmaps and transferables do not
 * survive the hop to the model host. The cost of that is a base64 string in
 * memory and a decode on the far side, which is why `maxEdgePx` and JPEG quality
 * are the first two dials to reach for when the latency budget is tight.
 */

export interface CaptureOptions {
  readonly format: 'jpeg' | 'png';
  /** 0-100. Only meaningful for jpeg. */
  readonly quality: number;
  /** Longest edge after downscaling. The single biggest lever on both latency and bytes. */
  readonly maxEdgePx: number;
}

export const DEFAULT_CAPTURE: CaptureOptions = {
  format: 'jpeg',
  quality: 80,
  maxEdgePx: 1280,
};

export interface CaptureAdapter {
  capture(tabId: number, viewport: ViewportInfo, opts: CaptureOptions): Promise<CapturedFrame>;
}

/** Scale factor that fits `natural` inside `maxEdgePx` without upscaling. */
export function downscaleFactor(
  natural: { readonly width: number; readonly height: number },
  maxEdgePx: number,
): number {
  const longest = Math.max(natural.width, natural.height);
  if (longest <= maxEdgePx || longest === 0) return 1;
  return maxEdgePx / longest;
}

/** Rough encoded size of a data URL, without materialising the bytes. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const payload = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

/**
 * The quota, expressed as a minimum interval.
 *
 * `chrome.tabs.captureVisibleTab` is limited by
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, which is 2. Exceeding it does not
 * degrade - the call rejects - so the loop has to pace itself rather than find
 * out. The spike measured the capture itself at 23 ms warm (722 ms on the very
 * first call), so this interval, not the capture, is the real ceiling.
 */
export const CAPTURE_MIN_INTERVAL_MS = 500;

/** A browser error meaning we went too fast, as opposed to any other failure. */
function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message);
}

export interface BrowserCaptureDeps {
  /**
   * The browser call. Injected rather than imported because it only exists in
   * the background context, and because pacing is the part worth testing.
   */
  readonly captureVisibleTab: (
    tabId: number,
    opts: { format: 'jpeg' | 'png'; quality: number },
  ) => Promise<string>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newFrameId?: () => string;
  readonly minIntervalMs?: number;
}

/**
 * Captures the visible tab, at a rate the browser will actually tolerate.
 *
 * WHAT IT DOES NOT DO: downscale. `captureVisibleTab` returns the viewport at
 * device resolution and has no scaling option, so honouring `maxEdgePx` here
 * would mean decoding to a canvas - which a Chrome MV3 service worker does not
 * have. Scaling therefore happens downstream, where the frame is already being
 * decoded and resampled for the model (`letterboxImage`). `quality` and `format`
 * ARE honoured here, natively, because the API takes them.
 *
 * That is a real limitation and not a rounding of one: `maxEdgePx` currently has
 * no effect on the bytes crossing from the background to the worker. Reducing
 * that traffic needs an explicit downscale step in the worker.
 */
export class BrowserCaptureAdapter implements CaptureAdapter {
  readonly #capture: BrowserCaptureDeps['captureVisibleTab'];
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #newFrameId: () => string;
  readonly #minInterval: number;

  #lastCaptureAt = Number.NEGATIVE_INFINITY;
  /** Serialises callers so two of them cannot both decide the window is clear. */
  #queue: Promise<void> = Promise.resolve();
  #counter = 0;

  constructor(deps: BrowserCaptureDeps) {
    this.#capture = deps.captureVisibleTab;
    this.#now = deps.now ?? ((): number => Date.now());
    this.#sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.#minInterval = deps.minIntervalMs ?? CAPTURE_MIN_INTERVAL_MS;
    this.#newFrameId =
      deps.newFrameId ??
      ((): string => `cap-${String(this.#now())}-${String(++this.#counter)}`);
  }

  capture(tabId: number, viewport: ViewportInfo, opts: CaptureOptions): Promise<CapturedFrame> {
    /*
     * Chained rather than parallel. Two overlapping captures - a loop tick and a
     * manual refresh landing together - would otherwise read the same
     * #lastCaptureAt, both conclude no wait was needed, and both fire inside one
     * window. The `catch` on the tail keeps a rejected capture from poisoning
     * the queue for every caller behind it.
     */
    const run = this.#queue.then(() => this.#captureOnce(tabId, viewport, opts));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #captureOnce(
    tabId: number,
    viewport: ViewportInfo,
    opts: CaptureOptions,
  ): Promise<CapturedFrame> {
    await this.#waitForWindow();

    let dataUrl: string;
    try {
      dataUrl = await this.#invoke(tabId, opts);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // The quota is per second across the whole extension, so another caller
      // can consume it even when our own pacing is correct. One retry after a
      // full window turns a hard failure into a slow success.
      await this.#sleep(this.#minInterval);
      dataUrl = await this.#invoke(tabId, opts);
    }

    const dpr = viewport.devicePixelRatio || 1;
    return {
      frameId: this.#newFrameId(),
      dataUrl,
      encodedBytes: dataUrlBytes(dataUrl),
      // Exact, not estimated: captureVisibleTab returns the visible viewport at
      // device resolution. Decoding the image to measure it is both wasteful and
      // impossible in a service worker.
      natural: {
        width: Math.round(viewport.cssWidth * dpr),
        height: Math.round(viewport.cssHeight * dpr),
      },
      viewport,
      capturedAt: this.#now(),
    };
  }

  /** Records the attempt before it happens: a failed call spends quota too. */
  #invoke(tabId: number, opts: CaptureOptions): Promise<string> {
    this.#lastCaptureAt = this.#now();
    return this.#capture(tabId, { format: opts.format, quality: opts.quality });
  }

  async #waitForWindow(): Promise<void> {
    const elapsed = this.#now() - this.#lastCaptureAt;
    if (elapsed >= this.#minInterval) return;
    await this.#sleep(this.#minInterval - elapsed);
  }
}

export class UnimplementedCaptureAdapter implements CaptureAdapter {
  capture(): Promise<CapturedFrame> {
    throw new NotImplementedError('CaptureAdapter.capture');
  }
}

/** Serves a fixed frame. Lets the harness drive the pipeline with no browser. */
export class FixtureCaptureAdapter implements CaptureAdapter {
  readonly #frame: CapturedFrame;

  constructor(frame: CapturedFrame) {
    this.#frame = frame;
  }

  capture(): Promise<CapturedFrame> {
    return Promise.resolve(this.#frame);
  }
}
