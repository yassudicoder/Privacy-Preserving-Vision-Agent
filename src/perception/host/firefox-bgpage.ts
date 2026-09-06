import type { HostSession, InferenceHost } from './host.ts';

/**
 * Firefox backend: the model runs in the background event page itself.
 *
 * Firefox MV3 has no `background.service_worker` and no `chrome.offscreen`.
 * What it has is `background.scripts`, which runs in a real background PAGE -
 * DOM, canvas and all. So there is no document to create: the host already
 * exists, and the worker is spawned directly inside it by `createSession`.
 *
 * ON THE KEEP-ALIVE. MV3 event pages are non-persistent and unload when idle,
 * taking a multi-megabyte loaded model with them. The keep-alive is therefore
 * scoped to a session: acquired when one starts, released when it stops.
 *
 * It was previously acquired in the CONSTRUCTOR, which `background.ts` runs at
 * startup - so merely selecting this backend pinned the event page alive for the
 * life of the browser, which is precisely what the comment above it warned
 * against. It is now taken in `ensureStarted()` and released in `stop()`, and
 * re-taken if a later session starts.
 *
 * It is also BEST EFFORT and deliberately optional. MDN is explicit that
 * "message ports cannot prevent an event page from shutting down", so a
 * port-based keep-alive does not actually work on Gecko; the documented lever is
 * an open visible view, such as the sidebar. Callers that have one should pass a
 * keep-alive that reflects it. Callers that do not should pass nothing rather
 * than pretend.
 */
export class FirefoxBackgroundPageHost implements InferenceHost {
  readonly kind = 'firefox-background-page' as const;

  readonly #createSession: () => Promise<HostSession>;
  readonly #acquireKeepAlive: (() => () => void) | null;

  #session: HostSession | null = null;
  #releaseKeepAlive: (() => void) | null = null;
  /** Single in-flight start, so concurrent requests cannot spawn two workers. */
  #starting: Promise<void> | null = null;

  constructor(opts: {
    /**
     * Spawns the in-page worker and returns its transport. Called lazily on
     * first use, never at construction - loading a model because the extension
     * booted would be a 25 MB surprise on every browser start.
     */
    createSession: () => Promise<HostSession>;
    keepAlive?: () => () => void;
  }) {
    this.#createSession = opts.createSession;
    this.#acquireKeepAlive = opts.keepAlive ?? null;
  }

  isRunning(): Promise<boolean> {
    return Promise.resolve(this.#session !== null);
  }

  ensureStarted(): Promise<void> {
    if (this.#session !== null) return Promise.resolve();
    if (this.#starting !== null) return this.#starting;

    const starting = this.#start();
    this.#starting = starting;
    return starting;
  }

  async request<T>(cmd: string, payload: unknown): Promise<T> {
    await this.ensureStarted();
    const session = this.#session;
    if (session === null) {
      // Only reachable if a concurrent stop() landed between the two lines.
      throw new Error('FirefoxBackgroundPageHost: session went away mid-request');
    }
    return (await session.dispatch(cmd, payload)) as T;
  }

  async stop(): Promise<void> {
    const session = this.#session;
    this.#session = null;

    // Released before awaiting the close so a hanging close cannot keep the
    // event page pinned indefinitely.
    this.#release();

    if (session?.close !== undefined) await session.close();
  }

  async #start(): Promise<void> {
    // Acquire first: the page must survive long enough to finish spawning.
    if (this.#acquireKeepAlive !== null && this.#releaseKeepAlive === null) {
      this.#releaseKeepAlive = this.#acquireKeepAlive();
    }

    try {
      this.#session = await this.#createSession();
    } catch (err) {
      // Leave nothing behind. A retained keep-alive would pin the page for a
      // session that does not exist, and a retained #starting promise would
      // replay this rejection forever - the host would be permanently dead
      // after one transient spawn failure.
      this.#release();
      throw err;
    } finally {
      this.#starting = null;
    }
  }

  #release(): void {
    const release = this.#releaseKeepAlive;
    this.#releaseKeepAlive = null;
    if (release !== null) release();
  }
}
