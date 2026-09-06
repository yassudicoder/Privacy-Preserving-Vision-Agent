import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  type EngineConfig,
  type PanelEvent,
  type RedactionNonce,
  type Action,
  type ExecutedStep,
  DEFAULT_ENGINE_CONFIG,
  newSessionSalt,
  redactionNonce,
  DEFAULT_BUDGET_POLICY,
  type MemoryReading,
  type PrivacyLensRegion,
  type BackendKind,
  type DeploymentConfig,
  alternativesTo,
  configFor,
  defaultDeployment,
  isBackendKind,
  isOffDevice,
  selectedConfig,
  unmeasuredMemory,
} from '@/contracts/index.ts';
import {
  type HostSession,
  type InferenceHost,
  type InitResult,
  type RuntimeStatus,
  type OffscreenApi,
  type OffscreenCapableRuntime,
  BrowserCaptureAdapter,
  BrowserFrameCodec,
  DEFAULT_CAPTURE,
  ChromeOffscreenHost,
  FirefoxBackgroundPageHost,
  LocalWorkerRuntime,
  type OrtModule,
  createPackagedYunetFactory,
  createRuntimeDispatch,
} from '@/perception/index.ts';
import {
  createBrowserBake,
  createInProcessDomPipeline,
  createRemoteDomPipeline,
} from '@/redaction/index.ts';
import {
  type AgentBackend,
  createAgentBackend,
  backendDescriptorFor,
  deriveBackendOrigin,
  deriveOriginPattern,
} from '@/agent-server/index.ts';
import { runAgentLoop, runAgentStep, type TargetIdentity } from '@/orchestrator/index.ts';

/**
 * The orchestrator.
 *
 * On Chrome this is an MV3 service worker: no DOM, no canvas, no WebGPU. On
 * Firefox the same file becomes a background event page, which does have a DOM.
 * WXT emits the right manifest key for each; the code below must not assume
 * either, which is exactly why the model sits behind `InferenceHost`.
 *
 * Scaffold: the loop is described, not run. The shape it plugs into is already
 * fixed by the module contracts.
 */

/**
 * Narrow the ambient extension API to the handful of calls we actually use.
 * Written out rather than passing `browser` wholesale so that granting the host
 * a new privileged capability is a visible edit in this file.
 */
function extensionApi(): OffscreenCapableRuntime {
  const runtime = browser.runtime as unknown as {
    getURL: (path: string) => string;
    sendMessage: (message: unknown) => Promise<unknown>;
    getContexts?: (filter: { contextTypes: readonly string[] }) => Promise<readonly unknown[]>;
  };
  const offscreen = (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
  const getContexts = runtime.getContexts;

  return {
    ...(offscreen !== undefined ? { offscreen } : {}),
    runtime: {
      getURL: (path: string) => runtime.getURL(path),
      sendMessage: (message: unknown) => runtime.sendMessage(message),
      ...(getContexts !== undefined ? { getContexts: getContexts.bind(runtime) } : {}),
    },
  };
}

/**
 * The three toolbar/panel APIs, narrowed by hand for the same reason
 * extensionApi() is: a new privileged capability should be a visible edit here.
 *
 * `sidebarAction` is Firefox-only and has NO type at all in @wxt-dev/browser
 * (its types derive from @types/chrome; zero occurrences of the namespace).
 * `sidePanel` is Chrome-only but IS typed there, which is worse -- it compiles
 * on the Firefox build and is undefined at runtime. Both are therefore reached
 * through an optional cast and checked, never assumed.
 *
 * `action` is undefined unless wxt.config.ts declares the `action` manifest
 * key. Without the guard, reverting that key turns "no button" into a TypeError
 * at the top of the event page, which would also take the onMessage listener
 * below down with it.
 */
type SidebarActionApi = { readonly toggle: () => Promise<void> };
type SidePanelApi = { readonly open: (options: { windowId: number }) => Promise<void> };
type ActionApi = {
  readonly onClicked: {
    /*
     * `id` matters as much as `windowId`, and used to be absent from this type.
     *
     * The toolbar click is what grants activeTab, and the grant is PER TAB. The
     * panel, by contrast, is per WINDOW - one global `side_panel.default_path`,
     * `setOptions({tabId})` never called - so it stays open while the user
     * switches tabs. Without recording which tab the grant belongs to, a later
     * "run a step" would resolve some other active tab and `executeScript` would
     * reject with a host-permission error that looks like a bug in the loop.
     */
    readonly addListener: (callback: (tab: { id?: number; windowId: number }) => void) => void;
  };
};

function actionApi(): ActionApi | undefined {
  return (browser as unknown as { action?: ActionApi }).action;
}

/**
 * Open the panel. MUST be called synchronously, as the first statement of the
 * click listener.
 *
 * Both `chrome.sidePanel.open()` and `browser.sidebarAction.toggle()` are
 * gated on a user gesture, and on both engines the gesture is scoped to the
 * SYNCHRONOUS execution of the listener -- Chromium tracks it with an RAII
 * counter (ScopedWorkerInteraction), Gecko with a try/finally around the
 * dispatch (ExtensionCommon withHandlingUserInput). The first `await` forfeits
 * it. Do not make the caller async, do not await anything before this call, and
 * do not hand-roll a toggle as `await isOpen() ? close() : open()` -- that await
 * is the bug (bugzil.la/1800401).
 *
 * Neither call throws on a missing gesture; both REJECT. An unattached promise
 * would fail silently in the service-worker console, hence .catch(). Attaching
 * it afterwards is safe: the gesture is read at call time, not at settle time.
 */
function openPanel(windowId: number): void {
  // Build-time constant, same as selectHost(). The branch not taken -- and the
  // API name inside it -- is tree-shaken out of the other browser's bundle.
  if (import.meta.env.FIREFOX) {
    const sidebarAction = (browser as unknown as { sidebarAction?: SidebarActionApi })
      .sidebarAction;
    if (sidebarAction === undefined) return;
    // toggle(), not open(): this is a toolbar button, and a second click should
    // put the sidebar away. Firefox 73+, well under the 128.0 floor.
    void sidebarAction.toggle().catch((error: unknown) => {
      console.error('[background] sidebarAction.toggle failed', error);
    });
    return;
  }

  const sidePanel = (browser as unknown as { sidePanel?: SidePanelApi }).sidePanel;
  if (sidePanel === undefined) return;
  /*
   * windowId, not tabId: this extension declares a single global
   * side_panel.default_path and never calls setOptions({ tabId }), so the panel
   * is per-window. Chrome 116+, which minimum_chrome_version already pins.
   *
   * NOT setPanelBehavior({ openPanelOnActionClick: true }). That would open the
   * panel with no code at all, but Chromium's ExtensionActionRunner::RunAction
   * returns kToggleSidePanel BEFORE GrantTabPermissions() and before
   * DispatchExtensionActionClicked() -- so the click would neither grant
   * activeTab nor fire onClicked. activeTab is this extension's only page
   * access (there are no host_permissions by design) and the click is the only
   * user gesture available to carry permissions.request() later. Both would be
   * silently forfeited.
   */
  void sidePanel.open({ windowId }).catch((error: unknown) => {
    console.error('[background] sidePanel.open failed', error);
  });
}

/**
 * Resolves a packaged path for the model loader.
 *
 * The cast is unavoidable and deliberately narrow. WXT generates `PublicPath`
 * from what is in `public/` AT TYPECHECK TIME, and the model and wasm
 * directories are produced by `npm run vendor:model` - a build step, not a
 * committed tree. Typing them would mean committing ~46 MB of binaries to make
 * the compiler happy.
 *
 * `tests/built/bundle.test.ts` checks the emitted package for these files
 * instead, which is the check that would actually catch a wrong path.
 */
function packagedUrl(path: string): string {
  return browser.runtime.getURL(`/${path}` as Parameters<typeof browser.runtime.getURL>[0]);
}

/**
 * Builds the in-page inference session. FIREFOX ONLY.
 *
 * The Firefox background page has a DOM, so the model runs here directly and
 * there is no document to create - `createSession` IS the spawn. On Chrome this
 * function is unreachable and tree-shaken away, which matters: it touches
 * `document`, and a Chrome MV3 service worker has none.
 *
 * The model loads HERE on Firefox, in this same page. That is the whole reason
 * the two browsers differ: Chrome needs an offscreen document because its
 * service worker has no DOM, and Firefox does not because its event page does.
 * The backend wiring is identical - `createPackagedBackendFactory` - so the two
 * cannot drift into loading different weights with different settings.
 */
async function createFirefoxSession(): Promise<HostSession> {
  /*
   * DYNAMIC IMPORT, and it has to be.
   *
   * This file is ALSO the Chrome MV3 service worker. A static
   * `import * as transformers` at the top would put ~21 MB of ONNX Runtime Web
   * into that service worker's bundle - the project's first hard constraint is
   * that no model lives in the background, and a static import would break it
   * on Chrome while looking perfectly reasonable in a Firefox-only function.
   *
   * Tree-shaking is not a defence here: transformers.js has module-level side
   * effects, so a bundler must keep a statically imported namespace even when
   * the only function referencing it has been removed. Importing at the point of
   * use makes it a separate chunk that Chrome never fetches and never runs.
   *
   * `tests/built/bundle.test.ts` asserts this against the emitted files rather
   * than trusting the comment.
   */
  // Still dynamic, and now ORT rather than transformers.js: the reason is
  // unchanged - keeping ~21 MB of wasm out of Chrome's service worker.
  const ort = await import('onnxruntime-web');

  const runtime = new LocalWorkerRuntime({
    codec: new BrowserFrameCodec(),
    bake: createBrowserBake(SCREENSHOT_MAX_EDGE),
    createBackend: createPackagedYunetFactory(ort as unknown as OrtModule, packagedUrl),
  });

  return {
    dispatch: createRuntimeDispatch(runtime),
    close: () => runtime.dispose(),
  };
}

/**
 * The built path of the content script. It is `registration: 'runtime'`, so it
 * is bundled but absent from the manifest and must be injected by hand.
 */
/**
 * Sends a PanelEvent to the sidebar.
 *
 * The `.catch` is load-bearing, not defensive noise: `sendMessage` REJECTS when
 * no sidebar is open, which is the normal case. An unhandled rejection here
 * would fire on every event of every step whenever the panel is closed.
 *
 * One-way by design. The panel is a view; nothing waits on it.
 */
function broadcastPanel(event: PanelEvent): void {
  void (browser.runtime.sendMessage({ target: 'panel', event }) as Promise<unknown>).catch(
    () => undefined,
  );
}

/**
 * What the host can actually do, phrased so the panel cannot overstate it.
 *
 * `running` alone is misleading today: the host starts fine and then fails at
 * `detect`, because no weights are bundled. A panel showing only a green dot
 * would call that healthy.
 */
/**
 * What the model is doing right now.
 *
 * Held here rather than asked of the host on every status call, because `init`
 * is the expensive one-shot: the spike measured 116-202 s cold against the hub
 * and a local read is far quicker, but either way it is not something to
 * re-enter because a panel opened. `loading` exists so a second click during
 * that window joins the first load instead of starting another.
 */
type ModelState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly since: number }
  | { readonly phase: 'loaded'; readonly result: InitResult }
  | { readonly phase: 'failed'; readonly error: string };

let modelState: ModelState = { phase: 'idle' };
/** The in-flight load, so concurrent callers share one. */
let modelLoading: Promise<InitResult> | null = null;

