import { NotImplementedError } from '@/contracts/index.ts';

/**
 * Where the model actually runs.
 *
 * This abstraction exists because Chrome and Firefox disagree about the one
 * thing that matters most here - whether the background context has a DOM:
 *
 *   Chrome  MV3 background is a service worker. No DOM, no canvas, no WebGPU.
 *           So the model lives in an offscreen document created via
 *           chrome.offscreen, which is Chromium-only.
 *
 *   Firefox MV3 has no background.service_worker at all (bugzil.la/1573659).
 *           It uses background.scripts, an event page that DOES have a DOM.
 *           chrome.offscreen does not exist, and is not needed.
 *
 * Both backends host the same worker running the same runtime code. Only the
 * document that owns the worker differs. `selectHost()` branches on a build-time
 * constant so the unused backend is tree-shaken out of each bundle.
 */

export type HostKind = 'chrome-offscreen' | 'firefox-background-page';

export interface InferenceHost {
  readonly kind: HostKind;
  /** Idempotent. Safe to call before every request. */
  ensureStarted(): Promise<void>;
  isRunning(): Promise<boolean>;
  request<T>(cmd: string, payload: unknown): Promise<T>;
  stop(): Promise<void>;
}

/** How the host talks to whatever is actually running the model. */
export type HostDispatch = (cmd: string, payload: unknown) => Promise<unknown>;

/**
 * A live connection to a spawned worker.
 *
 * `close` is optional because not every transport owns something to tear down -
 * the Chrome backend closes a document through the offscreen API instead.
 */
export interface HostSession {
  readonly dispatch: HostDispatch;
  close?(): Promise<void>;
}

/** The path the offscreen document is served from, relative to the extension root. */
/**
 * What the offscreen document sends back.
 *
 * WHY AN ENVELOPE AT ALL. A listener that returns a REJECTED promise to
 * `runtime.sendMessage` delivers `undefined` to the caller - the error does not
 * cross the boundary. So failures have to be encoded in the reply and re-thrown
 * on this side, or they vanish.
 *
 * WHY IT IS DECLARED HERE. It was previously minted in `entrypoints/offscreen/
 * main.ts` and consumed nowhere: `ChromeOffscreenHost.request` did
 * `return response as T` and handed the ENVELOPE to callers typed as `T`. The
 * fields they wanted were all `undefined`, and - worse - an `ok: false` failure
 * resolved as a success. A model that failed to load reported as loaded.
 *
 * `as T` from `Promise<unknown>` compiles under every strict flag this project
 * enables, so the typechecker could not see it. Naming the type in one place and
 * having both ends reference it is what makes the two halves checkable.
 */
export type OffscreenReply<T> =
  | { readonly ok: true; readonly cmd: string; readonly result: T }
  | { readonly ok: false; readonly cmd: string; readonly error: string };

/**
 * Mints the reply the offscreen document sends back.
 *
 * LIVES HERE, NOT IN THE ENTRYPOINT, so the two halves of this protocol can be
 * tested against each other. It used to be three lines inside
 * `entrypoints/offscreen/main.ts`, and `entrypoints/` has no tests by
 * convention - so the producer was untestable, the consumer
 * (`ChromeOffscreenHost.request`) was tested only for what it SENT, and the fact
 * that one wrapped while the other never unwrapped went unnoticed until a model
 * that failed to load reported as loaded.
 *
 * The `.catch` is load-bearing: a rejected promise returned from an
 * `onMessage` listener is delivered to the sender as `undefined`, so an error
 * that is not encoded into the reply does not survive the hop at all.
 */
export async function answerOffscreen(
  cmd: string,
  payload: unknown,
  dispatch: (cmd: string, payload: unknown) => Promise<unknown>,
): Promise<OffscreenReply<unknown>> {
  try {
    return { ok: true, cmd, result: await dispatch(cmd, payload) };
  } catch (err: unknown) {
    return { ok: false, cmd, error: err instanceof Error ? err.message : String(err) };
  }
}

export const OFFSCREEN_PATH = '/offscreen.html';

export const OFFSCREEN_JUSTIFICATION =
  'Runs a local vision model over screen captures. Requires a DOM, canvas and WebGPU, none of which exist in an MV3 service worker.';

/**
 * Minimal structural type for the slice of chrome.* this module touches.
 *
 * Declared here rather than pulled from @types/chrome so the exact API surface
 * we depend on is visible and reviewable in one place - and so adding a new
 * privileged call is a deliberate edit rather than an autocomplete.
 */
export interface OffscreenApi {
  createDocument(opts: {
    url: string;
    reasons: readonly string[];
    justification: string;
  }): Promise<void>;
  closeDocument(): Promise<void>;
}

export interface OffscreenCapableRuntime {
  readonly offscreen?: OffscreenApi;
  readonly runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    getContexts?: (filter: { contextTypes: readonly string[] }) => Promise<readonly unknown[]>;
  };
}

/** Placeholder used until a real host backend is wired up. */
export class UnimplementedHost implements InferenceHost {
  readonly kind: HostKind;

  constructor(kind: HostKind) {
    this.kind = kind;
  }

  ensureStarted(): Promise<void> {
    throw new NotImplementedError(`InferenceHost.ensureStarted (${this.kind})`);
  }

  isRunning(): Promise<boolean> {
    return Promise.resolve(false);
  }

  request<T>(): Promise<T> {
    throw new NotImplementedError(`InferenceHost.request (${this.kind})`);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
