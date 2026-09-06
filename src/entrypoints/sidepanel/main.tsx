import { render } from 'preact';
import { browser } from 'wxt/browser';
import { type PanelState, App, initialPanelState, reducePanel } from '@/panel/index.ts';
import type { BackendKind, DeploymentConfig, PanelEvent } from '@/contracts/index.ts';
import {
  type PermissionsApi,
  deriveBackendOrigin,
  deriveOriginPattern,
  requestServerOrigin,
} from '@/agent-server/index.ts';

/**
 * The panel. All behaviour lives in reducePanel, which is pure and tested; this
 * file only subscribes to events and re-renders.
 *
 * Chrome mounts it as a side_panel, Firefox as a sidebar_action. WXT emits the
 * right manifest key for each from this one entrypoint.
 *
 * TEMPORARY UI. Deliberately unstyled and information-dense: it exists to make
 * the runtime observable while the pipeline is built, and to be replaced wholly
 * by the Figma design. Nothing below this file depends on how it looks - the
 * panel consumes PanelEvent, a contract, and knows nothing about perception,
 * orchestration, execution or the server.
 */

const found = document.getElementById('root');
if (found === null) throw new Error('panel root element is missing');
const root: HTMLElement = found;

let state: PanelState = initialPanelState;

function apply(event: PanelEvent): void {
  state = reducePanel(state, event);
  draw();
}

/**
 * Grants one server origin.
 *
 * MUST stay synchronous down to `requestServerOrigin`. `deriveOriginPattern` is
 * pure, so the only thing between the click and `permissions.request` is
 * validation - no await, no storage read, no message round trip. The first await
 * would forfeit user-gesture status and the prompt would never appear, with no
 * error to notice.
 */