function modelNote(state: ModelState, running: boolean): string {
  switch (state.phase) {
    case 'idle':
      return running
        ? 'host running; model not loaded yet - send host/init to load it'
        : 'host not started';
    case 'loading':
      return `loading weights (${Date.now() - state.since} ms so far)`;
    case 'loaded': {
      /*
       * Guarded because this rendered "undefined, NaN MB in NaN ms" on Chrome
       * for a model that had FAILED to load. The envelope bug that produced the
       * missing fields is fixed, but formatting unvalidated numbers into a
       * confident-looking sentence is what turned a load failure into a
       * measurement report - so the formatting is defended too.
       */
      const { backend, weightBytes, loadMs } = state.result;
      const mb = Number.isFinite(weightBytes) ? `${(weightBytes / 1048576).toFixed(2)} MB` : 'size unmeasured';
      const ms = Number.isFinite(loadMs) ? `${Math.round(loadMs)} ms` : 'time unmeasured';
      return `${backend ?? 'backend unknown'}, ${mb} in ${ms}`;
    }
    case 'failed':
      return `model failed to load: ${state.error}`;
  }
}

/**
 * Reconciles what this worker remembers with what the worker that owns the model
 * actually holds.
 *
 * On Chrome the offscreen document outlives the service worker, so after a
 * teardown `modelState` says `idle` while 26 MB of weights are still resident
 * next door. Believing the local variable would offer to reload them - and
 * would report "not loaded" for a model that is loaded.
 *
 * Failures here are swallowed deliberately: this is a status read, and a host
 * that cannot answer is reported through the existing `running` flag rather
 * than by breaking the panel refresh.
 */
async function reconcileModelState(host: InferenceHost): Promise<void> {
  try {
    const status = await host.request<RuntimeStatus>('status', undefined);
    if (status.loaded && status.result !== null) {
      modelState = { phase: 'loaded', result: status.result };
    } else if (modelState.phase === 'loaded') {
      // The worker was restarted or disposed underneath us.
      modelState = { phase: 'idle' };
    }
  } catch {
    // Leave whatever we had. An unreachable host is already visible as
    // `running: false`, and overwriting a real 'failed' with 'idle' here would
    // erase the reason the user needs to see.
  }
}

async function hostStatusEvent(host: InferenceHost): Promise<PanelEvent> {
  const running = await host.isRunning();
  if (running) {
    await reconcileModelState(host);
  } else if (modelState.phase === 'loaded') {
    /*
     * The host is gone and it took the model with it.
     *
     * This is the FIREFOX case. There the runtime lives in the same event page
     * as this code, with no keepAlive by design, so an unload discards the
     * loaded model - but `modelState` is a module variable in that same page,
     * and if the page survived long enough to answer this message it may still
     * say 'loaded'. Chrome reaches the branch above instead, because its
     * offscreen document outlives the service worker and can be asked.
     *
     * Without this the sidebar shows a loaded model, the user runs a step, and
     * `detect` fails with an internal error about init not having been awaited -
     * which reads as a broken pipeline rather than "the model went away".
     */
    modelState = { phase: 'idle' };
  }
  const base = {
    type: 'host/status',
    kind: host.kind,
    running,
    modelLoaded: modelState.phase === 'loaded',
    note: modelNote(modelState, running),
  } as const;
  // `model` is omitted rather than zero-filled until init has actually
  // returned. exactOptionalPropertyTypes makes that distinction real.
  return modelState.phase === 'loaded'
    ? {
        ...base,
        model: {
          backend: modelState.result.backend,
          loadMs: modelState.result.loadMs,
          weightBytes: modelState.result.weightBytes,
        },
      }
    : base;
}

/**
 * Loads the model, once.
 *
 * Deliberately not called at startup. On Chrome this spawns an offscreen
 * document and reads ~26 MB off disk; doing that because the browser started
 * would spend the user's memory on a session that may never run a step. It is
 * driven from the panel instead, which is also the only place the result can be
 * shown.
 */
/*
 * Session identity, from the CSPRNG, at module scope.
 *
 * Module scope because `initModel` needs the salt and it is not inside the
 * message-listener closure. Both values are minted once per background
 * lifetime; a service-worker restart mints new ones, which is correct - that is
 * a new session, and the digests should not be comparable across the boundary.
 *
 * The NONCE is the whole defence against a hostile page printing a
 * placeholder-shaped string to convince the server a field was redacted when it
 * was not. `newSessionSalt()` uses crypto.getRandomValues and documents that it
 * refuses to fall back to Math.random - which the previous Math.random-based
 * version silently was.
 */
const sessionNonce: RedactionNonce = redactionNonce(newSessionSalt());
const sessionSalt = newSessionSalt();

/**
 * Starts the model load if it is wanted and not already under way.
 *
 * FIRE AND FORGET, and idempotent. `initModel` already shares one in-flight load
 * between concurrent callers, so calling this from the panel-open path, the
 * vision toggle and a step is safe.
 *
 * It does NOT retry a FAILED load. A load that failed will fail again for the
 * same reason - no WebGPU adapter, missing weights - and retrying it on every
 * panel open would spend the user's battery re-discovering that. The Load model
 * button remains, and is now a deliberate retry rather than a gate.
 *
 * WHY THIS IS SAFE TO DO AUTOMATICALLY NOW, when the old comment said the
 * opposite. That comment - "loading is user-driven, not automatic... it reads
 * ~26 MB off disk" - was written for `yolos-tiny`. The model is YuNet: 232,589
 * bytes, and a measured 30.3 ms p50 forward pass. Spending that because a user
 * opened the panel they are about to run a task from is a different decision
 * from spending 26 MB because a browser started.
 */
function ensureModelLoading(host: InferenceHost): void {
  if (modelState.phase === 'loaded' || modelState.phase === 'loading') return;
  if (modelState.phase === 'failed') return;
  void initModel(host, DEFAULT_ENGINE_CONFIG).catch(() => {
    // `initModel` already records the failure in `modelState` and broadcasts it.
    // Swallowed here so an auto-load cannot surface as an unhandled rejection.
  });
}

function initModel(host: InferenceHost, config: EngineConfig): Promise<InitResult> {
  if (modelLoading !== null) return modelLoading;

  modelState = { phase: 'loading', since: Date.now() };
  void hostStatusEvent(host).then(broadcastPanel);

  const run = host
    /*
     * `{ config, salt }`, not a bare config. The salt is what the worker uses
     * for vision detection evidence hashes; without it those digests fell back
     * to a hardcoded constant while the DOM detections in the SAME log used a
     * per-session value, making half of each log reproducible across machines.
     */
    .request<InitResult>('init', { config, salt: sessionSalt })
    .then((result) => {
      modelState = { phase: 'loaded', result };
      return result;
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      modelState = { phase: 'failed', error };
      throw new Error(error);
    })
    .finally(() => {
      modelLoading = null;
      void hostStatusEvent(host).then(broadcastPanel);
    });

  modelLoading = run;
  return run;
}

/**
 * The tab this extension is currently allowed to touch.
 *
 * activeTab is granted to the tab that was active WHEN THE TOOLBAR WAS CLICKED,
 * and nothing else renews it: a click inside the side panel grants nothing, and
 * the panel outlives any particular tab. So the grant is pinned here at the
 * moment it is created and spent later, rather than re-derived from whatever
 * happens to be active when a step runs.
 *
 * It is also REVOKED when the tab navigates or closes - and the loop's own
 * actions navigate. That is why `tabs.onUpdated` clears this rather than
 * letting a step fail with a raw Chromium string the user cannot act on.
 */
interface AttachedTab {
  readonly tabId: number;
  readonly windowId: number;
  readonly grantedAt: number;
  /**
   * The page's origin, recorded so the panel can offer to grant it.
   *
   * `activeTab` cannot survive the loop: the agent's own clicks navigate, and
   * every navigation revokes it. A persistent host permission for THIS ONE
   * ORIGIN is the only way a multi-step task can outlive its own first click -
   * and `permissions.request` needs a gesture from an extension page, which the
   * sidebar can provide and the background cannot.
   */
  readonly origin: string | null;
}

let attachedTab: AttachedTab | null = null;

/**
 * The attachment, kept somewhere the service worker cannot forget.
 *
 * Chrome's MV3 background is torn down after ~30 s idle and every module-level
 * variable resets. The panel is a SEPARATE context that keeps its own copy, so
 * the observed symptom was the panel displaying "attached to tab 544578691"
 * while the background answered "no tab attached" to five clicks in a row - two
 * contexts disagreeing about state only one of them persisted.
 *
 * `storage.session` is the right store rather than `storage.local`: it is
 * in-memory and cleared when the browser closes, which is exactly the lifetime
 * of the activeTab grant it describes. Persisting it to disk would resurrect a
 * grant the browser no longer honours.
 */
/**
 * Whether the redacted screenshot travels to the server.
 *
 * OFF BY DEFAULT, and that is a hardware decision rather than a privacy one -
 * the pixels are already redacted and `BakedScreenshot` can only be minted by
 * `bakeRedactions`, so sending them is safe. It is the COST that is the problem.
 *
 * An image adds 1-2k vision tokens per step on top of ~4k of text, and it
 * requires a vision model, which is roughly 1 GB larger than its text-only
 * sibling. On a 6 GB laptop GPU with ~4.4 GB actually free once the browser has
 * its share, that combination is what pushes a model out of VRAM and into system
 * RAM - where it thrashes, and takes the machine down with it.
 *
 * The task barely needs it: the sanitized context already carries every
 * element's role, accessible name and geometry from the DOM, so choosing a ref
 * is a text problem. Turn this on to demonstrate the VLM path specifically, with
 * a vision model and headroom to spare.
 */
const SCREENSHOT_KEY = 'sih.sendScreenshot';
let sendScreenshot = true;

/**
 * How many tokens the prompt may occupy.
 *
 * Settable because it is a property of the SERVER, not of this extension, and
 * cannot be discovered: the OpenAI-compatible body has no field that reports the
 * context window. The default is sized for Ollama's out-of-the-box 4096, which
 * is safe everywhere and costs `box=` geometry on a large page - visible in the
 * panel as `geometry omitted`. A server with a bigger window keeps it.
 */
/**
 * Keep a user-entered budget inside what the rest of the system can honour.
 *
 * The floor is the scaffolding plus `minElements` - below it every step would
 * refuse and the panel would say the server was at fault. The ceiling is well
 * past any window this is likely to meet, and exists so a typo cannot
 * reintroduce the context-overflow 400 the budget was built to prevent.
 */
const MIN_PROMPT_TOKENS = 1200;
// Qwen's total context is 32,768 tokens. Keep the prompt below that so the
// 160-token response and request overhead still fit reliably.
const MAX_PROMPT_TOKENS = 32_000;

function clampBudget(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BUDGET_POLICY.maxPromptTokens;
  return Math.max(MIN_PROMPT_TOKENS, Math.min(MAX_PROMPT_TOKENS, Math.round(n)));
}

/**
 * Plan without touching the page.
 *
 * For pointing this at a real, logged-in site and checking what the redactor
 * actually strips before letting an agent click anything on it.
 */
/**
 * The clarification conversation.
 *
 * `ask_user` was fully plumbed - parse, validate, execute, a loop stop - and
 * went nowhere: the loop halted, the panel showed a reason, and there was no
 * route for a reply. These two hold the outstanding question and everything
 * answered so far, so a task can be resumed rather than restarted.
 *
 * NOT persisted. A clarification belongs to one task on one page; restoring it
 * after a reload would answer a question nobody had asked.
 */
let pendingQuestion: string | null = null;
let lastGoal: string | null = null;
let clarifications: { question: string; answer: string }[] = [];

const PLAN_ONLY_KEY = 'sih.planOnly';
let planOnly = false;

const BUDGET_KEY = 'sih.maxPromptTokens';
let maxPromptTokens = DEFAULT_BUDGET_POLICY.maxPromptTokens;

/**
 * Run the local vision model. Off by default, from measurement.
 *
 * A real run on a contended GPU: `infer exceeded 4000 ms` on every attempt,
 * three attempts, zero boxes returned, and steps taking 42-44 s of which ~40 s
 * was that wait. The step in the same run that skipped vision took 1.8 s.
 * `yolos-tiny` emits COCO classes that `labelToPiiKind` mostly cannot use, so
 * every detection in that run came from `scanDom`.
 *
 * Kept as a toggle rather than deleted: the architecture requires a local vision
 * model and `bench.ts` exists to choose a better one. This is how the comparison
 * is run, and how the vision path is demonstrated once the GPU is free.
 */
