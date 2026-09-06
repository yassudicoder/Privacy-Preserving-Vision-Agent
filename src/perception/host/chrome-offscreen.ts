import {
  type InferenceHost,
  type OffscreenCapableRuntime,
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_PATH,
} from './host.ts';

/**
 * Chrome backend: the model runs in an offscreen document.
 *
 * Three facts from the API docs drive this implementation:
 *   - `offscreen` is a permission, Chromium-only, Chrome 109+.
 *   - An installed extension may have exactly ONE offscreen document open.
 *     Calling createDocument twice throws, so creation is serialised behind a
 *     single in-flight promise.
 *   - `chrome.offscreen.hasDocument()` only exists from Chrome 150. The portable
 *     existence check is `chrome.runtime.getContexts()`, available from 116,
 *     which is also this extension's minimum_chrome_version.
 *
 * `WORKERS` is the honest reason: ONNX Runtime Web spawns workers for the wasm
 * backend, and the inference worker is the whole point of this document.
 */
export class ChromeOffscreenHost implements InferenceHost {
  readonly kind = 'chrome-offscreen' as const;
  readonly #api: OffscreenCapableRuntime;
  #creating: Promise<void> | null = null;

  constructor(api: OffscreenCapableRuntime) {
    this.#api = api;
  }

  async isRunning(): Promise<boolean> {
    const getContexts = this.#api.runtime.getContexts;
    if (getContexts === undefined) {
      // Pre-116. Not supported by this extension, but never guess "yes" -
      // a false positive here means createDocument throws on the next call.
      return false;
    }
    const contexts = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }

  async ensureStarted(): Promise<void> {
    if (await this.isRunning()) return;
    if (this.#creating !== null) {
      await this.#creating;
      return;
    }

    const offscreen = this.#api.offscreen;
    if (offscreen === undefined) {
      throw new Error('chrome.offscreen is unavailable; this backend is Chromium-only');
    }

    this.#creating = offscreen.createDocument({
      url: this.#api.runtime.getURL(OFFSCREEN_PATH),
      reasons: ['WORKERS'],
      justification: OFFSCREEN_JUSTIFICATION,
    });

    try {
      await this.#creating;
    } finally {
      this.#creating = null;
    }
  }

  async request<T>(cmd: string, payload: unknown): Promise<T> {
    await this.ensureStarted();
    const response = await this.#api.runtime.sendMessage({ target: 'offscreen', cmd, payload });

    /*
     * UNWRAPPED, not cast.
     *
     * This used to be `return response as T`, which handed the envelope to every
     * caller. `InitResult.backend` came back undefined and the panel rendered
     * "undefined, NaN MB in NaN ms"; `VisionResult.detections` came back
     * undefined and `redact()` threw on `vision.map`. Both looked like faults
     * elsewhere.
     *
     * The Firefox host dispatches in-process and returns the bare result, so
     * that - bare result, or throw - is the contract, and this is the side that
     * was breaking it.
     */
    if (response === null || typeof response !== 'object') {
      // No listener answered: the document was torn down between ensureStarted()
      // and here, or offscreen/main.ts threw at module scope. Either way this
      // must not surface later as undefined fields.
      throw new Error(
        `offscreen "${cmd}": no reply from the offscreen document (got ${String(response)})`,
      );
    }

    // Read permissively: this is an unvalidated message, so the parse shape is
    // "what might be there", not the union it is supposed to be. Narrowing
    // against OffscreenReply directly would assert the very thing being checked.
    const reply = response as { ok?: unknown; result?: unknown; error?: unknown };
    if (reply.ok !== true) {
      const detail = typeof reply.error === 'string' ? reply.error : 'unknown error';
      throw new Error(`offscreen "${cmd}" failed: ${detail}`);
    }
    return reply.result as T;
  }

  async stop(): Promise<void> {
    const offscreen = this.#api.offscreen;
    if (offscreen === undefined) return;
    if (!(await this.isRunning())) return;
    await offscreen.closeDocument();
  }
}