function grantOrigin(raw: string): void {
  const derived = deriveOriginPattern(raw);
  if (!derived.ok) {
    apply({ type: 'origin/status', origin: null, granted: false, error: derived.error });
    return;
  }

  const permissions = (browser as unknown as { permissions?: PermissionsApi }).permissions;
  if (permissions === undefined) {
    apply({
      type: 'origin/status',
      origin: derived.value.origin,
      granted: false,
      error: 'browser.permissions is unavailable in this context',
    });
    return;
  }

  // Called now, inside the gesture. Only the RESULT is handled asynchronously.
  requestServerOrigin(permissions, derived.value)
    .then((granted) => {
      apply({ type: 'origin/status', origin: derived.value.origin, granted, error: null });
      /*
       * The BACKGROUND is what runs the step, and it has no way to learn about
       * this grant on its own - `permissions.request` has to happen here,
       * because only an extension page can carry the user gesture. So the
       * origin is handed over explicitly; until it is, the loop plans locally.
       */
      if (granted) {
        void (
          browser.runtime.sendMessage({
            target: 'background',
            cmd: 'server/origin',
            origin: derived.value.origin,
          }) as Promise<unknown>
        ).catch(() => {
          // The background may be asleep. It re-reads the stored origin on wake.
        });
      }
    })
    .catch((err: unknown) => {
      apply({
        type: 'origin/status',
        origin: derived.value.origin,
        granted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * What the background actually has stored.
 *
 * The input used to fall back to a hardcoded default, so a reopened panel showed
 * 3400 while steps ran at 7000 - and the only way to reach the real value was to
 * step the field back up to it, which is what happened.
 */
let budgetTokens: number | null = null;
let planOnly = false;
/** What the background has stored for the local vision model. */
let visionEnabled = false;
/** The question the agent is waiting on, or null. Polled after every run. */
let pendingQuestion: string | null = null;

/**
 * The conversation, held in the panel.
 *
 * Deliberately not in `PanelState`: the reducer is a pure function of
 * `PanelEvent`, and these lines are a mix of what the USER typed and what this
 * panel generated. Putting them through the event stream would make the reducer
 * responsible for transcript formatting, which is a view concern.
 */
let messages: { role: 'you' | 'agent'; text: string }[] = [];

/**
 * The stored deployment, mirrored so the inputs show what is actually in force.
 *
 * Same reasoning as `budgetTokens`: a field that falls back to a placeholder
 * while a different value is in effect is worse than no field, because the only
 * way to reach the real value is to retype it. The background owns this; the
 * panel holds a copy for rendering.
 */
let backendConfig: DeploymentConfig | null = null;
/** Which kinds hold a token. BOOLEANS. There is no read path for the value. */
let tokenSet: Partial<Record<BackendKind, boolean>> = {};

function send(cmd: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return browser.runtime.sendMessage({ target: 'background', cmd, ...extra }) as Promise<unknown>;
}

/** Pulls the deployment settings back from the background and redraws. */
function refreshDeployment(): void {
  void send('deployment/get')
    .then((reply) => {
      const r = reply as
        | { ok?: boolean; config?: DeploymentConfig; tokens?: Partial<Record<BackendKind, boolean>> }
        | undefined;
      if (r?.ok !== true || r.config === undefined) return;
      backendConfig = r.config;
      tokenSet = r.tokens ?? {};
      draw();
    })
    .catch(() => {
      // The background may be asleep; `refreshStatus` already reports that.
    });
}

function selectBackend(kind: BackendKind): void {
  void send('deployment/select', { backend: kind })
    .then((reply) => {
      const r = reply as { ok?: boolean; error?: string } | undefined;
      if (r?.ok === false) {
        apply({ type: 'error', scope: 'panel', message: r.error ?? 'could not switch backend' });
        return;
      }
      refreshDeployment();
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        message: `could not switch backend: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

/**
 * Saves an endpoint AND asks the browser for permission to reach it.
 *
 * THE PERMISSION REQUEST IS FIRST AND SYNCHRONOUS. Both engines read
 * user-gesture status at call time - Chromium scopes it to the synchronous
 * execution of the handler, Gecko does the same through `withHandlingUserInput`
 * - so a single `await` beforehand loses it and the prompt never appears, with
 * no error to notice. So the pattern is derived by a PURE function here and
 * `permissions.request` is reached with nothing awaited in between; the
 * background is told afterwards, from the promise callback, where async is free.
 */
function configureBackend(kind: BackendKind, endpoint: string, model: string): void {
  const trimmed = endpoint.trim();
  if (trimmed === '') {
    // Clearing is not a permission change, so it needs no gesture.
    void send('deployment/configure', { backend: kind, endpoint: '', model }).then(
      () => {
        refreshDeployment();
      },
      () => undefined,
    );
    return;
  }

  const derived = deriveBackendOrigin(kind, trimmed);
  if (!derived.ok) {
    apply({ type: 'origin/status', origin: null, granted: false, error: derived.error });
    return;
  }

  const permissions = (browser as unknown as { permissions?: PermissionsApi }).permissions;
  if (permissions === undefined) {
    apply({
      type: 'origin/status',
      origin: derived.value.origin,
      granted: false,
      error: 'browser.permissions is unavailable in this context',
    });
    return;
  }

  // Inside the gesture. Only the RESULT is handled asynchronously.
  requestServerOrigin(permissions, derived.value)
    .then(async (granted) => {
      const verified = await permissions.contains({ origins: [derived.value.pattern] });
      apply({
        type: 'origin/status',
        origin: derived.value.origin,
        granted: verified,
        error: verified ? null : 'the browser did not grant access to this origin',
      });
      if (!verified) return;
      void granted;
      const reply = (await send('deployment/configure', {
        backend: kind,
        endpoint: derived.value.origin,
        model,
      })) as { ok?: boolean; error?: string } | undefined;
      if (reply?.ok === false) {
        apply({ type: 'error', scope: 'panel', message: reply.error ?? 'could not save the endpoint' });
        return;
      }
      refreshDeployment();
      checkBackend(kind);
    })
    .catch((err: unknown) => {
      apply({
        type: 'origin/status',
        origin: derived.value.origin,
        granted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Hands a token to the background and forgets it here.
 *
 * The panel keeps no copy: `tokenSet` is refreshed from the background and holds
 * booleans. This function is the only place in the panel a token value exists,
 * and it exists for the duration of one call.
 */
function setBackendToken(kind: BackendKind, token: string): void {
  void send('deployment/token', { backend: kind, token })
    .then(() => {
      refreshDeployment();
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        // The error message must not echo the token, so it names the KIND only.
        message: `could not store the ${kind} access token: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    });
}

function checkBackend(kind: BackendKind): void {
  void send('deployment/health', { backend: kind }).catch((err: unknown) => {
    apply({
      type: 'error',
      scope: 'panel',
      message: `health check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/**
 * Copies a receipt to the clipboard.
 *
 * The text is produced by `formatReceipt` from the same `PrivacyReceipt` the
 * panel renders, so a pasted receipt cannot say something the screen did not.
 */
function copyReceipt(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => {
      apply({ type: 'notice', scope: 'panel', message: 'privacy receipt copied' });
    },
    () => {
      apply({ type: 'error', scope: 'panel', message: 'the clipboard is unavailable here' });
    },
  );
}

function say(role: 'you' | 'agent', text: string): void {
  messages = [...messages, { role, text }];
  draw();
}

function draw(): void {
  render(
    <App
      state={state}
      onGrantOrigin={grantOrigin}
      onLoadModel={loadModel}
      onRunStep={runStep}
      onRunTask={runTask}
      onStop={stopTask}
      onClearPrivacyLens={clearPrivacyLens}
      onGrantSite={grantSite}
      onToggleScreenshot={toggleScreenshot}
      onToggleVision={toggleVision}
      onSetBudget={setBudget}
      budgetTokens={budgetTokens}
      planOnly={planOnly}
      visionEnabled={visionEnabled}
      onTogglePlanOnly={togglePlanOnly}
      pendingQuestion={pendingQuestion}
      messages={messages}
      onAnswer={sendAnswer}
      build={buildInfo()}
      onSelectBackend={selectBackend}
      onConfigureBackend={configureBackend}
      onSetBackendToken={setBackendToken}
      onCheckBackend={checkBackend}
      tokenSet={tokenSet}
      {...(backendConfig === null
        ? {}
        : {
            /*
             * SPREAD, not `prop={undefined}`. `exactOptionalPropertyTypes` makes
             * "absent" and "present and undefined" different types, so passing
             * undefined explicitly to an optional prop is a compile error - which
             * is the setting doing its job: the two mean different things and the
             * panel renders them differently.
             */
            backendConfig: {
              local: backendConfig.local,
              private: backendConfig.private,
              cloud: backendConfig.cloud,
            },
          })}
      onCopyReceipt={copyReceipt}
    />,
    root,
  );
}

draw();

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { target?: string; event?: PanelEvent } | null;
  if (msg === null || msg.target !== 'panel' || msg.event === undefined) return undefined;
  apply(msg.event);
  return undefined;
});

/**
 * Ask what the runtime can do, as soon as the panel opens.
 *
 * Without this the panel shows its initial state until a step runs - and a step
 * cannot run yet, so it would show nothing forever and look broken rather than
 * unbuilt. This is also the message that wakes the Firefox event page, which is
 * suspended whenever idle.
 */
/**
 * Asks the background to load the model.
 *
 * Fire-and-forget on purpose: the background broadcasts `host/status` when the
 * load starts and again when it settles, so the panel learns the outcome
 * through the same path as every other state change rather than through this
 * reply. That keeps one source of truth for what the model is doing.
 *
 * No user-gesture constraint here, unlike the origin grant - this is an
 * ordinary message, so an await beforehand would be harmless. It is written
 * this way for symmetry, not necessity.
 */
function loadModel(): void {
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'host/init' }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { ok?: boolean; error?: string } | undefined;
      if (r?.ok === false) {
        apply({ type: 'error', scope: 'perception', message: r.error ?? 'model load failed' });
      }
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'perception',
        message: `model load failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

/**
 * Runs one agent step.
 *
 * The tab is NOT chosen here. The background pinned it when the toolbar button
 * was clicked, because that click is what granted activeTab and the grant is
 * per-tab. A panel that resolved "the active tab" itself would drive whatever
 * the user happened to be looking at, which is both wrong and unpermitted.
 */
function runStep(goal: string): void {
  void (
    browser.runtime.sendMessage({
      target: 'background',
      cmd: 'agent/step',
      goal,
    }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { ok?: boolean; error?: string } | undefined;
      if (r?.ok === false) {
        apply({ type: 'error', scope: 'panel', message: r.error ?? 'step failed' });
      }
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        message: `step failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

/**
 * What build is running.
 *
 * The VERSION comes from the built manifest rather than from package.json, so it
 * describes what the browser actually installed - the two can differ whenever
 * the extension has not been reloaded, which is exactly the case this is here to
 * make visible. The STAMP is injected by vite at build time.
 */
declare const __BUILD_STAMP__: string;

function buildInfo(): { version: string; built: string } {
  let version = 'unknown';
  try {
    version = browser.runtime.getManifest().version;
  } catch {
    // Rendered outside an extension (a test, a plain page). Not a failure.
  }
  return {
    version,
    built: typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev',
  };
}

/** Runs the whole task. The background owns the bound; this only asks. */
function runTask(goal: string): void {
  if (!messages.some((m) => m.role === 'you' && m.text === goal)) say('you', goal);
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'agent/run', goal }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as
        | { ok?: boolean; error?: string; reason?: string; actionsTaken?: number }
        | undefined;
      // A loop that ended for any reason other than `done` did NOT complete the
      // task, and says so rather than reporting a clean finish.
      if (r?.ok === false) {
        apply({ type: 'error', scope: 'panel', message: r.error ?? 'task did not complete' });
      }
      /*
       * A run can end BECAUSE the agent needs an answer, so the question is
       * fetched after EVERY run rather than only on failure - `ask_user` is an
       * outcome, not an error. The reply lands in the transcript either way.
       */
      refreshQuestion((q) => {
        if (q !== null) say('agent', q);
        else if (r?.ok === true) {
          /*
           * "Done" and "done without doing anything" are different outcomes, and
           * a real Amazon run produced the second while the panel printed the
           * first. Saying which one happened costs a clause and stops the
           * transcript claiming work that never occurred.
           */
          say(
            'agent',
            r.actionsTaken === 0
              ? 'I did not need to do anything - the goal already looked met. If that is wrong, tell me what to do instead.'
              : 'Done.',
          );
        }
        else {
          /*
           * A stop that is not `done` did NOT accomplish the task, and the
           * reason is the whole difference between "finished" and "gave up
           * after eight steps". Reported here rather than swallowed into a
           * generic failure line.
           */
          const why = r?.reason === undefined ? '' : ` (${r.reason})`;
          say('agent', r?.error ?? `I could not finish that${why}.`);
        }
      });
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        message: `task failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

function stopTask(): void {
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'agent/stop' }) as Promise<unknown>
  ).catch(() => {
    // The background may already have finished. Not worth reporting.
  });
}

/** Removes only the local visual overlay; it cannot alter the baked screenshot. */
function clearPrivacyLens(): void {
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'privacy/lens/clear' }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { ok?: boolean; error?: string } | undefined;
      if (r?.ok === false) {
        apply({ type: 'error', scope: 'privacy lens', message: r.error ?? 'could not clear page mask' });
      }
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'privacy lens',
        message: `could not clear page mask: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

/**
 * Grants a persistent host permission for the page currently attached.
 *
 * WHY THE ORIGIN IS CACHED. `permissions.request` must be reached synchronously
 * from the click, and asking the background for the origin is asynchronous - the
 * await would forfeit the gesture and the prompt would silently never appear.
 * So the origin is fetched when the attachment changes and read from a variable
 * here.
 */
let attachedOrigin: string | null = null;

function refreshSiteOrigin(): void {
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'site/origin' }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { origin?: string | null } | undefined;
      attachedOrigin = r?.origin ?? null;
    })
    .catch(() => {
      attachedOrigin = null;
    });
}

function grantSite(): void {
  if (attachedOrigin === null) {
    apply({
      type: 'error',
      scope: 'panel',
      message: 'no page origin known yet - click the toolbar button on the page first',
    });
    return;
  }
  const derived = deriveOriginPattern(attachedOrigin);
  if (!derived.ok) {
    apply({ type: 'error', scope: 'panel', message: derived.error });
    return;
  }
  const permissions = (browser as unknown as { permissions?: PermissionsApi }).permissions;
  if (permissions === undefined) {
    apply({
      type: 'error',
      scope: 'panel',
      message: 'Chrome permissions API is unavailable in this side panel',
    });
    return;
  }

  // Synchronous to here. Only the RESULT is handled asynchronously.
  requestServerOrigin(permissions, derived.value)
    .then(async (granted) => {
      const verified = await permissions.contains({ origins: [derived.value.pattern] });
      apply({
        type: verified ? 'notice' : 'error',
        scope: 'panel',
        message: verified
          ? granted
            ? `access granted for ${derived.value.origin}; it will survive navigation`
            : `access already granted for ${derived.value.origin}; no popup was needed`
          : `access to ${derived.value.origin} was declined or blocked by the browser`,
      });
      if (verified) {
        void (
          browser.runtime.sendMessage({
            target: 'background',
            cmd: 'site/access-confirmed',
            origin: derived.value.origin,
          }) as Promise<unknown>
        ).catch(() => undefined);
      }
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        message: `site grant failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

/** Turns the redacted screenshot on or off for server requests. */
function toggleScreenshot(enabled: boolean): void {
  void (
    browser.runtime.sendMessage({
      target: 'background',
      cmd: 'vision/screenshot',
      enabled,
    }) as Promise<unknown>
  ).catch((err: unknown) => {
    apply({
      type: 'error',
      scope: 'panel',
      message: `could not change the screenshot setting: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/** Turns the local vision model on or off for future steps. */
function toggleVision(enabled: boolean): void {
  // Optimistic, then confirmed by the reply. The checkbox is controlled now, so
  // without this it would snap back until the round trip returned.
  visionEnabled = enabled;
  draw();
  void (
    browser.runtime.sendMessage({
      target: 'background',
      cmd: 'vision/enabled',
      enabled,
    }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { ok?: boolean; enabled?: unknown } | undefined;
      if (typeof r?.enabled === 'boolean') {
        visionEnabled = r.enabled;
        draw();
      }
    })
    .catch((err: unknown) => {
    apply({
      type: 'error',
      scope: 'panel',
      message: `could not change the vision setting: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/**
 * Sets how many tokens the prompt may occupy.
 *
 * This is a property of the SERVER, not of the extension, and there is no way to
 * discover it - the OpenAI-compatible request body has no field that reports the
 * context window. The default is sized for Ollama's out-of-the-box 4096, which
 * is safe against any endpoint and shows up in the panel as `geometry omitted`
 * on a large page. Point it at a server with more room and the geometry comes
 * back.
 */
function setBudget(tokens: number): void {
  void (
    browser.runtime.sendMessage({
      target: 'background',
      cmd: 'budget/tokens',
      tokens,
    }) as Promise<unknown>
  ).catch((err: unknown) => {
    apply({
      type: 'error',
      scope: 'panel',
      message: `could not change the context budget: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/** Withholds the final click while leaving the rest of the pipeline running. */
function togglePlanOnly(enabled: boolean): void {
  planOnly = enabled;
  draw();
  void (
    browser.runtime.sendMessage({
      target: 'background',
      cmd: 'plan-only',
      enabled,
    }) as Promise<unknown>
  ).catch((err: unknown) => {
    apply({
      type: 'error',
      scope: 'panel',
      message: `could not change plan-only: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/** Asks the background whether a question is outstanding, and redraws if so. */
function refreshQuestion(then?: (q: string | null) => void): void {
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'task/question' }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { ok?: boolean; question?: unknown } | undefined;
      const q = r?.ok === true && typeof r.question === 'string' ? r.question : null;
      pendingQuestion = q;
      draw();
      then?.(q);
    })
    .catch(() => {
      // Nothing outstanding is the normal case; not worth an error line.
      then?.(null);
    });
}

/**
 * Sends the answer, then RE-RUNS the same goal.
 *
 * Resuming rather than restarting is the point: the clarification is held
 * against the current goal in the background, so the next run plans with it
 * instead of asking again.
 */
function sendAnswer(answer: string): void {
  void (
    browser.runtime.sendMessage({
      target: 'background',
      cmd: 'task/answer',
      answer,
    }) as Promise<unknown>
  )
    .then(() => {
      say('you', answer);
      pendingQuestion = null;
      draw();
      /*
       * Resumes the ORIGINAL goal, not the answer. The answer is held against
       * that goal in the background; re-running it is what lets the next plan
       * see the clarification instead of asking again.
       */
      const original = [...messages].reverse().find((m) => m.role === 'you' && m.text !== answer);
      if (original !== undefined) runTask(original.text);
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        message: `could not send the answer: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

function refreshStatus(): void {
  void (
    browser.runtime.sendMessage({ target: 'background', cmd: 'host/status' }) as Promise<unknown>
  )
    .then((reply) => {
      const r = reply as { ok?: boolean; event?: PanelEvent } | undefined;
      if (r?.ok === true && r.event !== undefined) apply(r.event);
    refreshSiteOrigin();
    })
    .catch((err: unknown) => {
      apply({
        type: 'error',
        scope: 'panel',
        message: `could not reach the background: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

void (browser.runtime.sendMessage({ target: 'background', cmd: 'budget/get' }) as Promise<unknown>)
  .then((reply) => {
    const r = reply as { ok?: boolean; tokens?: unknown } | undefined;
    if (r?.ok === true && typeof r.tokens === 'number') {
      budgetTokens = r.tokens;
      draw();
    }
  })
  .catch(() => {
    // Falls back to whatever the last step reported. Not worth an error line.
  });

/*
 * Asked on mount. `host/status` is what actually triggers the model load in the
 * background; this is only so the toggle and the runtime card render the stored
 * setting rather than a default that disagrees with it.
 */
void (browser.runtime.sendMessage({ target: 'background', cmd: 'vision/get' }) as Promise<unknown>)
  .then((reply) => {
    const r = reply as { ok?: boolean; enabled?: unknown } | undefined;
    if (r?.ok === true && typeof r.enabled === 'boolean') {
      visionEnabled = r.enabled;
      draw();
    }
  })
  .catch(() => {
    // Defaults to off, which is the measured default and the safe direction.
  });

void (browser.runtime.sendMessage({ target: 'background', cmd: 'plan-only/get' }) as Promise<unknown>)
  .then((reply) => {
    const r = reply as { ok?: boolean; enabled?: unknown } | undefined;
    if (r?.ok === true && typeof r.enabled === 'boolean') {
      planOnly = r.enabled;
      draw();
    }
  })
  .catch(() => {
    // Defaults to off, which is the safe direction.
  });

refreshStatus();
// The deployment is a SETTING the panel cannot derive. Without this the backend
// section would be blank until the first run and would show "on-device" for a
// configured cloud endpoint - a wrong answer rather than a missing one.
refreshDeployment();
// Which tab we may drive is state the panel cannot derive for itself.
void (browser.runtime.sendMessage({ target: 'background', cmd: 'tab/status' }) as Promise<unknown>)
  .then((reply) => {
    const r = reply as { ok?: boolean; event?: PanelEvent } | undefined;
    if (r?.ok === true && r.event !== undefined) apply(r.event);
  })
  .catch(() => {
    // The background may be asleep; refreshStatus already reports that.
  });