const VISION_KEY = 'sih.vision';
let visionEnabled = false;

/**
 * Longest edge of the image the server receives.
 *
 * 768 rather than the capture's 1280: a vision model reads layout, not detail,
 * and image tokens scale with area. Shrinking 1280 -> 768 is roughly a 2.5x
 * reduction in both bytes and vision tokens, which on a 6 GB laptop GPU already
 * holding a 3B VLM is the difference between fitting and thrashing.
 */
const SCREENSHOT_MAX_EDGE = 768;

const ATTACH_KEY = 'sih.attachedTab';

/**
 * The server origin the user granted, if any.
 *
 * Same storage and the same reasoning as the attached tab: the service worker
 * forgets it on teardown, and the panel is a separate context whose copy the
 * background cannot see. `storage.session` matches the lifetime of the
 * permission grant it describes.
 *
 * Null means PLAN LOCALLY. That is a real mode, not a degraded one - the whole
 * point of the project is that a step can run with nothing leaving the machine.
 */
const ORIGIN_KEY = 'sih.serverOrigin';

/**
 * WHICH DEPLOYMENT PLANS THE STEP.
 *
 * This replaced a single `serverOrigin: string | null`, where null meant
 * "on-device" and non-null meant "some server". That encoding could express two
 * of the four modes and could not tell a loopback Ollama apart from an
 * organisation's GPU server apart from a hosted API - so the panel could not
 * name the destination, the receipt could not record it, and the TLS rule could
 * not differ between them.
 *
 * All four entries are held at once, not just the selected one: the SIH
 * demonstration is the same task run against three deployments in a row, and
 * retyping an endpoint between them is how that goes wrong on stage.
 *
 * `storage.local`, like the other preferences. `storage.session` is cleared on
 * every extension reload, which is right for a grant the browser can withdraw
 * and wrong for a setting somebody typed - the context budget lived there once
 * and silently reverted to its default on every rebuild.
 */
const DEPLOYMENT_KEY = 'sih.deployment';

/**
 * The agent server this build was compiled against, or ''.
 *
 * Injected by `wxt.config.ts` from the `AGENT_ORIGIN` build variable, and
 * already validated there: https, no wildcard, a real hostname. An unset build
 * gets '', which is exactly the previous behaviour - nothing configured, the
 * user supplies an origin.
 */
declare const __AGENT_ORIGIN__: string;

function bakedAgentOrigin(): string {
  return typeof __AGENT_ORIGIN__ === 'string' ? __AGENT_ORIGIN__ : '';
}

/**
 * The starting deployment for a fresh install.
 *
 * With a baked origin: CLOUD, pre-configured, selected. The manifest declares a
 * host permission for that one origin, so there is nothing to grant and nothing
 * to type - the extension plans on first open.
 *
 * Without one: on-device, as before. A build with no server must not select a
 * backend it cannot reach, and must not reach a network address the user never
 * chose.
 *
 * SEEDED ONLY WHEN NOTHING IS STORED. A user who switches to on-device, or
 * points the cloud row somewhere else, must not have that undone by the next
 * service-worker restart - which is what re-applying this on every wake would
 * do, silently, to a data-sharing setting.
 */
function seededDeployment(): DeploymentConfig {
  const origin = bakedAgentOrigin();
  if (origin === '') return defaultDeployment();
  return {
    ...defaultDeployment(),
    backend: 'cloud',
    cloud: { endpoint: origin, model: '' },
  };
}

let deployment: DeploymentConfig = seededDeployment();

/**
 * Set when rehydration demoted a stored off-device selection to on-device.
 *
 * Held rather than broadcast at the moment it happens: rehydration runs at
 * module scope, before any panel is listening, so a `broadcastPanel` there would
 * reach nobody. It is reported on the next status query and on the next run, and
 * cleared once said.
 */
let demotedFrom: BackendKind | null = null;

/** Reports and clears a rehydration demotion. Called where a panel can hear it. */
function announceDemotion(): void {
  if (demotedFrom === null) return;
  const was = demotedFrom;
  demotedFrom = null;
  broadcastPanel({
    type: 'notice',
    scope: 'panel',
    message:
      `the ${was} backend was deselected: this browser no longer has permission to reach its ` +
      'server, so planning fell back to ON-DEVICE. Re-grant the URL in the AI backend section ' +
      'to use it again.',
  });
}

/**
 * Access tokens, by backend kind. SESSION STORAGE, NEVER LOCAL.
 *
 * Being honest about what this does and does not buy: `storage.session` is not
 * encrypted and is readable by this extension's own contexts. What it gives is
 * LIFETIME - it is in-memory and cleared when the browser closes, so a token is
 * not left on disk in the profile directory for the next person with the file
 * system. `storage.local` would persist it indefinitely, which for a bearer
 * credential is the wrong default.
 *
 * The cost is real and is the right trade: a token has to be re-entered after a
 * browser restart. An extension is not a secret store, and pretending otherwise
 * by persisting it would be the more comfortable and less honest choice.
 *
 * The token is read at REQUEST time by `HttpAgentClient` and goes into an
 * `authorization` header. It is never in a `PanelEvent`, never in a
 * `BackendDescriptor`, never in the receipt, never in the timeline, never
 * logged. `hasToken()` - a boolean - is the only thing the panel ever learns.
 */
const TOKEN_KEY = 'sih.backendTokens';

/**
 * KEYED BY ORIGIN, NOT BY BACKEND KIND. This was a real leak and it is worth
 * spelling out, because the kind-keyed version looked obviously correct.
 *
 * There is one `cloud` slot. Point it at `https://api.provider-a.example`, set
 * that provider's token, then later retype the same row as
 * `https://api.provider-b.example`. With a by-kind map the token survives the
 * endpoint change, and the panel's own success path calls `checkBackend()`
 * immediately - so provider A's bearer credential is in provider B's access log
 * before a single agent step has run, with no warning, and with the panel
 * showing nothing worse than "Access token: set for this backend".
 *
 * Keying by origin makes that structurally impossible rather than a thing to
 * remember: a re-pointed endpoint is a different key, so it simply has no token
 * and the request goes out unauthenticated. The user is told to enter one, which
 * is the correct prompt - they are talking to a different server.
 *
 * The old value shape (an object keyed by kind) is refused on rehydration for
 * the same reason: restoring it would reintroduce exactly the mis-binding.
 */
let backendTokens: Record<string, string> = {};

/**
 * The origin the selected backend will actually call, or null for on-device.
 *
 * Everything downstream that used to read `serverOrigin` reads this instead, so
 * there is one derivation of "are we off-device this step" rather than a
 * boolean recomputed at four call sites.
 */
function activeOrigin(): string | null {
  if (!isOffDevice(deployment.backend)) return null;
  const entry = selectedConfig(deployment);
  return entry.endpoint === '' ? null : entry.endpoint;
}

/** The origin a kind currently points at, or null. The token key. */
function originOf(kind: BackendKind): string | null {
  if (!isOffDevice(kind)) return null;
  const endpoint = configFor(deployment, kind).endpoint;
  return endpoint === '' ? null : endpoint;
}

/**
 * The token for whatever THIS kind points at right now.
 *
 * Resolved through the endpoint on every read, so re-pointing a row cannot carry
 * a credential across to a different host. Returns null when the row has no
 * endpoint or that endpoint has no token.
 */
function tokenFor(kind: BackendKind): string | null {
  const origin = originOf(kind);
  if (origin === null) return null;
  return backendTokens[origin] ?? null;
}

function hasToken(kind: BackendKind): boolean {
  return (tokenFor(kind) ?? '') !== '';
}

function deploymentEvent(): PanelEvent {
  return {
    type: 'backend/selected',
    descriptor: backendDescriptorFor(deployment, hasToken(deployment.backend)),
  };
}

function persistDeployment(): void {
  const store = localStore();
  void store?.set({ [DEPLOYMENT_KEY]: deployment })?.catch(() => {
    // A lost write costs a re-selection, not correctness.
  });
}

function persistTokens(): void {
  const store = sessionStore();
  void store?.set({ [TOKEN_KEY]: backendTokens })?.catch(() => {
    // A lost write costs a re-entry, not correctness.
  });
}

interface SessionStore {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

function sessionStore(): SessionStore | undefined {
  return (browser as unknown as { storage?: { session?: SessionStore } }).storage?.session;
}

/**
 * Where PREFERENCES live, as opposed to session state.
 *
 * `storage.session` is cleared when the extension reloads. That is right for the
 * attached tab and for anything tied to a grant the browser can withdraw; it is
 * wrong for a setting the user typed. The context budget was stored there, so
 * every reload silently reverted it to the 4096-safe default - and a real Amazon
 * run then sent 103 of 437 elements while the panel showed the number the user
 * had chosen being ignored.
 *
 * A preference the user set should outlive a rebuild.
 */
function localStore(): SessionStore | undefined {
  return (browser as unknown as { storage?: { local?: SessionStore } }).storage?.local;
}

/**
 * Rehydration, awaited before anything reads `attachedTab`.
 *
 * A message can arrive before this resolves - waking the worker IS what
 * delivers the message - so every reader waits on it rather than racing it.
 */
const attachedReady: Promise<void> = (async (): Promise<void> => {
  try {
    const store = sessionStore();
    if (store === undefined) return;

    /*
     * The server origin is NOT read here any more.
     *
     * It was restored from BOTH stores: unverified from session storage first,
     * then from local storage behind a `hasSiteAccess` check. The session read
     * ran first and set it unconditionally, so a stale value survived whenever
     * the verified one was rejected - two sources of truth for one setting, and
     * the weaker one winning. Only the checked read below remains.
     */

    /*
     * Preferences come from LOCAL storage, which survives an extension reload.
     * Session storage does not, and putting settings there meant every rebuild
     * quietly reset them to defaults.
     */
    const prefs = localStore();
    if (prefs !== undefined) {
      const savedShot = (await prefs.get(SCREENSHOT_KEY))[SCREENSHOT_KEY];
      if (typeof savedShot === 'boolean') sendScreenshot = savedShot;
      const savedVision = (await prefs.get(VISION_KEY))[VISION_KEY];
      if (typeof savedVision === 'boolean') visionEnabled = savedVision;
      const savedPlanOnly = (await prefs.get(PLAN_ONLY_KEY))[PLAN_ONLY_KEY];
      if (typeof savedPlanOnly === 'boolean') planOnly = savedPlanOnly;
      const savedBudget = (await prefs.get(BUDGET_KEY))[BUDGET_KEY];
      if (typeof savedBudget === 'number' && Number.isFinite(savedBudget)) {
        maxPromptTokens = clampBudget(savedBudget);
      }
      /*
       * The deployment is a preference too, and losing it is not harmless: with
       * none, the step falls back to the on-device baseline planner, which is a
       * different agent wearing the same panel. A whole Amazon run was read as
       * "the VLM did nothing" for exactly that reason.
       *
       * VERIFIED, not trusted - the same treatment the attached tab gets below.
       * A host permission is revocable independently of this value, and reaching
       * for a server we may no longer call is worse than starting with none. So
       * an off-device selection whose origin is no longer granted is DEMOTED to
       * on-device rather than kept: the alternative is a run that fails at the
       * plan stage with a host-permission string.
       */
      const savedDeployment = (await prefs.get(DEPLOYMENT_KEY))[DEPLOYMENT_KEY];
      const restored = coerceDeployment(savedDeployment);
      if (restored !== null) deployment = restored;
      else {
        // Nothing stored: this is a fresh install, so the build's own origin
        // applies. `seededDeployment()` already set it at module scope; the
        // legacy migration below only runs when there is no baked origin.
        deployment = seededDeployment();
        /*
         * MIGRATION from the single `serverOrigin` this replaced.
         *
         * Somebody who had granted http://localhost:8787 must not find the
         * setting blank after an update - "planning ON-DEVICE" would be shown
         * for a configuration they had already made, which is the same silent
         * substitution this whole change exists to prevent. Loopback becomes
         * `local`; anything else that survived the old validation was https and
         * becomes `private`, which is the conservative reading: it applies the
         * stricter TLS rule and does not assume somebody's server is a public
         * cloud.
         */
        const legacy = (await prefs.get(ORIGIN_KEY))[ORIGIN_KEY];
        if (typeof legacy === 'string' && legacy !== '') {
          const kind: BackendKind = legacy.startsWith('https://') ? 'private' : 'local';
          deployment = {
            ...defaultDeployment(),
            backend: kind,
            [kind]: { endpoint: legacy, model: '' },
          };
        }
      }

      if (isOffDevice(deployment.backend)) {
        const entry = selectedConfig(deployment);
        /*
         * A BAKED ORIGIN IS ALREADY GRANTED, by `host_permissions` in the
         * manifest, so `permissions.contains` reports it true - but checking it
         * at all would make a distribution build's first run depend on an API
         * answering correctly about a permission the browser granted at install.
         * Skipped by identity, so only the exact origin this build ships with
         * gets the exemption.
         */
        const baked = entry.endpoint !== '' && entry.endpoint === bakedAgentOrigin();
        if (!baked && (entry.endpoint === '' || !(await hasSiteAccess(entry.endpoint)))) {
          /*
           * SAID OUT LOUD. This is the one place the selection changes without a
           * click, and a silent one would be the exact failure the rest of this
           * feature exists to prevent - the user believing a run went to their
           * private server when it was planned on this device.
           *
           * It is still the right direction: the browser has withdrawn (or never
           * granted) permission to reach that origin, so the alternative is a
           * run that dies at the plan stage with a host-permission string. The
           * point is that it must be VISIBLE, and it is the safe direction -
           * towards not transmitting, never towards a different server.
           */
          const was = deployment.backend;
          deployment = { ...deployment, backend: 'on-device' };
          demotedFrom = was;
        }
      }
    }

    /*
     * Tokens come from SESSION storage, which is exactly the lifetime intended:
     * cleared when the browser closes, so a bearer credential is not left on
     * disk. A restart means re-entering it, and that is the trade.
     */
    const savedTokens = (await store.get(TOKEN_KEY))[TOKEN_KEY];
    if (typeof savedTokens === 'object' && savedTokens !== null) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(savedTokens as Record<string, unknown>)) {
        /*
         * ORIGINS ONLY. A key that is a BACKEND KIND is a value written by the
         * earlier by-kind version of this map, and restoring it would rebind
         * that credential to whatever endpoint the kind points at NOW - the
         * cross-host leak this keying exists to prevent. Dropped silently: the
         * store is session-scoped, so at worst the user re-enters a token they
         * entered in this same browser session.
         */
        if (isBackendKind(k)) continue;
        if (/^https?:\/\//.test(k) && typeof v === 'string' && v !== '') out[k] = v;
      }
      backendTokens = out;
    }
    const got = await store.get(ATTACH_KEY);
    const saved = got[ATTACH_KEY] as AttachedTab | undefined;
    if (saved === undefined) return;

    /*
     * Verified, not trusted. The tab may have been closed or navigated while
     * the worker was asleep, and both revoke activeTab. Restoring a grant the
     * browser has already withdrawn would turn a clear "click the toolbar
     * button" into an opaque host-permission rejection later.
     */
    const tab = (await browser.tabs.get(saved.tabId)) as { id?: number };
    if (tab.id === saved.tabId) attachedTab = saved;
    else await store.remove(ATTACH_KEY);
  } catch {
    // The tab is gone, or storage.session is unavailable. Either way: unattached.
    attachedTab = null;
  }
})();

/**
 * Reads a stored deployment back, refusing anything malformed.
 *
 * `storage.local` is ours, but it survives extension updates and downgrades, so
 * a value written by a different version of this file can arrive here. Returning
 * null on anything unexpected means the migration path below runs instead of a
 * half-populated config reaching `createAgentBackend` and failing at the plan
 * stage with a message about an endpoint nobody set.
 */
function coerceDeployment(raw: unknown): DeploymentConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!isBackendKind(obj['backend'])) return null;

  const entry = (key: 'local' | 'private' | 'cloud'): { endpoint: string; model: string } => {
    const v = obj[key];
    if (typeof v !== 'object' || v === null) return { endpoint: '', model: '' };
    const e = v as Record<string, unknown>;
    return {
      endpoint: typeof e['endpoint'] === 'string' ? e['endpoint'] : '',
      model: typeof e['model'] === 'string' ? e['model'] : '',
    };
  };

  return {
    backend: obj['backend'],
    local: entry('local'),
    private: entry('private'),
    cloud: entry('cloud'),
  };
}

function persistAttachment(): void {
  const store = sessionStore();
  if (store === undefined) return;
  void (attachedTab === null
    ? store.remove(ATTACH_KEY)
    : store.set({ [ATTACH_KEY]: attachedTab })
  ).catch(() => {
    // Losing the write costs a re-click, not correctness.
  });
}

function attachmentEvent(): PanelEvent {
  return {
    type: 'tab/attached',
    tabId: attachedTab?.tabId ?? null,
    note:
      attachedTab === null
        ? 'no tab attached - click the toolbar button on the page you want to drive'
        : `attached to tab ${attachedTab.tabId}`,
  };
}

/** Whether a persistent host permission already covers this origin. */
async function hasSiteAccess(origin: string | null): Promise<boolean> {
  if (origin === null) return false;
  const derived = deriveOriginPattern(origin);
  if (!derived.ok) return false;
  const permissions = (browser as unknown as {
    permissions?: { contains(p: { origins: string[] }): Promise<boolean> };
  }).permissions;
  if (permissions === undefined) return false;
  try {
    return await permissions.contains({ origins: [derived.value.pattern] });
  } catch {
    return false;
  }
}

/** Drops the grant and tells the panel, so the remedy can be specific. */
function detachTab(why: string): void {
  if (attachedTab === null) return;
  attachedTab = null;
  persistAttachment();
  broadcastPanel({ type: 'tab/attached', tabId: null, note: `page access lost: ${why}` });
}

const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';

/**
 * Ensures the content script is running in a tab, injecting it if not.
 *
 * This is the other half of dropping `<all_urls>`: nothing runs in any page
 * until something asks for it, and the ask is only legal because `activeTab`
 * was granted by the toolbar click. No host permission is declared or needed.
 *
 * Idempotent by ping rather than by bookkeeping. Injecting twice would register
 * a second onMessage listener and every command would be answered twice - and
 * the background cannot know from its own state whether a tab reloaded.
 */
async function ensureContentScript(tabId: number): Promise<boolean> {
  const tabs = browser.tabs as unknown as {
    sendMessage: (id: number, msg: unknown) => Promise<unknown>;
  };
  const scripting = (
    browser as unknown as {
      scripting?: {
        executeScript: (o: {
          target: { tabId: number };
          files: string[];
        }) => Promise<unknown>;
      };
    }
  ).scripting;

  try {
    const pong = (await tabs.sendMessage(tabId, { target: 'content', cmd: 'ping' })) as
      | { pong?: boolean }
      | undefined;
    if (pong?.pong === true) return true;
  } catch {
    // No receiver. Expected on a tab that has never been injected.
  }

  if (scripting === undefined) {
    throw new Error('browser.scripting is unavailable; cannot inject the content script');
  }

  await scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  return false;
}

function selectHost(): InferenceHost {
  // import.meta.env.FIREFOX is a build-time constant, so the unused backend is
  // tree-shaken out of each bundle rather than shipped to both.
  if (import.meta.env.FIREFOX) {
    /*
     * No keepAlive is passed, deliberately. MDN is explicit that "message ports
     * cannot prevent an event page from shutting down", so the port-based
     * keep-alive this class used to assume does not work on Gecko. The lever
     * that does work is an open visible view - the sidebar - which belongs to
     * the panel wiring, not here. Passing a keep-alive that does nothing would
     * be worse than passing none: it would read as solved.
     */
    return new FirefoxBackgroundPageHost({ createSession: createFirefoxSession });
  }
  return new ChromeOffscreenHost(extensionApi());
}

export default defineBackground(() => {
  const host = selectHost();

  /*
   * The toolbar button. Registered at TOP LEVEL of the background entry, not
   * inside any callback or await, so Gecko can prime the listener and wake the
   * event page from a cold start with the gesture still attached.
   *
   * This listener is also the only user gesture this extension will ever get,
   * so it is the place a future browser.permissions.request({ origins: [...] })
   * for the user-supplied server origin must go -- on the line AFTER
   * openPanel(), still synchronous, never after an await.
   */
  const action = actionApi();
  if (action === undefined) {
    console.warn(
      '[background] no browser.action - the `action` manifest key is missing, ' +
        'so there is no toolbar button and the panel is unreachable',
    );
  } else {
    action.onClicked.addListener((tab) => {
      // FIRST and synchronous - openPanel must not be preceded by any await, or
      // the gesture is forfeited and the panel never opens.
      openPanel(tab.windowId);

      /*
       * Everything after this point is allowed to be async: `executeScript`
       * needs the activeTab GRANT, not a gesture, and the grant was just made.
       * Injecting here rather than at run time removes a whole class of race -
       * by the time the user clicks Run, the content script is already in.
       */
      if (tab.id === undefined) return;
      const tabId = tab.id;
      attachedTab = { tabId, windowId: tab.windowId, grantedAt: Date.now(), origin: null };
      persistAttachment();
      broadcastPanel(attachmentEvent());

      /*
       * The origin is read separately because `tab.url` is only populated while
       * activeTab is live - which it is at this exact moment, and will not be
       * once the page navigates.
       */
      void browser.tabs
        .get(tabId)
        .then((t) => {
          const url = (t as { url?: string }).url;
          if (url === undefined || attachedTab?.tabId !== tabId) return;
          try {
            attachedTab = { ...attachedTab, origin: new URL(url).origin };
            persistAttachment();
            broadcastPanel(attachmentEvent());
          } catch {
            // Not a URL we can name an origin for (about:blank, view-source).
          }
        })
        .catch(() => {
          // Without the origin the panel simply cannot offer the grant.
        });
      void ensureContentScript(tab.id).catch((err: unknown) => {
        broadcastPanel({
          type: 'error',
          scope: 'panel',
          message: `could not inject into tab ${String(tab.id)}: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    });

    /*
     * activeTab dies with the page. Both of these fire without the `tabs`
     * permission (the changeInfo is redacted, which is enough to see a
     * navigation), so noticing costs nothing and saves the user a failure whose
     * message would otherwise be a raw host-permission string.
     */
    const tabsApi = (
      browser as unknown as {
        tabs?: {
          onRemoved?: { addListener: (cb: (tabId: number) => void) => void };
          onUpdated?: {
            addListener: (
              cb: (tabId: number, info: { status?: string; url?: string }) => void,
            ) => void;
          };
        };
      }
    ).tabs;
    tabsApi?.onRemoved?.addListener((tabId) => {
      if (attachedTab?.tabId === tabId) detachTab('the tab was closed');
    });
    tabsApi?.onUpdated?.addListener((tabId, info) => {
      if (attachedTab?.tabId !== tabId) return;
      if (info.status !== 'loading' && info.url === undefined) return;

      /*
       * Navigation revokes activeTab - but NOT a host permission the user
       * granted for this origin. Detaching regardless is what ended a working
       * multi-step run at step 5: the agent's own click changed the URL, and the
       * next step lost the access it needed.
       *
       * Asynchronous, and re-checked inside, because the tab may have been
       * replaced by the time the permission answer arrives.
       */
      const current = attachedTab;
      void (async (): Promise<void> => {
        try {
          const tab = (await browser.tabs.get(current.tabId)) as { url?: string };
          const origin = tab.url === undefined ? current.origin : new URL(tab.url).origin;
          const granted = await hasSiteAccess(origin);
          if (attachedTab?.tabId !== current.tabId) return;
          if (granted) {
            attachedTab = { ...attachedTab, origin };
            persistAttachment();
            broadcastPanel({
              type: 'notice',
              scope: 'panel',
              message: `page navigated - access retained via ${String(origin)}`,
            });
            return;
          }
          detachTab('the page navigated to a site without persistent page access');
        } catch {
          // The tab may be between redirect targets; the next update retries.
        }
      })();
    });
  }

  /**
   * One agent step, driven from the panel.
   *
   * This is the first caller `runAgentStep` has ever had. Everything it needs
   * that is browser-bound is supplied here and nowhere else:
   *
   *   snapshot  -> the content script, which owns the DOM
   *   capture   -> captureVisibleTab, callable only from the background
   *   host      -> the offscreen document (Chrome) / this page (Firefox)
   *   client    -> LocalPlannerClient: on-device, no network, no server
   *   execute   -> back to the content script
   *
   * The client is the local baseline deliberately. It makes the whole pipeline
   * runnable today with nothing leaving the machine, and because `PlanOutcome`
   * carries a raw string rather than a typed Action, its output still goes
   * through parseAction and validateAction exactly like a remote server's would.
   * Swapping in HttpAgentClient later changes this one line and nothing else.
   */
  /*
   * Where redact and sanitize run, chosen per engine.
   *
   * Firefox's background is an event page WITH a DOM, so it does the work
   * in-process - which is why Firefox completed the whole loop while Chrome
   * failed at "redact: DOMParser is not defined" on every step. Chrome's MV3
   * background is a service worker with no DOM, so the work is forwarded to the
   * offscreen document, which exists for exactly this class of problem.
   *
   * `import.meta.env.FIREFOX` is a build-time constant, so the branch not taken
   * is tree-shaken out of each bundle rather than shipped to both.
   */
  const domPipeline = import.meta.env.FIREFOX
    ? createInProcessDomPipeline()
    : createRemoteDomPipeline((cmd, payload) => host.request<unknown>(cmd, payload));

  const capture = new BrowserCaptureAdapter({
    /*
     * captureVisibleTab is per-WINDOW, not per-tab.
     *
     * It grabs whatever tab is currently VISIBLE in the window it is given -
     * the tabId is not a selector. So if the user switches tabs after
     * attaching, this would happily return a screenshot of a completely
     * different page while the DOM snapshot came from the attached one. Vision
     * boxes would then be merged against markup they do not belong to, and the
     * redaction log would look plausible and be wrong.
     *
     * Nothing about that failure is visible downstream, so it is checked here:
     * capture only proceeds while the attached tab is the active one.
     */
    captureVisibleTab: async (tabId, opts) => {
      const target = attachedTab;
      if (target === null || target.tabId !== tabId) {
        throw new Error(
          'the page access grant was lost after navigation; click Grant page access for this site and run the task again',
        );
      }
      const tab = (await browser.tabs.get(tabId)) as { active?: boolean; windowId?: number };
      if (tab.active !== true) {
        throw new Error(
          `capture: tab ${tabId} is not the visible tab in its window, so the ` +
            'screenshot would show a different page than the snapshot',
        );
      }
      return browser.tabs.captureVisibleTab(target.windowId, opts);
    },
  });
  /**
   * Builds the backend the current settings select. Once per step, on purpose.
   *
   * Not cached: a changed endpoint, a newly entered token or a switched kind
   * must take effect on the NEXT step, not on the next service-worker restart.
   * Construction is a few field reads and an object, so there is nothing to
   * amortise.
   *
   * Throws when an off-device backend is selected with no usable endpoint. That
   * refusal is the point - see `createAgentBackend`. Falling back to on-device
   * would plan the step with a different agent while the panel still showed the
   * selected one.
   */
  function buildBackend(): AgentBackend {
    return createAgentBackend(deployment, {
      clientVersion: 'sih26171-dev',
      // Read at request time and resolved THROUGH THE ENDPOINT, so a re-pointed
      // row cannot carry a credential to a different host. Never enters the
      // descriptor.
      authTokenFor: (kind) => tokenFor(kind),
      localPlanner: {
        onTrace: (trace) =>
          broadcastPanel({
            type: 'notice',
            scope: 'panel',
            message: `planner: ${trace.reason} (considered ${trace.consideredElements})`,
          }),
      },
    });
  }

  /**
   * Wraps a backend so a TRANSPORT failure raises the no-fallback prompt.
   *
   * Only `kind: 'transport'` - the server was not reached, or answered 5xx.
   * Everything else is deliberately excluded and each exclusion matters:
   *
   *  - `refused` is OUR egress gate firing. Offering to switch backends because
   *    our own redaction check blocked a payload would be the single worst
   *    possible response to it.
   *  - `protocol` includes 401 and 403. The server is UP and said no; "private
   *    server unavailable, use cloud instead?" would be a wrong diagnosis
   *    attached to a data-sharing decision.
   *
   * And what it does with a transport failure is: emit an event. It does not
   * retry, does not queue, and above all does not try another backend. The
   * alternatives are rendered as buttons in the panel and a switch requires a
   * click, which changes the stored selection and lands on the next receipt.
   */
  /**
   * How long a plan may take before the user is told it is still coming.
   *
   * A warm request is a few hundred milliseconds. A free-tier instance that has
   * gone to sleep takes tens of seconds to accept the first one - during which,
   * without this, the panel shows a step that started and nothing else, and the
   * honest reading is that the agent hung.
   */
  const SLOW_PLAN_NOTICE_MS = 2_500;

  function withFailureReporting(backend: AgentBackend): AgentBackend {
    return {
      descriptor: backend.descriptor,
      health: (signal) => backend.health(signal),
      plan: async (req, signal) => {
        /*
         * A PROGRESS NOTICE, NOT A RETRY AND NOT A FALLBACK.
         *
         * Free hosting sleeps after inactivity and takes tens of seconds to
         * wake. The step's own timeout is 60 s, which is long enough to survive
         * that - so the request will very likely succeed, and the only thing
         * missing is telling the user why they are waiting. Silence here reads
         * as a hang, and a hang is what makes someone reach for a different
         * backend, which is the decision this whole design exists to keep
         * deliberate.
         *
         * Off-device only: an on-device plan that takes 2.5 s has a different
         * problem, and this message would be a wrong explanation of it.
         */
        const slow =
          backend.descriptor.offDevice
            ? setTimeout(() => {
                broadcastPanel({
                  type: 'notice',
                  scope: 'backend',
                  message:
                    `Connecting to the AI server at ${backend.descriptor.endpoint ?? 'the configured endpoint'}... ` +
                    'a free-tier server can take up to a minute to wake from sleep. ' +
                    'Nothing has been sent anywhere else.',
                });
              }, SLOW_PLAN_NOTICE_MS)
            : null;

        const outcome = await backend.plan(req, signal).finally(() => {
          if (slow !== null) clearTimeout(slow);
        });
        if (!outcome.ok && outcome.error.kind === 'transport') {
          /*
           * A TIMEOUT ON A COLD SERVER IS STILL REPORTED, and still offers the
           * alternatives - it is a genuine failure of this step. What changes is
           * the WORDING: "did not answer in time" invites Retry, which on a
           * free tier is very likely to succeed because the first request is
           * what woke it. "Could not reach" invites a different decision.
           *
           * Retry is already the first button. Nothing switches on its own.
           */
          const timedOut = /timed?\s*out|timeout|did not answer/i.test(outcome.error.error);
          broadcastPanel({
            type: 'backend/unavailable',
            unavailable: {
              kind: backend.descriptor.kind,
              endpoint: backend.descriptor.endpoint,
              error: timedOut
                ? `${outcome.error.error} - a sleeping free-tier server usually answers on the second try`
                : outcome.error.error,
              alternatives: alternativesTo(deployment, backend.descriptor.kind),
            },
          });
        }
        return outcome;
      },
    };
  }

  /*
   * Session identity, from the CSPRNG.
   *
   * These were `Math.random()` - 32 bits from a generator with no security
   * claim - while `newSessionSalt()` existed for exactly this purpose and
   * documents that it refuses to fall back to Math.random.
   *
   * The nonce is the whole defence against a hostile page printing a
   * placeholder-shaped string and convincing the server a field was redacted
   * when it was not. A guessable nonce makes that forgery cheap, and the failure
   * is silent on both ends.
   */
  const taskId = `task-${Date.now().toString(36)}`;
  let stepCounter = 0;
  /** Accumulated so the planner can tell what it has already tried. */
  const history: ExecutedStep[] = [];
  /*
   * Set by `agent/stop`, read between steps by the loop.
   *
   * A flag rather than an AbortSignal because the loop checks it BEFORE each
   * step: the useful guarantee is "no further action on the page", and aborting
   * mid-step would leave a click already dispatched.
   */
  let stopRequested = false;
  let loopRunning = false;

  /**
   * Why the deployment cannot be changed mid-task.
   *
   * `runTask` builds ONE backend and one `StepInput` and hands them to
   * `runAgentLoop`, which reuses both for up to eight steps - so a switch made
   * while a loop is running takes effect on NOTHING. The panel would show
   * "On-device (no network)" and stamp it on the receipt while the loop kept
   * POSTing to the cloud it started with. That is the audit trail lying in the
   * most damaging direction, and it defeats the most intuitive way a nervous
   * user would try to stop transmission.
   *
   * REFUSED rather than made live, deliberately. Making the client rebuild per
   * step is easy; making `allowedOrigins`, `transport`, `screenshot` and the
   * reported `backend` follow it is not, and a run whose destination changes
   * halfway is an ambiguous thing to record anyway. Stop is the answer, and Stop
   * already works and takes effect before the next step touches the page.
   */
  function deploymentLocked(): string | null {
    return loopRunning
      ? 'a task is running - press Stop before changing the AI backend, so the change ' +
          'applies to a whole run rather than to part of one'
      : null;
  }

  /**
   * Is this the browser saying "nobody is listening"?
   *
   * Chrome and Firefox word it differently and neither gives it a code, so the
   * string is all there is. Matched narrowly: a content script that ran and
   * reported its own failure must NOT be retried, because retrying would re-run
   * an action that already happened.
   */
  function isNoReceiver(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err);
    return (
      m.includes('Receiving end does not exist') ||
      m.includes('Could not establish connection') ||
      m.includes('message port closed')
    );
  }

  async function contentRequest<T>(tabId: number, cmd: string, payload?: unknown): Promise<T> {
    const send = async (): Promise<{ ok?: boolean; error?: string } & Record<string, unknown>> =>
      (await browser.tabs.sendMessage(tabId, {
        target: 'content',
        cmd,
        payload,
      })) as { ok?: boolean; error?: string } & Record<string, unknown>;

    let reply;
    try {
      reply = await send();
    } catch (err) {
      /*
       * THE LOOP NAVIGATES ITSELF OUT OF ITS OWN CONTENT SCRIPT.
       *
       * `ensureContentScript` ran once, before the first step. Then step 1
       * clicked a link, the document was replaced, and the new one has no
       * content script - so step 2's snapshot failed with "Could not establish
       * connection. Receiving end does not exist." and the task stopped, one
       * step after starting to work.
       *
       * This is the injection twin of the activeTab problem CLAUDE.md already
       * describes: the loop's own clicks navigate, and each navigation destroys
       * something the next step needs. There the casualty was the permission;
       * here it is the script. The permission survives now - the panel logged
       * "page navigated - access retained" on the same run - so re-injecting is
       * all that is missing.
       *
       * Retried ONCE, and only for "nobody is listening". A content script that
       * ran and returned an error is reported as-is: re-sending `execute` after
       * a real failure could perform the action twice.
       */
      if (!isNoReceiver(err)) throw err;
      await ensureContentScript(tabId);
      reply = await send();
    }

    if (reply?.ok !== true) throw new Error(reply?.error ?? `content ${cmd} failed`);
    return reply as unknown as T;
  }

  /**
   * Runs the whole task, bounded.
   *
   * Shares every seam with `runOneStep` - the difference is only that the loop
   * decides when to stop. The stop conditions live in `orchestrator/loop.ts`
   * where they are tested; this supplies the two things only the extension can
   * know: whether the user pressed Stop, and whether the page changed.
   */
  /**
   * The seams a step needs, in one place.
   *
   * Shared by the single-step button and the loop so they cannot drift - a loop
   * that planned differently from a step would be a different agent wearing the
   * same name.
   */
  function stepDeps(_tabId: number) {
    return {
      snapshot: (id: number) => contentRequest<{ html: string; viewport: never }>(id, 'snapshot'),
      capture,
      host,
      /*
       * Asked of the HOST, not of this worker.
       *
       * The model, the decoded frames and the ORT arena all live in the
       * offscreen document; a service worker's own heap is unrelated to any of
       * them. The metric was previously never supplied at all, so every step
       * reported `0.0 MB (derived-from-model-bytes)` - a placeholder that the
       * resource metric, 20% of the score, was resting on.
       *
       * Falls back to the derived figure rather than to zero when the host
       * cannot answer: `MemorySource` exists so a number never has to pretend.
       */
      sampleMemory: async (): Promise<MemoryReading> => {
        try {
          const st = await host.request<{ heap?: MemoryReading | null }>('status', {});
          return st.heap ?? unmeasuredMemory();
        } catch {
          return unmeasuredMemory();
        }
      },
      /*
       * WHICHEVER DEPLOYMENT IS SELECTED, AND IT CHANGES NOTHING ELSE.
       *
       * On-device, local, private and cloud all return a RAW STRING, so every
       * one of them goes through parseAction + validateAction before anything
       * touches the page - which is what makes trusting none of them safe. The
       * three off-device kinds are one `HttpAgentClient` with a different
       * endpoint, so the egress gate inside it cannot be true of one and false
       * of another.
       */
      client: withFailureReporting(buildBackend()),
      dom: domPipeline,
      execute: async (
        id: number,
        action: Action,
        domPath: string | null,
        target: TargetIdentity | null,
      ) => {
        const reply = await contentRequest<{ result: { ok: boolean; note: string } }>(
          id,
          'execute',
          { action, domPath, target },
        );
        return reply.result;
      },
      showPrivacyLens: async (id: number, regions: readonly PrivacyLensRegion[]) => {
        await contentRequest<Record<string, never>>(id, 'privacy/lens', {
          enabled: regions.length > 0,
          regions,
        });
      },
      emit: broadcastPanel,
    };
  }

  async function runTask(
    goal: string,
  ): Promise<{ ok: boolean; error?: string; reason?: string; actionsTaken?: number }> {
    /*
     * WHICH PLANNER, ON EVERY RUN.
     *
     * There was a notice for this, but it fired only when the ORIGIN CHANGED -
     * so a run that never had a server origin said nothing at all, and the only
     * evidence of falling back to the on-device baseline was the ABSENCE of a
     * `planning via ...` line. A real Amazon run was read as "the VLM did
     * nothing" when the VLM had never been asked.
     *
     * A run should say what planned it. Absence of a line is not a signal.
     */
    /*
     * A DIFFERENT GOAL IS A DIFFERENT CONVERSATION.
     *
     * Answers about which MacBook do not carry over to booking a flight, and
     * feeding stale ones back would have the model act on a question nobody
     * asked in this task. Resuming the SAME goal keeps them, which is the whole
     * point of holding them at all.
     */
    if (goal !== lastGoal) {
      clarifications = [];
      pendingQuestion = null;
      lastGoal = goal;
    }

    await attachedReady;
    /*
     * AFTER rehydration, deliberately.
     *
     * This fired before `await attachedReady` and therefore read `serverOrigin`
     * before storage had been restored - so a run planned by qwen2.5vl-8k
     * announced itself as "planning ON-DEVICE (heuristic baseline)". A line added
     * to remove a blind spot was reporting the opposite of what happened, which
     * is worse than the silence it replaced.
     */
    /*
     * WHICH DEPLOYMENT, ON EVERY RUN, AFTER REHYDRATION.
     *
     * This used to fire only when the origin CHANGED, so a run that never had
     * one said nothing at all and the only evidence of the on-device baseline
     * was the ABSENCE of a line. A real Amazon run was read as "the VLM did
     * nothing" when the VLM had never been asked. Absence is not a signal.
     *
     * It also has to come AFTER `await attachedReady`: fired before it, this
     * read the deployment before storage had been restored, and a run planned by
     * qwen2.5vl announced itself as on-device. A line added to remove a blind
     * spot was reporting the opposite of what happened.
     */
    announceDemotion();
    broadcastPanel(deploymentEvent());
    broadcastPanel({
      type: 'notice',
      scope: 'panel',
      message:
        activeOrigin() === null
          ? 'planning ON-DEVICE (heuristic baseline) - nothing leaves this machine'
          : `planning via the ${deployment.backend} backend at ${String(activeOrigin())}`,
    });

    if (attachedTab === null) {
      return {
        ok: false,
        error:
          'no tab attached - click the toolbar button on the page you want to drive, then try again',
      };
    }
    const { tabId } = attachedTab;

    if (!(await hasSiteAccess(attachedTab.origin))) {
      return {
        ok: false,
        error:
          'multi-step tasks require persistent page access; click Grant page access for this site before running the task',
      };
    }

    broadcastPanel(await hostStatusEvent(host));
    /*
     * THE MODEL IS NO LONGER A PREREQUISITE, and it should never have been one
     * for the default configuration.
     *
     * Vision is OFF by default from measurement, so the default run loads no
     * model - and yet this refused every step until somebody pressed "Load
     * model" and waited for weights and a WebGPU adapter that then went unused.
     * The two calls a text-only step makes of the worker, `retain` and `bake`,
     * do not read the model at all; they used to demand one through a circular
     * `#ready()` check that `runtime.ts` no longer makes.
     *
     * Vision ON is different: `detect` genuinely needs the weights. The load is
     * started automatically when the panel opens, so this is a wait rather than
     * a refusal - and if it has not finished, the step degrades to a DOM-only
     * one exactly as `step.ts` already does when the vision breaker trips.
     */
    if (visionEnabled && modelState.phase !== 'loaded') {
      void ensureModelLoading(host);
      broadcastPanel({
        type: 'notice',
        scope: 'perception',
        message:
          modelState.phase === 'failed'
            ? `the local vision model failed to load (${modelState.error}); this run uses the DOM scan only`
            : 'the local vision model is still loading; this run uses the DOM scan only',
      });
    }
    await ensureContentScript(tabId);

    const tab = (await browser.tabs.get(tabId)) as { url?: string };
    const outcome = await runAgentLoop(
      {
        ...stepDeps(tabId),
        pageFingerprint: async (id) => {
          const reply = await contentRequest<{ fingerprint: string }>(id, 'fingerprint');
          return reply.fingerprint;
        },
      },
      {
        tabId,
        taskId,
        step: 1,
        goal,
        url: tab.url ?? 'about:blank',
        nonce: sessionNonce,
        salt: sessionSalt,
        allowedOrigins: activeOrigin() === null ? [] : [String(activeOrigin())],
        captureOptions: DEFAULT_CAPTURE,
        /*
         * The REDACTED screenshot goes to a server and nowhere else.
         *
         * The brief asks for "transmission of the anonymized visual context to a
         * centralized LLM/VLM", and without this the context carries
         * `screenshot: null` - so a vision model would be used as a text-only
         * one, which is not the deliverable.
         *
         * Off for the on-device baseline: it has no use for pixels, and baking
         * them costs a canvas pass per step for nothing. The pixels that DO go
         * have been through `bakeRedactions`, and `BakedScreenshot` is a type
         * only that function can mint, so there is no path that sends a raw
         * frame.
         */
        screenshot: sendScreenshot && activeOrigin() !== null,
        transport: activeOrigin() === null ? 'on-device' : 'cloud',
        // Reported only. Nothing in `runAgentStep` branches on it - the pipeline
        // above the egress gate is identical for all four kinds.
        backend: deployment.backend,
        vision: visionEnabled,
        budget: { ...DEFAULT_BUDGET_POLICY, maxPromptTokens },
        planOnly,
        clarifications,
        history,
      },
      { shouldStop: () => stopRequested },
    );

    /*
     * A QUESTION IS AN OUTCOME, NOT A FAILURE.
     *
     * The loop stops on `ask_user` and until now that was the end of it - the
     * panel reported a reason and the question itself was discarded with the
     * action. Holding it here is what lets the user answer and the same task
     * continue, instead of being retyped from the start.
     */
    if (outcome.reason === 'ask_user' && outcome.lastAction?.type === 'ask_user') {
      pendingQuestion = outcome.lastAction.question;
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        message: 'the agent needs one answer before it can continue',
      });
    }

    // `done` is the only reason that means the task was accomplished. Reporting
    // ok:true for max-steps or no-progress would be the panel lying.
    /*
     * `done` HAVING DONE NOTHING IS REPORTED AS SUCH.
     *
     * On amazon.in the model returned `done` on step 1 without touching the page
     * - no MacBook on the homepage, no obvious move, so it declared success -
     * and the panel said "Done." That is the panel asserting something it cannot
     * know, and it is the exact failure this project keeps naming: a confident
     * report about something that was never checked.
     *
     * Still ok:true, because a goal CAN be met without acting ("am I signed
     * in?"). The caller is told which happened rather than being left to assume.
     */
    return outcome.reason === 'done'
      ? { ok: true, reason: outcome.reason, actionsTaken: outcome.actionsTaken }
      : { ok: false, reason: outcome.reason, error: outcome.error ?? outcome.reason };
  }

  async function runOneStep(goal: string): Promise<{ ok: boolean; error?: string }> {
    /*
     * WHICH PLANNER, ON EVERY RUN.
     *
     * There was a notice for this, but it fired only when the ORIGIN CHANGED -
     * so a run that never had a server origin said nothing at all, and the only
     * evidence of falling back to the on-device baseline was the ABSENCE of a
     * `planning via ...` line. A real Amazon run was read as "the VLM did
     * nothing" when the VLM had never been asked.
     *
     * A run should say what planned it. Absence of a line is not a signal.
     */
    /*
     * A DIFFERENT GOAL IS A DIFFERENT CONVERSATION.
     *
     * Answers about which MacBook do not carry over to booking a flight, and
     * feeding stale ones back would have the model act on a question nobody
     * asked in this task. Resuming the SAME goal keeps them, which is the whole
     * point of holding them at all.
     */
    if (goal !== lastGoal) {
      clarifications = [];
      pendingQuestion = null;
      lastGoal = goal;
    }

    // The worker may have just woken up to handle this very message.
    await attachedReady;
    /*
     * AFTER rehydration, deliberately.
     *
     * This fired before `await attachedReady` and therefore read `serverOrigin`
     * before storage had been restored - so a run planned by qwen2.5vl-8k
     * announced itself as "planning ON-DEVICE (heuristic baseline)". A line added
     * to remove a blind spot was reporting the opposite of what happened, which
     * is worse than the silence it replaced.
     */
    /*
     * WHICH DEPLOYMENT, ON EVERY RUN, AFTER REHYDRATION.
     *
     * This used to fire only when the origin CHANGED, so a run that never had
     * one said nothing at all and the only evidence of the on-device baseline
     * was the ABSENCE of a line. A real Amazon run was read as "the VLM did
     * nothing" when the VLM had never been asked. Absence is not a signal.
     *
     * It also has to come AFTER `await attachedReady`: fired before it, this
     * read the deployment before storage had been restored, and a run planned by
     * qwen2.5vl announced itself as on-device. A line added to remove a blind
     * spot was reporting the opposite of what happened.
     */
    announceDemotion();
    broadcastPanel(deploymentEvent());
    broadcastPanel({
      type: 'notice',
      scope: 'panel',
      message:
        activeOrigin() === null
          ? 'planning ON-DEVICE (heuristic baseline) - nothing leaves this machine'
          : `planning via the ${deployment.backend} backend at ${String(activeOrigin())}`,
    });

    if (attachedTab === null) {
      return {
        ok: false,
        error:
          'no tab attached - click the toolbar button on the page you want to drive, then try again',
      };
    }
    const { tabId } = attachedTab;

    /*
     * Reconcile before stepping, and refuse early if the model is not there.
     *
     * On Firefox an event-page unload takes the loaded model with it; on Chrome
     * a service-worker teardown makes this context forget a model that is still
     * resident. Either way, discovering it inside `detect` produces an internal
     * error about init not having been awaited, which reads as a broken pipeline
     * rather than as the recoverable "press Load model again" that it is.
     */
    broadcastPanel(await hostStatusEvent(host));
    // Same reasoning as `runTask`: only the vision path needs the weights, and
    // a missing model degrades the step rather than refusing it.
    if (visionEnabled && modelState.phase !== 'loaded') {
      void ensureModelLoading(host);
      broadcastPanel({
        type: 'notice',
        scope: 'perception',
        message:
          modelState.phase === 'failed'
            ? `the local vision model failed to load (${modelState.error}); this step uses the DOM scan only`
            : 'the local vision model is still loading; this step uses the DOM scan only',
      });
    }

    // Idempotent: normally already injected at grant time, but a re-injection
    // here is what makes the button work after a benign re-render.
    await ensureContentScript(tabId);

    const tab = (await browser.tabs.get(tabId)) as { url?: string };
    const url = tab.url ?? 'about:blank';

    stepCounter += 1;
    const result = await runAgentStep(
      stepDeps(tabId),
      {
        tabId,
        taskId,
        step: stepCounter,
        goal,
        url,
        nonce: sessionNonce,
        salt: sessionSalt,
        /*
         * Only the origin the user actually granted. Empty while planning
         * locally, because a baseline that reaches no network has no business
         * navigating anywhere - and a `navigate` to any other origin is refused
         * by `validateAction` regardless of what the server asks for.
         */
        allowedOrigins: activeOrigin() === null ? [] : [String(activeOrigin())],
        vision: visionEnabled,
        captureOptions: DEFAULT_CAPTURE,
        budget: { ...DEFAULT_BUDGET_POLICY, maxPromptTokens },
        planOnly,
        screenshot: sendScreenshot && activeOrigin() !== null,
        transport: activeOrigin() === null ? 'on-device' : 'cloud',
        // Reported only. Nothing in `runAgentStep` branches on it - the pipeline
        // above the egress gate is identical for all four kinds.
        backend: deployment.backend,
        history,
      },
    );

    if (!result.ok) return { ok: false, error: `${result.stage}: ${result.error}` };

    /*
     * Recorded AFTER the step, so the next plan can see it. Without this the
     * baseline planner re-picks the same element every time: the page changes,
     * that element keeps the best name, it wins again.
     */
    const { action, error } = result.outcome;
    // `action` is nullable in StepOutcome - a step can succeed having planned
    // nothing. Recording a null as an attempt would make the planner skip a ref
    // it never tried.
    if (action !== null) {
      history.push({
        step: result.outcome.step,
        actionType: action.type,
        ref: 'ref' in action ? action.ref : null,
        /*
         * Resolved HERE, against the context this step actually sent.
         *
         * Not later from a ref: refs are positional ordinals renumbered every
         * step, so by the next step this one may name a different element.
         */
        name:
          ('ref' in action
            ? (result.outcome.context.elements.find((e) => e.ref === action.ref)?.name?.text ??
              null)
            : null),
        ok: error === null,
        note: error ?? '',
      });
    }
    return { ok: true };
  }

  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { target?: string; cmd?: string } | null;
    if (msg === null || msg.target !== 'background') return undefined;

    if (msg.cmd === 'host/stop') {
      return host.stop().then(() => ({ ok: true }));
    }
    if (msg.cmd === 'content/ensure') {
      const tabId = (msg as { tabId?: number }).tabId;
      if (typeof tabId !== 'number') {
        return Promise.resolve({ ok: false, error: 'content/ensure requires a numeric tabId' });
      }
      return ensureContentScript(tabId).then(
        (alreadyRunning) => ({ ok: true, alreadyRunning }),
        (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    if (msg.cmd === 'agent/stop') {
      stopRequested = true;
      broadcastPanel({ type: 'notice', scope: 'panel', message: 'stop requested' });
      return Promise.resolve({ ok: true });
    }
    if (msg.cmd === 'privacy/lens/clear') {
      return attachedReady.then(async () => {
        if (attachedTab === null) {
          return { ok: false, error: 'no page is attached' };
        }
        try {
          await contentRequest<Record<string, never>>(attachedTab.tabId, 'privacy/lens', {
            enabled: false,
            regions: [],
          });
          broadcastPanel({
            type: 'notice',
            scope: 'privacy lens',
            message: 'live page mask cleared; the baked proof remains available',
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
    }

    if (msg.cmd === 'agent/run') {
      const goal = String((msg as { goal?: unknown }).goal ?? '').trim();
      if (goal === '') return Promise.resolve({ ok: false, error: 'enter a goal first' });
      if (loopRunning) return Promise.resolve({ ok: false, error: 'a task is already running' });

      stopRequested = false;
      loopRunning = true;
      return runTask(goal)
        .then(
          (r) => r,
          (err: unknown) => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => {
          loopRunning = false;
        });
    }

    if (msg.cmd === 'agent/step') {
      const goal = String((msg as { goal?: unknown }).goal ?? '').trim();
      if (goal === '') {
        return Promise.resolve({ ok: false, error: 'enter a goal first' });
      }
      return runOneStep(goal).then(
        (r) => r,
        (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    if (msg.cmd === 'vision/enabled') {
      const on = (msg as { enabled?: unknown }).enabled === true;
      visionEnabled = on;
      const store = localStore();
      void store?.set({ [VISION_KEY]: on })?.catch(() => {
        // A lost write costs a re-toggle, not correctness.
      });
      /*
       * Turning it ON is the clearest possible statement that the weights are
       * wanted, so the load starts here rather than on the first step that needs
       * them - which would put a cold load inside a step's latency budget.
       */
      if (on) ensureModelLoading(host);
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        message: on
          ? 'local vision model ON - loading now if it is not already; the DOM scan runs either way'
          : 'local vision model OFF - detections from the DOM scan only',
      });
      return Promise.resolve({ ok: true, enabled: on });
    }
    if (msg.cmd === 'task/question') {
      return Promise.resolve({ ok: true, question: pendingQuestion });
    }
    if (msg.cmd === 'task/answer') {
      const raw = (msg as { answer?: unknown }).answer;
      const answer = typeof raw === 'string' ? raw.trim().slice(0, 400) : '';
      if (pendingQuestion === null || answer === '') {
        return Promise.resolve({ ok: false, error: 'no question is outstanding' });
      }
      clarifications.push({ question: pendingQuestion, answer });
      pendingQuestion = null;
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        message: `answered: ${answer.slice(0, 80)}`,
      });
      return Promise.resolve({ ok: true });
    }
    if (msg.cmd === 'plan-only') {
      planOnly = (msg as { enabled?: unknown }).enabled === true;
      const store = localStore();
      void store?.set({ [PLAN_ONLY_KEY]: planOnly })?.catch(() => {});
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        message: planOnly
          ? 'PLAN ONLY - the agent will decide but not click'
          : 'plan only OFF - actions will be executed',
      });
      return Promise.resolve({ ok: true });
    }
    if (msg.cmd === 'vision/get') {
      // The panel cannot derive this and needs it to render the toggle and to
      // decide whether a missing model is worth mentioning at all.
      return Promise.resolve({ ok: true, enabled: visionEnabled });
    }
    if (msg.cmd === 'plan-only/get') {
      return Promise.resolve({ ok: true, enabled: planOnly });
    }
    if (msg.cmd === 'budget/get') {
      // The panel cannot derive this: it is stored here and survives the panel
      // being closed and reopened. Without it the input shows a default while a
      // different value is in force, which is exactly the disagreement the
      // `tokenBudget` field on PanelState was added to prevent.
      return Promise.resolve({ ok: true, tokens: maxPromptTokens });
    }
    if (msg.cmd === 'budget/tokens') {
      /*
       * Clamped, not trusted. The panel is ours, but a value of 0 would refuse
       * every step and a huge one would reintroduce the 400 this budget exists
       * to prevent - and the failure would look like a server problem.
       */
      const asked = Number((msg as { tokens?: unknown }).tokens);
      maxPromptTokens = clampBudget(asked);
      const store = localStore();
      void store?.set({ [BUDGET_KEY]: maxPromptTokens })?.catch(() => {
        // A lost write costs a re-entry, not correctness.
      });
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        message:
          `context budget ${String(maxPromptTokens)} tokens` +
          (maxPromptTokens === asked ? '' : ` (clamped from ${String(asked)})`),
      });
      return Promise.resolve({ ok: true, tokens: maxPromptTokens });
    }
    if (msg.cmd === 'vision/screenshot') {
      const on = (msg as { enabled?: unknown }).enabled === true;
      sendScreenshot = on;
      const store = localStore();
      void store?.set({ [SCREENSHOT_KEY]: on })?.catch(() => {
        // A lost write costs a re-toggle, not correctness.
      });
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        message: on
          ? `redacted screenshot will be sent to the server (max ${String(SCREENSHOT_MAX_EDGE)} px)`
          : 'screenshot will not be sent - the server gets text only',
      });
      return Promise.resolve({ ok: true, enabled: on });
    }
    if (msg.cmd === 'site/origin') {
      // Read-only: the panel needs the origin to ASK for it, and the request
      // itself must happen there, inside the user gesture.
      return attachedReady.then(() => ({ ok: true, origin: attachedTab?.origin ?? null }));
    }
    /*
     * BACKWARD COMPATIBLE. The panel's origin-grant flow still sends this after
     * `permissions.request` succeeds, and it must keep working: the grant has to
     * happen inside a user gesture in an extension page, so the panel is the only
     * place that can make it, and this is how the background learns of it.
     *
     * The origin is filed against the kind the URL implies rather than into a
     * single global slot. Loopback is `local`; https goes to the CURRENTLY
     * SELECTED kind when that is off-device, and to `private` otherwise -
     * conservative, because `private` carries the stricter TLS rule and does not
     * assume somebody's server is a public cloud.
     */
    if (msg.cmd === 'server/origin') {
      const origin = (msg as { origin?: unknown }).origin;
      if (typeof origin !== 'string' || origin === '') {
        deployment = { ...deployment, backend: 'on-device' };
        persistDeployment();
        broadcastPanel(deploymentEvent());
        return Promise.resolve({ ok: true, origin: null });
      }
      /*
       * LOOPBACK ONLY, and it no longer GUESSES a kind.
       *
       * The first version derived the kind from the URL and the current
       * selection - `loopback ? 'local' : isOffDevice(selected) ? selected :
       * 'private'` - and then wrote both the endpoint and the selection. From a
       * bare text box with no kind selector, that is a control that silently
       * decides a data-sharing question:
       *
       *   with `private` selected and an org server configured, pasting a public
       *   vendor URL REPLACED the org endpoint, kept `private` selected, and
       *   from then on every step sent the sanitized context to a third party
       *   while the panel, the descriptor and the copied privacy receipt all
       *   said "Private Organization Server". The audit trail - the thing that
       *   makes the no-fallback guarantee auditable at all - named the wrong
       *   class of destination, and the org's own URL was gone from storage.
       *
       * It could also promote `on-device` to transmitting, from a button
       * labelled Grant.
       *
       * So https now goes through `deployment/configure`, where the caller NAMES
       * the kind. This path survives for loopback, which is unambiguous - a
       * localhost origin is the `local` backend and cannot be anything else -
       * and because that is the development flow this project already had.
       */
      const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(origin);
      if (!loopback) {
        return Promise.resolve({
          ok: false,
          error:
            'choose Private Organization Server or Cloud AI in the AI backend section and set the ' +
            'URL there - a remote endpoint must be filed under a named backend, not guessed from ' +
            'the current selection',
        });
      }
      const derived = deriveBackendOrigin('local', origin);
      if (!derived.ok) return Promise.resolve({ ok: false, error: derived.error });

      deployment = {
        ...deployment,
        backend: 'local',
        local: { ...configFor(deployment, 'local'), endpoint: derived.value.origin },
      };
      persistDeployment();
      broadcastPanel(deploymentEvent());
      return Promise.resolve({ ok: true, origin: derived.value.origin });
    }

    /** The whole settings object, plus which kinds hold a token. Never the token. */
    if (msg.cmd === 'deployment/get') {
      return attachedReady.then(() => {
        // The panel is listening by the time it asks for this, which is the
        // earliest point a rehydration demotion can actually be reported.
        announceDemotion();
        return {
        ok: true,
        config: deployment,
        /*
         * A BOOLEAN PER KIND, and that is the entire answer this API will ever
         * give about a credential. The panel needs to render "token set / not
         * set" and to enable a Clear button; it does not need, and must not be
         * able to obtain, the value. There is deliberately no read path.
         */
        tokens: {
          local: hasToken('local'),
          private: hasToken('private'),
          cloud: hasToken('cloud'),
        },
          descriptor: backendDescriptorFor(deployment, hasToken(deployment.backend)),
        };
      });
    }

    /**
     * Selects a backend. THE ONLY WAY THE SELECTION CHANGES.
     *
     * Nothing in the failure path calls this. A private server that is down does
     * not switch anything; it emits `backend/unavailable`, the panel renders the
     * alternatives as buttons, and a human clicking one arrives here. That is the
     * whole "no silent cloud fallback" guarantee, and it is a guarantee precisely
     * because this is the only writer.
     */
    if (msg.cmd === 'deployment/select') {
      const busy = deploymentLocked();
      if (busy !== null) return Promise.resolve({ ok: false, error: busy });
      const kind = (msg as { backend?: unknown }).backend;
      if (!isBackendKind(kind)) {
        return Promise.resolve({ ok: false, error: `unknown backend ${String(kind)}` });
      }
      const endpoint = isOffDevice(kind) ? configFor(deployment, kind).endpoint : '';
      if (isOffDevice(kind) && endpoint === '') {
        return Promise.resolve({
          ok: false,
          error: `set a server URL for the ${kind} backend before selecting it`,
        });
      }
      /*
       * THE SAME PERMISSION RULE THE REHYDRATION PATH APPLIES.
       *
       * Rehydration demotes an off-device selection whose origin is no longer
       * granted, with the rationale that "reaching for a server we may no longer
       * call is worse than starting with none". This handler is documented as
       * the ONLY way the selection changes and did not apply that rule - so
       * revoking the origin in chrome://extensions without restarting left the
       * backend selectable, `deployment/select` returned ok, the panel announced
       * it, and the next run died inside the HTTP client with a raw
       * host-permission string. Precisely the failure the rehydration guard
       * exists to prevent, reachable through the "use this backend instead"
       * button on the unavailable banner.
       */
      return attachedReady.then(async () => {
        if (isOffDevice(kind) && !(await hasSiteAccess(endpoint))) {
          return {
            ok: false,
            error:
              `this browser does not have permission to reach ${endpoint} - re-enter the URL for ` +
              `the ${kind} backend and grant it, then select it again`,
          };
        }
        deployment = { ...deployment, backend: kind };
        persistDeployment();
        broadcastPanel(deploymentEvent());
        return { ok: true, config: deployment };
      });
    }

    /**
     * Sets the endpoint and model for one kind. Does NOT select it, and does not
     * grant the origin - `permissions.request` needs a gesture from an extension
     * page, so the panel does that and then sends `server/origin`.
     */
    if (msg.cmd === 'deployment/configure') {
      const busy = deploymentLocked();
      if (busy !== null) return Promise.resolve({ ok: false, error: busy });
      const raw = msg as { backend?: unknown; endpoint?: unknown; model?: unknown };
      if (!isBackendKind(raw.backend) || !isOffDevice(raw.backend)) {
        return Promise.resolve({ ok: false, error: 'configure needs local, private or cloud' });
      }
      const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
      // A MODEL ID, not free text. It is displayed and stored, and 120 chars is
      // already far past any real one.
      const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 120) : '';

      if (endpoint === '') {
        deployment = {
          ...deployment,
          [raw.backend]: { endpoint: '', model },
          /*
           * Clearing the endpoint of the SELECTED backend would leave a
           * selection that cannot build a client, and the next step would die at
           * the plan stage. Demoted here instead, where it can be said out loud
           * through `backend/selected`.
           */
          ...(deployment.backend === raw.backend ? { backend: 'on-device' as const } : {}),
        };
        persistDeployment();
        broadcastPanel(deploymentEvent());
        return Promise.resolve({ ok: true, config: deployment });
      }

      const derived = deriveBackendOrigin(raw.backend, endpoint);
      if (!derived.ok) return Promise.resolve({ ok: false, error: derived.error });

      deployment = {
        ...deployment,
        [raw.backend]: { endpoint: derived.value.origin, model },
      };
      persistDeployment();
      broadcastPanel(deploymentEvent());
      return Promise.resolve({
        ok: true,
        config: deployment,
        // The panel needs this to ask the browser for the origin, and only the
        // panel can ask - the request must happen inside a user gesture.
        pattern: derived.value.pattern,
      });
    }

    /**
     * Stores or clears an access token for one kind.
     *
     * WRITE-ONLY BY DESIGN. There is no read path in this file, in the panel, or
     * in the message protocol; what comes back is a boolean.
     *
     * The reply, the notice and the timeline mention only whether a token is now
     * set. `broadcastPanel` reaches an extension page that renders text, so
     * anything put through it is one bug away from being on screen.
     */
    if (msg.cmd === 'deployment/token') {
      const busy = deploymentLocked();
      if (busy !== null) return Promise.resolve({ ok: false, error: busy });
      const raw = msg as { backend?: unknown; token?: unknown };
      if (!isBackendKind(raw.backend) || !isOffDevice(raw.backend)) {
        return Promise.resolve({ ok: false, error: 'a token needs local, private or cloud' });
      }
      /*
       * STORED AGAINST THE ENDPOINT, so it can only ever be sent to the host it
       * was entered for. A row with no endpoint has nothing to bind the token to
       * and is refused rather than stored loose - a token in a slot with no host
       * is a credential waiting for a host to be typed into it.
       */
      const origin = originOf(raw.backend);
      if (origin === null) {
        return Promise.resolve({
          ok: false,
          error: `set the ${raw.backend} server URL before its access token, so the token is bound to that host`,
        });
      }
      const token = typeof raw.token === 'string' ? raw.token.trim() : '';
      const next = { ...backendTokens };
      if (token === '') delete next[origin];
      else next[origin] = token;
      backendTokens = next;
      persistTokens();
      broadcastPanel(deploymentEvent());
      broadcastPanel({
        type: 'notice',
        scope: 'panel',
        // The ORIGIN it is bound to, never the token. Naming the host is the
        // whole point: it is what makes the binding visible.
        message:
          token === ''
            ? `access token cleared for ${origin}`
            : `access token set for ${origin} - kept in session storage only, sent as an ` +
              'authorization header, never in the payload, and never reused for another host',
      });
      return Promise.resolve({ ok: true, hasToken: token !== '' });
    }

    /**
     * Probes a backend and reports what it found.
     *
     * MEASURED, not inferred from the config. "Configured" and "reachable" are
     * different facts, and a settings screen that shows the first while implying
     * the second is how a demo finds out its server is down on stage.
     */
    if (msg.cmd === 'deployment/health') {
      const asked = (msg as { backend?: unknown }).backend;
      const kind: BackendKind = isBackendKind(asked) ? asked : deployment.backend;
      return attachedReady.then(async () => {
        let backend: AgentBackend;
        try {
          backend = createAgentBackend(
            { ...deployment, backend: kind },
            {
              clientVersion: 'sih26171-dev',
              authTokenFor: (k) => tokenFor(k),
            },
          );
        } catch (err) {
          // An unconfigured backend is UNAVAILABLE, not an exception. The panel
          // renders the same row either way and says why.
          const health = {
            kind,
            reachable: false,
            // Not waking: this failed to BUILD, so nothing was ever contacted.
            // Reporting it as "connecting" would promise a wait that will not end.
            waking: false,
            plannerId: null,
            description: null,
            error: err instanceof Error ? err.message : String(err),
            checkedAtMs: Date.now(),
          } as const;
          broadcastPanel({ type: 'backend/health', health });
          return { ok: true, health };
        }
        const health = await backend.health(new AbortController().signal);
        broadcastPanel({ type: 'backend/health', health });
        return { ok: true, health };
      });
    }
    if (msg.cmd === 'tab/status') {
      return attachedReady.then(() => {
        const event = attachmentEvent();
        broadcastPanel(event);
        return { ok: true, event };
      });
    }
    if (msg.cmd === 'host/init') {
      const config = (msg as { config?: EngineConfig }).config ?? DEFAULT_ENGINE_CONFIG;
      return initModel(host, config).then(
        (result) => ({ ok: true, result }),
        (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    if (msg.cmd === 'host/status') {
      /*
       * THE PANEL OPENING IS THE TRIGGER.
       *
       * `host/status` is the first message the sidebar sends on mount, so it is
       * the earliest reliable signal that somebody is about to use this. Loading
       * here rather than at browser start means nothing is spent on a session
       * that never opens the panel.
       *
       * Only when vision is actually ON. Auto-loading a model the default
       * configuration will not call would be spending the user's memory to
       * populate a status line.
       */
      if (visionEnabled) ensureModelLoading(host);
      return hostStatusEvent(host).then((event) => {
        // Answer the caller AND push to the panel, so opening the sidebar shows
        // real state rather than waiting for a step that may never run.
        broadcastPanel(event);
        /*
         * The deployment goes out on the same round trip. The panel asks for
         * host status when it opens, and without this the Deployment section
         * would be blank until the first run - showing "on-device" for a
         * configured cloud backend, which is a wrong answer rather than a
         * missing one.
         */
        broadcastPanel(deploymentEvent());
        return { ok: true, event };
      });
    }

    /*
     * Sent by the panel after `permissions.request` for the ATTACHED PAGE
     * succeeds. It had no handler at all, so the panel's own message fell through
     * to `unknown cmd site/access-confirmed` - harmless only because the panel
     * ignores the reply. Recording the origin is what lets a multi-step run
     * survive its own navigation without a second prompt.
     */
    if (msg.cmd === 'site/access-confirmed') {
      const origin = (msg as { origin?: unknown }).origin;
      if (typeof origin !== 'string' || origin === '') {
        return Promise.resolve({ ok: false, error: 'site/access-confirmed needs an origin' });
      }
      return attachedReady.then(() => {
        if (attachedTab === null) return { ok: false, error: 'no tab attached' };
        attachedTab = { ...attachedTab, origin };
        persistAttachment();
        broadcastPanel({
          type: 'notice',
          scope: 'panel',
          message: `persistent page access recorded for ${origin}`,
        });
        return { ok: true };
      });
    }
    return Promise.resolve({ ok: false, error: `unknown cmd ${String(msg.cmd)}` });
  });

  /*
   * One step of the agent loop, for reference:
   *
   *   1. content    -> snapshot()             outerHTML + per-element rects
   *   2. background -> captureVisibleTab()    only callable from here
   *   3. host       -> detect(frame)          vision boxes, in the offscreen doc
   *   4. redaction  -> redact(html, boxes)    pure; produces the log + pixel ops
   *   5. host       -> bake(frameId, ops)     pixels, against the retained bitmap
   *   6. redaction  -> buildSanitizedContext  the only thing allowed to leave
   *   7. agent      -> plan()                 one action back
   *   8. agent      -> parseAction/validate   refuse anything off-vocabulary
   *   9. content    -> execute(action)
   *
   * Steps 4, 6 and 8 are pure and already covered by npm test. Steps 2, 3 and 5
   * are the browser-only parts still to be built.
   */
});
