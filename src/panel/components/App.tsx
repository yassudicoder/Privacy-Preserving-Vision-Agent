import {
  type BackendKind,
  BACKEND_KINDS,
  backendLabel,
  isOffDevice,
} from '@/contracts/index.ts';
import type { PanelState } from '../state.ts';
import {
  formatReceipt,
  groupRedactionsByKind,
  latencyBars,
  privacyWarnings,
  receiptNetworkLines,
} from '../selectors.ts';

/**
 * The view. Deliberately dumb: every value it renders is computed by a pure
 * selector that has its own test. Nothing here decides anything.
 *
 * Note that redaction entries are rendered from the LOG, never from the page.
 * The log carries kinds, strategies and hashes - never the values - so there is
 * no path by which the panel can display the PII it is reporting on.
 *
 * STYLING LIVES IN `entrypoints/sidepanel/style.css`, not here. This file emits
 * class names and no inline styling beyond the one bar width that is genuinely
 * data-driven, so the Figma implementation can replace the stylesheet without
 * touching a single data binding.
 */

export interface BuildInfo {
  /** From the built manifest, so it describes what is actually INSTALLED. */
  readonly version: string;
  /** Stamped at build time. Tells a fresh load apart from a stale one. */
  readonly built: string;
}

export interface AppProps {
  readonly state: PanelState;
  /**
   * Called synchronously from the click. The panel may only import contracts,
   * so the actual permissions.request lives in the entrypoint - and passing a
   * callback rather than importing it is also what keeps the call inside the
   * user-gesture window.
   */
  readonly onGrantOrigin?: (raw: string) => void;
  /** Asks the background to load the model. Optional: the harness renders headless. */
  readonly onLoadModel?: () => void;
  /** Runs one agent step against the attached tab. */
  readonly onRunStep?: (goal: string) => void;
  /** Runs the whole task, bounded by the loop's stop conditions. */
  readonly onRunTask?: (goal: string) => void;
  /** Asks a running loop to stop before its next step. */
  readonly onStop?: () => void;
  /** Removes the visual-only mask from the page; it never changes baked evidence. */
  readonly onClearPrivacyLens?: () => void;
  /**
   * Asks for a persistent host permission on the attached page's origin.
   *
   * Synchronous down to `permissions.request`, like `onGrantOrigin` - the first
   * await forfeits the gesture and the prompt never appears.
   */
  readonly onGrantSite?: () => void;
  /**
   * Turns the redacted screenshot on or off for server requests.
   *
   * A runtime toggle rather than a build constant because it is a HARDWARE
   * decision as much as a feature one: an image costs 1-2k vision tokens per
   * step and needs a vision model, and on a 6 GB laptop GPU that is the
   * difference between fitting and thrashing. Whoever is running the demo
   * should be able to flip it without a rebuild.
   */
  readonly onToggleScreenshot?: (enabled: boolean) => void;
  readonly onToggleVision?: (enabled: boolean) => void;
  /**
   * Whether the local vision model is wanted for this session.
   *
   * The panel needs it to decide whether a model that has not loaded is worth
   * mentioning AT ALL. With vision off nothing calls the weights, so "not
   * loaded" is not a state the user has to act on - reporting it as a blocker
   * was the panel describing a problem that did not exist.
   */
  readonly visionEnabled?: boolean;
  readonly onSetBudget?: (tokens: number) => void;
  readonly onTogglePlanOnly?: (enabled: boolean) => void;
  readonly pendingQuestion?: string | null;
  /** The conversation so far. From the user, or generated on this machine. */
  readonly messages?: readonly { readonly role: 'you' | 'agent'; readonly text: string }[];
  readonly onAnswer?: (answer: string) => void;
  readonly planOnly?: boolean;
  /** What the background has stored. Null until it answers. */
  readonly budgetTokens?: number | null;
  /** Omitted when rendered outside an extension, e.g. in a test. */
  readonly build?: BuildInfo;

  // --- deployment ----------------------------------------------------------
  /**
   * Selects a backend. THE ONLY WAY THE SELECTION CHANGES.
   *
   * Notably it is also what the "private server unavailable" buttons call. There
   * is no separate failure-recovery path that could switch on its own: a switch
   * is always a human clicking this.
   */
  readonly onSelectBackend?: (kind: BackendKind) => void;
  /** Sets the endpoint and model for one kind, then asks for the origin grant. */
  readonly onConfigureBackend?: (kind: BackendKind, endpoint: string, model: string) => void;
  /**
   * Stores or clears an access token. WRITE-ONLY.
   *
   * There is no matching read prop and there is not going to be one. The panel
   * learns from `tokenSet` whether a token exists; the value lives in the
   * background's session storage and is read at request time by the HTTP client.
   */
  readonly onSetBackendToken?: (kind: BackendKind, token: string) => void;
  /** Probes a backend and reports what it found. Measured, not declared. */
  readonly onCheckBackend?: (kind: BackendKind) => void;
  /** Which kinds hold a token. Booleans - never the tokens. */
  readonly tokenSet?: Readonly<Partial<Record<BackendKind, boolean>>>;
  /** The stored endpoint/model per kind, so the inputs show what is in force. */
  readonly backendConfig?: Readonly<
    Partial<Record<BackendKind, { readonly endpoint: string; readonly model: string }>>
  >;
  /** Copies the current step's receipt to the clipboard as text. */
  readonly onCopyReceipt?: (text: string) => void;
}

/** A dot plus a word. Colour alone would exclude anyone who cannot see it. */
function Status({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'idle'; children: unknown }) {
  return (
    <>
      <span class={`dot is-${tone}`} aria-hidden="true" />
      {children as never}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a backend kind is FOR, in one line. Shown under each radio. */
function backendBlurb(kind: BackendKind): string {
  switch (kind) {
    case 'on-device':
      return 'Heuristic baseline in this browser. Nothing leaves the machine at all.';
    case 'local':
      return 'An agent server on this machine - typically Ollama behind npm run server.';
    case 'private':
      return "Your organization's own GPU server, over https.";
    case 'cloud':
      return 'A hosted agent server, over https.';
  }
}

export function App({
  state,
  onGrantOrigin,
  onLoadModel,
  onRunStep,
  onRunTask,
  onStop,
  onClearPrivacyLens,
  onGrantSite,
  onToggleScreenshot,
  onToggleVision,
  visionEnabled,
  onSetBudget,
  budgetTokens,
  onTogglePlanOnly,
  planOnly,
  pendingQuestion,
  onAnswer,
  messages,
  build,
  onSelectBackend,
  onConfigureBackend,
  onSetBackendToken,
  onCheckBackend,
  tokenSet,
  backendConfig,
  onCopyReceipt,
}: AppProps) {
  const warnings = privacyWarnings(state);
  const kinds = groupRedactionsByKind(state);
  const bars = latencyBars(state);
  const proof = state.privacyGate;

  /*
   * Whether any measurement exists at all. Steps completed is the honest signal:
   * every latency and resource figure below is written by a step, so before the
   * first one they are all defaults rather than readings.
   */
  const hasRun = state.metrics.counts.steps > 0;

  const modelLoaded = state.host?.modelLoaded === true;
  const attached = state.attachedTab?.tabId != null;
  /*
   * THE MODEL IS NOT A PREREQUISITE FOR RUNNING.
   *
   * This used to be `attached && modelLoaded`, so the Send button stayed
   * disabled until somebody pressed "Load model" - in a default configuration
   * that never calls the model. The two worker calls a text-only step makes,
   * `retain` and `bake`, do not read the weights; they used to demand them
   * through a circular check that `runtime.ts` no longer makes.
   *
   * A page to drive is the only real prerequisite, and it is the one thing the
   * user must actually do something about.
   */
  const canRun = attached;
  /**
   * Vision was asked for and the weights are not there YET.
   *
   * Distinct from "not loaded", which with vision off is simply not a fact worth
   * reporting. The load starts on its own when the panel opens, so this is a
   * progress state, not an instruction.
   */
  const visionPending = visionEnabled === true && !modelLoaded;

  /*
   * THE DEPLOYMENT IS FROZEN FOR THE DURATION OF A RUN.
   *
   * `runTask` builds one backend and one StepInput and hands them to the loop,
   * which reuses both for up to eight steps - so a switch made mid-run takes
   * effect on nothing, while this panel and the copied receipt would immediately
   * report the new backend. That is the audit trail lying in the most damaging
   * direction: "On-device (no network)" displayed over a run still POSTing to a
   * cloud.
   *
   * Disabled rather than made live, because a run whose destination changes
   * halfway is an ambiguous thing to record. Stop is the answer, and Stop takes
   * effect before the next step touches the page.
   */
  const runLocked = state.loop?.running === true;

  return (
    <main class="panel">
      <header class="masthead">
        <div>
          <p class="product-kicker">SIH26171 · on-device privacy</p>
          <h1>Privacy Vision Agent</h1>
        </div>
        {/* The one-glance answer to "can I press the button". */}
        <span class={`pill ${canRun ? 'is-ok' : 'is-warn'}`}>{canRun ? 'Ready' : 'Set up'}</span>
      </header>

      {state.session === null ? (
        <p class="session">No active session.</p>
      ) : (
        <p class="session">
          <span class="goal-text">{state.session.goal}</span> &middot; step {state.session.step}
          {state.session.running ? ' · running' : ''}
        </p>
      )}

      {/*
       * The demo's most important panel. It only renders facts emitted by the
       * pipeline: a raw capture has no route to this view; the sole image here
       * is a BakedScreenshot that passed the pixel-coverage checks.
       */}
      <section class="privacy-proof" aria-label="Privacy gate proof">
        <div class="proof-heading">
          <div>
            <span class="section-kicker">Privacy Gate</span>
            <h2>Live protection proof</h2>
          </div>
          <span
            class={`pill ${
              proof.transmitted?.channel === 'cloud'
                ? 'is-ok'
                : proof.prepared !== null
                  ? 'is-warn'
                  : ''
            }`}
          >
            {proof.transmitted?.channel === 'cloud'
              ? 'Sanitized only'
              : proof.prepared !== null
                ? 'Checking'
                : 'Idle'}
          </span>
        </div>
        <p class="proof-intro">Raw screen stays on this device. Only the verified output can leave.</p>

        <ol class="proof-flow">
          <li class={proof.capture === null ? '' : 'is-complete'}>
            <span class="proof-index">1</span>
            <div>
              <strong>Capture</strong>
              <small>
                {proof.capture === null
                  ? 'Waiting for a screen'
                  : `${formatBytes(proof.capture.bytes)} captured locally`}
              </small>
            </div>
          </li>
          <li class={proof.redaction === null ? '' : proof.redaction.applied === proof.redaction.detected ? 'is-complete' : 'is-warn'}>
            <span class="proof-index">2</span>
            <div>
              <strong>Detect & redact</strong>
              <small>
                {proof.redaction === null
                  ? 'Local PII scan pending'
                  : `${String(proof.redaction.applied)}/${String(proof.redaction.detected)} regions protected`}
              </small>
            </div>
          </li>
          <li class={proof.bake === null ? '' : proof.bake.applied + proof.bake.outsideFrame === proof.bake.requested ? 'is-complete' : 'is-warn'}>
            <span class="proof-index">3</span>
            <div>
              <strong>Verify pixels</strong>
              <small>
                {proof.bake === null
                  ? proof.prepared?.imageBytes === 0 && proof.prepared !== null
                    ? 'Text-only context selected'
                    : 'Awaiting sanitized image'
                  : `${String(proof.bake.applied)}/${String(proof.bake.requested)} pixel masks baked`}
              </small>
            </div>
          </li>
          <li class={proof.transmitted === null ? '' : 'is-complete'}>
            <span class="proof-index">4</span>
            <div>
              <strong>{proof.transmitted?.channel === 'cloud' ? 'Cloud packet' : 'Planner'}</strong>
              <small>
                {proof.transmitted === null
                  ? proof.prepared === null
                    ? 'Blocked until the gate passes'
                    : 'Prepared; awaiting planner'
                  : proof.transmitted.channel === 'cloud'
                    ? `Sanitized context delivered to ${proof.transmitted.modelId}`
                    : `Stayed on-device (${proof.transmitted.modelId})`}
              </small>
            </div>
          </li>
        </ol>

        {proof.prepared?.preview === null || proof.prepared?.preview === undefined ? null : (
          <figure class="sanitized-preview">
            <img
              src={`data:image/${proof.prepared.preview.format};base64,${proof.prepared.preview.base64}`}
              alt="Sanitized screenshot produced by the local privacy gate"
            />
            <figcaption>
              <span>Sanitized cloud view · {formatBytes(proof.prepared.imageBytes)}</span>
              <span>{proof.bake === null ? 'Baked image' : `${String(proof.bake.applied)} masks verified`}</span>
            </figcaption>
          </figure>
        )}

        {proof.prepared === null || proof.prepared.preview !== null ? null : (
          <p class="proof-hint">
            Text-only safety run complete. Grant a server and enable verified image sharing below to
            show the baked cloud view.
          </p>
        )}

        {onClearPrivacyLens === undefined || proof.redaction === null || proof.redaction.applied === 0 ? null : (
          <button type="button" class="subtle-button" onClick={() => onClearPrivacyLens()}>
            Clear live page mask
          </button>
        )}
      </section>

      {warnings.length > 0 ? (
        <section class="card attention" role="alert">
          <h2>Attention</h2>
          <ul class="notices">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.backendUnavailable === null ? null : (
        /*
         * THE NO-SILENT-FALLBACK PROMPT.
         *
         * This is the whole feature made visible. When a private server is down
         * the convenient behaviour is to try the cloud: the task keeps moving,
         * and the sanitized context of an organization that deliberately chose a
         * private deployment has just gone to a third party - with every
         * downstream event still reporting a successful delivery, because it was
         * one.
         *
         * So nothing happens automatically. The step failed, nothing was sent
         * anywhere, and the alternatives are BUTTONS. Each calls
         * `onSelectBackend`, which is the only writer of the selection, so a
         * switch always has a human behind it and always lands on the next
         * receipt.
         */
        <section class="card attention" role="alert">
          <h2>{backendLabel(state.backendUnavailable.kind)} unavailable</h2>
          <p>
            {state.backendUnavailable.endpoint ?? 'the configured endpoint'} could not be reached:{' '}
            {state.backendUnavailable.error}
          </p>
          <p>
            <strong>Nothing was sent anywhere.</strong> No other backend was tried. Choose what to
            do:
          </p>
          <div class="row">
            <button
              type="button"
              class="primary"
              onClick={() => onCheckBackend?.(state.backendUnavailable?.kind ?? 'local')}
            >
              Retry
            </button>
            {state.backendUnavailable.alternatives.map((kind) => (
              <button key={kind} type="button" onClick={() => onSelectBackend?.(kind)}>
                Use {backendLabel(kind)}
              </button>
            ))}
          </div>
          <p class="hint">
            Switching changes the backend for every following step, and the change is shown here and
            recorded on each step's privacy receipt.
          </p>
        </section>
      )}

      <section class="card">
        <h2>Task</h2>
        {/*
          * A TRANSCRIPT, not a form.
          *
          * The goal used to be one input and two buttons, and an agent that
          * needed to ask something had nowhere to put the question - the loop
          * stopped and a reason appeared in a status row. A conversation is the
          * shape the interaction already had; the UI just did not admit it.
          *
          * Every line here is either FROM THE USER (trusted, the one string in
          * the pipeline that is) or FROM THE AGENT (a question composed on this
          * machine from the page's own accessible names, or a status this panel
          * generated). Nothing a server said is rendered as a message.
          */}
        <div
          class="chat"
          style={{
            maxHeight: '220px',
            overflowY: 'auto',
            marginBottom: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          {(messages ?? []).length === 0 ? (
            <p class="empty">
              Tell the agent what to do. If the goal is ambiguous it will ask
              before acting.
            </p>
          ) : (
            (messages ?? []).map((m, i) => (
              <div
                key={String(i)}
                style={{
                  alignSelf: m.role === 'you' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  padding: '6px 8px',
                  borderRadius: '8px',
                  background: m.role === 'you' ? '#2b4c7e' : '#2a2f3a',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <strong style={{ opacity: 0.7, fontSize: '0.85em' }}>
                  {m.role === 'you' ? 'You' : 'Agent'}
                </strong>
                <div>{m.text}</div>
              </div>
            ))
          )}
        </div>

        {/*
          * ONE input for both jobs. When the agent is waiting on an answer this
          * sends the answer and resumes; otherwise it starts a task. Two boxes
          * would make the user decide which one applies, and the panel already
          * knows.
          */}
        <div class="row">
          <input
            id="goal"
            type="text"
            style={{ flex: '1' }}
            placeholder={
              pendingQuestion === null || pendingQuestion === undefined
                ? 'e.g. add a laptop to the cart'
                : 'Your answer'
            }
            disabled={!attached}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key !== 'Enter') return;
              const v = (e.currentTarget as HTMLInputElement).value.trim();
              if (v === '') return;
              if (pendingQuestion !== null && pendingQuestion !== undefined) onAnswer?.(v);
              else onRunTask?.(v);
              (e.currentTarget as HTMLInputElement).value = '';
            }}
          />
          {state.loop?.running === true ? (
            <button type="button" onClick={() => onStop?.()}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              class="primary"
              disabled={!canRun}
              onClick={() => {
                const input = document.getElementById('goal') as HTMLInputElement | null;
                const v = input?.value.trim() ?? '';
                if (v === '') return;
                if (pendingQuestion !== null && pendingQuestion !== undefined) onAnswer?.(v);
                else onRunTask?.(v);
                if (input !== null) input.value = '';
              }}
            >
              {pendingQuestion === null || pendingQuestion === undefined ? 'Send' : 'Answer'}
            </button>
          )}
        </div>

        {pendingQuestion === null || pendingQuestion === undefined ? null : (
          /*
           * Stated separately from the message itself, because it is advice to a
           * PERSON rather than part of the conversation. A server that can put
           * text in front of the user could otherwise ask for a password inside
           * the extension's own trusted UI.
           */
          <p class="hint" style={{ marginTop: '6px' }}>
            Never enter a password, card number or OTP - the agent never needs
            one.
          </p>
        )}

        {/*
          * Kept, and made secondary. "One step" is how you watch the agent think,
          * which is what you want when a step is going wrong - it answers a
          * different question from "run the task" and the panel is a debug view.
          */}
        {onRunStep === undefined ? null : (
          <div class="row" style={{ marginTop: '6px' }}>
            <button
              type="button"
              disabled={!canRun || state.loop?.running === true}
              onClick={() => {
                const input = document.getElementById('goal') as HTMLInputElement | null;
                onRunStep(input?.value.trim() ?? '');
              }}
            >
              One step
            </button>
            {state.loop === null || state.loop.running ? null : (
              <span class={state.loop.reason === 'done' ? 'ok' : 'warn'}>
                {state.loop.step} step(s): {state.loop.reason}
              </span>
            )}
          </div>
        )}

        <dl class="rows" style={{ marginTop: '10px' }}>
          <dt>Page access</dt>
          {/*
            * activeTab is granted per-tab by the TOOLBAR click and revoked by
            * navigation. A click in this panel grants nothing, so when this says
            * detached the only remedy is the toolbar button - which is why the
            * note spells that out rather than showing a bare "no".
            */}
          <dd class={attached ? 'ok' : 'warn'}>
            <Status tone={attached ? 'ok' : 'warn'}>
              {state.attachedTab === null
                ? 'unknown'
                : attached
                  ? `tab ${String(state.attachedTab.tabId)}`
                  : 'detached'}
            </Status>
          </dd>
          {state.attachedTab === null ? null : (
            <>
              <dt />
              <dd>
                <small>{state.attachedTab.note}</small>
              </dd>
            </>
          )}
          {onGrantSite === undefined ? null : (
            <>
              <dt />
              <dd>
                {/*
                  * activeTab dies on navigation, and the agent's own clicks
                  * navigate - so a multi-step task outlives its first click only
                  * with a persistent grant for this one origin.
                  */}
                <button
                  type="button"
                  disabled={!attached}
                  onClick={() => onGrantSite()}
                  title={attached ? 'Grant persistent access to the attached site' : 'Click the extension toolbar button on the site first'}
                >
                  Grant page access for this site
                </button>
                {!attached ? <small>Click the extension toolbar button while the target site is active first.</small> : null}
              </dd>
            </>
          )}
          {!visionPending ? null : (
            <>
              {/*
                * A PROGRESS LINE, NOT A BLOCKER. It used to read "Blocked - load
                * the model before running a step", which was wrong twice: the
                * step is not blocked, and nobody has to load anything.
                */}
              <dt>Vision</dt>
              <dd class="warn">
                <small>
                  model loading - steps run now using the DOM scan, and vision joins when it is
                  ready
                </small>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section class="card">
        <h2>Runtime</h2>
        {state.host === null ? (
          <p class="empty">Background has not reported yet.</p>
        ) : (
          <dl class="rows">
            <dt>Host</dt>
            <dd>
              <Status tone={state.host.running ? 'ok' : 'bad'}>
                {state.host.kind ?? 'unknown'}
              </Status>
            </dd>
            <dt>Model</dt>
            {/*
              * Still stated as a blocker when absent. A model that has not been
              * asked to load and one that FAILED to load are both "not loaded"
              * here, and the note below says which - a green dot alone would
              * read as healthy either way.
              */}
            {/*
              * "not needed" is a real and common state, and it is not a warning.
              * Vision is off by default from measurement, and with it off no
              * code path reads the weights - so an amber dot there was the panel
              * reporting a fault where there was none.
              */}
            <dd class={modelLoaded ? 'ok' : visionEnabled === true ? 'warn' : ''}>
              <Status tone={modelLoaded ? 'ok' : visionEnabled === true ? 'warn' : 'idle'}>
                {modelLoaded
                  ? 'loaded'
                  : visionEnabled === true
                    ? 'loading for vision'
                    : 'not needed (vision off)'}
              </Status>
            </dd>
            {state.host.model == null ? null : (
              <>
                <dt>Backend</dt>
                {/*
                  * The backend that ACTUALLY loaded, not the one requested.
                  * Falling back from webgpu to wasm is roughly an order of
                  * magnitude and nothing else in the UI would show it.
                  */}
                <dd class={state.host.model.backend === 'webgpu' ? 'ok' : 'warn'}>
                  {state.host.model.backend}
                </dd>
                <dt>Weights</dt>
                <dd>
                  {state.host.model.weightBytes === 0
                    ? 'unmeasurable'
                    : `${(state.host.model.weightBytes / 1048576).toFixed(2)} MB`}
                </dd>
                <dt>Load time</dt>
                <dd>{Math.round(state.host.model.loadMs)} ms</dd>
              </>
            )}
            {state.host.note === '' ? null : (
              <>
                <dt>Note</dt>
                <dd>
                  <small>{state.host.note}</small>
                </dd>
              </>
            )}
          </dl>
        )}
        {/*
          * Loading is user-driven, not automatic. It spawns an offscreen
          * document on Chrome and reads ~26 MB off disk, which is not something
          * to spend because a browser started.
          */}
        {/*
          * KEPT AS A RETRY, not as a gate. The load starts on its own when the
          * panel opens with vision enabled, and `ensureModelLoading` deliberately
          * does NOT retry a failed load - a load that failed will fail again for
          * the same reason, and re-attempting it on every panel open would spend
          * the battery rediscovering that. This button is how a user asks for
          * that retry after fixing whatever caused it.
          */}
        {onLoadModel === undefined ? null : (
          <div class="actions">
            <button type="button" class="wide" onClick={onLoadModel} disabled={modelLoaded}>
              {modelLoaded ? 'Model loaded' : 'Load the vision model now'}
            </button>
          </div>
        )}
      </section>

      <section class="card">
        <h2>AI backend</h2>
        {/*
          * WHERE THE MODEL RUNS. Not what reaches it.
          *
          * Every option below sends the same payload through the same egress
          * gate; the only thing that differs is the destination. That is the
          * point of the section, and it is stated here rather than being left
          * for the reader to infer from four radio buttons.
          */}
        <p class="hint">
          The privacy pipeline is identical for all four. Perception, PII detection, redaction and
          the outbound check always run on this device.
        </p>

        {runLocked ? (
          <p class="hint">
            A task is running. The backend is fixed for the whole run - press Stop to change it.
          </p>
        ) : null}

        {state.deployment === null ? (
          <p class="empty">The background has not reported a backend yet.</p>
        ) : (
          <dl class="rows">
            <dt>Active</dt>
            <dd class={state.deployment.offDevice ? 'warn' : 'ok'}>
              <Status tone={state.deployment.offDevice ? 'warn' : 'ok'}>
                {backendLabel(state.deployment.kind)}
              </Status>
            </dd>
            <dt>Endpoint</dt>
            <dd>{state.deployment.endpoint ?? 'none - planned on this device'}</dd>
            <dt>Transport</dt>
            {/*
              * Stated plainly rather than with a padlock. A loopback http server
              * is not encrypted and saying so is more useful than a reassuring
              * icon - the bytes are on a socket either way.
              */}
            <dd class={!state.deployment.offDevice || state.deployment.encrypted ? 'ok' : 'warn'}>
              {!state.deployment.offDevice
                ? 'never leaves this device'
                : state.deployment.encrypted
                  ? 'https'
                  : 'http (loopback only)'}
            </dd>
            <dt>Access token</dt>
            <dd>{state.deployment.authenticated ? 'set for this backend' : 'none'}</dd>
          </dl>
        )}

        {onSelectBackend === undefined ? null : (
          <div class="backends">
            {/*
              * CLOUD FIRST AND UNCOLLAPSED; everything else under Advanced.
              *
              * A distribution build ships with the cloud endpoint already
              * configured and granted, so the common case is a user who never
              * touches this section at all. The other three deployments are the
              * project's actual contribution - offline, organisation-hosted,
              * fully on-device - and are kept rather than deleted, because
              * "intelligence anywhere, privacy always local" is the claim, and a
              * claim with only one deployment left is not demonstrable.
              */}
            {BACKEND_KINDS.filter((k) => k === 'cloud').map((kind) => {
              const entry = backendConfig?.[kind] ?? { endpoint: '', model: '' };
              const selected = state.deployment?.kind === kind;
              return (
                <div key={kind} class={`backend-option${selected ? ' is-selected' : ''}`}>
                  <label class="field">
                    <input
                      type="radio"
                      name="backend"
                      value={kind}
                      checked={selected}
                      /*
                       * Disabled rather than hidden when unconfigured. A missing
                       * option reads as "not supported"; a disabled one with the
                       * fields beneath it reads as "fill this in first", which is
                       * what is actually true.
                       */
                      disabled={runLocked || (isOffDevice(kind) && entry.endpoint === '')}
                      onChange={() => onSelectBackend(kind)}
                    />{' '}
                    <strong>{backendLabel(kind)}</strong>
                    <small>{backendBlurb(kind)}</small>
                  </label>

                  {/*
                    * ONLY THE FIELDS THIS KIND NEEDS. `on-device` has no endpoint
                    * to type, so it shows none - asking for one would imply it
                    * reaches something.
                    */}
                  {!isOffDevice(kind) ? null : (
                    <form
                      class="backend-fields"
                      onSubmit={(e: Event) => {
                        e.preventDefault();
                        const form = e.currentTarget as HTMLFormElement;
                        const url = (form.elements.namedItem('endpoint') as HTMLInputElement | null)
                          ?.value ?? '';
                        const model = (form.elements.namedItem('model') as HTMLInputElement | null)
                          ?.value ?? '';
                        /*
                         * SYNCHRONOUS down to the caller, which asks the browser
                         * for the origin. The first await forfeits user-gesture
                         * status and the permission prompt silently never
                         * appears, with no error to notice.
                         */
                        onConfigureBackend?.(kind, url, model);
                      }}
                    >
                      <div class="row">
                        <input
                          name="endpoint"
                          type="text"
                          style={{ flex: '1' }}
                          // This block renders the cloud row only, so `kind` is
                          // narrowed to 'cloud' and a per-kind ternary here is
                          // dead code the compiler rejects.
                          placeholder="https://your-agent-server.example"
                          defaultValue={entry.endpoint}
                        />
                      </div>
                      <div class="row">
                        <input
                          name="model"
                          type="text"
                          style={{ flex: '1' }}
                          placeholder="qwen2.5-vl (label only)"
                          defaultValue={entry.model}
                        />
                        <button type="submit" disabled={runLocked}>
                          Save &amp; grant
                        </button>
                      </div>
                      <small>
                        The model name is a label. The server decides what actually runs, and the
                        health check below reports what it says.
                      </small>
                    </form>
                  )}

                  {!isOffDevice(kind) || onSetBackendToken === undefined ? null : (
                    <form
                      class="backend-fields"
                      onSubmit={(e: Event) => {
                        e.preventDefault();
                        const form = e.currentTarget as HTMLFormElement;
                        const input = form.elements.namedItem('token') as HTMLInputElement | null;
                        /*
                         * AN EMPTY SET IS A NO-OP, and that is a fix rather than
                         * a nicety.
                         *
                         * The field is blanked below the moment a token is
                         * handed over - deliberately, because it is the one
                         * place in this UI a credential exists. So the state
                         * immediately after a SUCCESSFUL Set is an empty field,
                         * and the natural "did that work? let me press it
                         * again" gesture submitted `''`, which DELETED the
                         * stored token. Observed in a real session: the panel
                         * logged `access token cleared`, and the only trace was
                         * one timeline line that scrolls away.
                         *
                         * Removing a credential is what the Clear button beside
                         * this is for. It is explicit, it is labelled, and it
                         * cannot be reached by pressing the same control twice.
                         */
                        const typed = input?.value ?? '';
                        if (typed.trim() === '') return;
                        onSetBackendToken(kind, typed);
                        // Cleared from the DOM immediately. The field is the only
                        // place in this UI a credential ever exists, and it has no
                        // reason to persist there after it has been handed over.
                        if (input !== null) input.value = '';
                      }}
                    >
                      <div class="row">
                        <input
                          name="token"
                          type="password"
                          style={{ flex: '1' }}
                          autocomplete="off"
                          placeholder={
                            tokenSet?.[kind] === true
                              ? 'token set - type a new one to replace it'
                              : 'access token (optional)'
                          }
                        />
                        <button type="submit" disabled={runLocked}>
                          Set
                        </button>
                        <button
                          type="button"
                          disabled={runLocked}
                          onClick={(e: Event) => {
                            /*
                             * CLEARS THE FIELD TOO.
                             *
                             * Clear used to send an empty token and leave
                             * whatever had been typed sitting in the input - so
                             * the one control whose job is to remove a
                             * credential left it on screen, in a panel that gets
                             * screenshotted and screen-shared. Same reason the
                             * submit path clears it.
                             */
                            const form = (e.currentTarget as HTMLElement).closest('form');
                            const field = form?.elements.namedItem('token') as
                              | HTMLInputElement
                              | null;
                            if (field !== null && field !== undefined) field.value = '';
                            onSetBackendToken(kind, '');
                          }}
                        >
                          Clear
                        </button>
                      </div>
                      <small>
                        Sent as an authorization header, never in the payload. Kept in session
                        storage only, so it is cleared when the browser closes and has to be
                        re-entered.
                      </small>
                    </form>
                  )}

                  {onCheckBackend === undefined ? null : (
                    <div class="row">
                      <button type="button" disabled={runLocked} onClick={() => onCheckBackend(kind)}>
                        Check connection
                      </button>
                      {state.backendHealth?.kind !== kind ? (
                        <small>not checked</small>
                      ) : state.backendHealth.reachable ? (
                        <span class="ok">
                          <Status tone="ok">
                            Connected
                            {state.backendHealth.plannerId === null
                              ? ''
                              : ` - ${state.backendHealth.plannerId}`}
                          </Status>
                        </span>
                      ) : state.backendHealth.waking ? (
                        /*
                         * "Connecting", not "waking up" and not "unavailable". A
                         * free instance that has slept answers the first request
                         * after tens of seconds; a genuinely dead host behind a
                         * load balancer that swallows connections times out
                         * identically. This wording covers both without
                         * asserting which one it is.
                         */
                        <span class="warn">
                          <Status tone="warn">Connecting to AI server...</Status>
                        </span>
                      ) : (
                        <span class="bad">
                          <Status tone="bad">Unavailable - {state.backendHealth.error}</Status>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <details class="advanced-backends">
              <summary>Other deployments</summary>
              <p class="hint">
                The same page, the same redaction, the same outbound check - a different
                destination. Local runs an agent server on this machine; Private points at your
                organization's own GPU server; On-device plans here and sends nothing anywhere.
              </p>
              {BACKEND_KINDS.filter((k) => k !== 'cloud').map((kind) => {
                const entry = backendConfig?.[kind] ?? { endpoint: '', model: '' };
                const selected = state.deployment?.kind === kind;
                return (
                  <div key={kind} class={`backend-option${selected ? ' is-selected' : ''}`}>
                    <label class="field">
                      <input
                        type="radio"
                        name="backend"
                        value={kind}
                        checked={selected}
                        disabled={runLocked || (isOffDevice(kind) && entry.endpoint === '')}
                        onChange={() => onSelectBackend(kind)}
                      />{' '}
                      <strong>{backendLabel(kind)}</strong>
                      <small>{backendBlurb(kind)}</small>
                    </label>

                    {!isOffDevice(kind) ? null : (
                      <form
                        class="backend-fields"
                        onSubmit={(e: Event) => {
                          e.preventDefault();
                          const form = e.currentTarget as HTMLFormElement;
                          const url =
                            (form.elements.namedItem('endpoint') as HTMLInputElement | null)
                              ?.value ?? '';
                          const model =
                            (form.elements.namedItem('model') as HTMLInputElement | null)?.value ??
                            '';
                          // Synchronous to the caller, which reaches
                          // permissions.request - the first await forfeits the
                          // gesture and the prompt silently never appears.
                          onConfigureBackend?.(kind, url, model);
                        }}
                      >
                        <div class="row">
                          <input
                            name="endpoint"
                            type="text"
                            style={{ flex: '1' }}
                            placeholder={
                              kind === 'local'
                                ? 'http://localhost:8787'
                                : 'https://ai.your-org.internal'
                            }
                            defaultValue={entry.endpoint}
                          />
                        </div>
                        <div class="row">
                          <input
                            name="model"
                            type="text"
                            style={{ flex: '1' }}
                            placeholder="qwen2.5-vl (label only)"
                            defaultValue={entry.model}
                          />
                          <button type="submit" disabled={runLocked}>
                            Save &amp; grant
                          </button>
                        </div>
                      </form>
                    )}

                    {!isOffDevice(kind) || onSetBackendToken === undefined ? null : (
                      <form
                        class="backend-fields"
                        onSubmit={(e: Event) => {
                          e.preventDefault();
                          const form = e.currentTarget as HTMLFormElement;
                          const input = form.elements.namedItem('token') as HTMLInputElement | null;
                          // Empty Set is a no-op here too - see the cloud row
                          // above. Clear is the control that removes a token.
                          const typed = input?.value ?? '';
                          if (typed.trim() === '') return;
                          onSetBackendToken(kind, typed);
                          if (input !== null) input.value = '';
                        }}
                      >
                        <div class="row">
                          <input
                            name="token"
                            type="password"
                            style={{ flex: '1' }}
                            autocomplete="off"
                            placeholder={
                              tokenSet?.[kind] === true
                                ? 'token set - type a new one to replace it'
                                : 'access token (optional)'
                            }
                          />
                          <button type="submit" disabled={runLocked}>
                            Set
                          </button>
                          <button
                            type="button"
                            disabled={runLocked}
                            onClick={(e: Event) => {
                              const form = (e.currentTarget as HTMLElement).closest('form');
                              const field = form?.elements.namedItem('token') as
                                | HTMLInputElement
                                | null;
                              if (field !== null && field !== undefined) field.value = '';
                              onSetBackendToken(kind, '');
                            }}
                          >
                            Clear
                          </button>
                        </div>
                      </form>
                    )}

                    {onCheckBackend === undefined ? null : (
                      <div class="row">
                        <button
                          type="button"
                          disabled={runLocked}
                          onClick={() => onCheckBackend(kind)}
                        >
                          Check connection
                        </button>
                        {state.backendHealth?.kind !== kind ? (
                          <small>not checked</small>
                        ) : state.backendHealth.reachable ? (
                          <span class="ok">
                            <Status tone="ok">
                              Connected
                              {state.backendHealth.plannerId === null
                                ? ''
                                : ` - ${state.backendHealth.plannerId}`}
                            </Status>
                          </span>
                        ) : state.backendHealth.waking ? (
                          /*
                           * "Connecting", not "waking up" and not "unavailable". A
                           * free instance that has slept answers the first request
                           * after tens of seconds; a genuinely dead host behind a
                           * load balancer that swallows connections times out
                           * identically. This wording covers both without
                           * asserting which one it is.
                           */
                          <span class="warn">
                            <Status tone="warn">Connecting to AI server...</Status>
                          </span>
                        ) : (
                          <span class="bad">
                            <Status tone="bad">Unavailable - {state.backendHealth.error}</Status>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </details>
          </div>
        )}
      </section>

      <section class="card">
        <h2>
          Privacy receipt <span class="count">step {state.receipt.step}</span>
        </h2>
        {/*
          * EVERY LINE HERE IS A MEASUREMENT.
          *
          * The tempting version of this card prints "RAW PII - NOT SENT" as a
          * constant, because the architecture says it is true. That card would
          * keep saying it after a regression and would be the LAST thing anyone
          * doubted. So each claim carries the state a gate actually reported,
          * including "NOT CHECKED" for a step that failed before reaching one -
          * "we did not look" and "we looked and found nothing" must not render
          * the same.
          */}
        {state.receipt.e2eMs === null && state.receipt.step === 0 ? (
          <p class="empty">No step has run yet - nothing measured.</p>
        ) : (
          <>
            <dl class="rows">
              <dt>Deployment</dt>
              <dd>
                {state.receipt.deployment === null
                  ? 'not reported'
                  : backendLabel(state.receipt.deployment.kind)}
              </dd>
              <dt>Model answered</dt>
              {/*
                * What ANSWERED, from the plan response - not what the settings
                * field says. When the two disagree the measurement is the true
                * one, and both are shown above so the disagreement is visible.
                */}
              <dd>{state.receipt.modelAnswered ?? 'no plan returned'}</dd>
              <dt>Faces / regions</dt>
              <dd>
                {state.receipt.privacy.visionDetections} detected by vision,{' '}
                {state.receipt.privacy.piiRegions} after merge
              </dd>
              <dt>Redactions</dt>
              <dd
                class={
                  state.receipt.privacy.redactionsApplied ===
                  state.receipt.privacy.redactionsDetected
                    ? 'ok'
                    : 'warn'
                }
              >
                {state.receipt.privacy.redactionsApplied}/
                {state.receipt.privacy.redactionsDetected} applied
              </dd>
              <dt>Pixel masks</dt>
              <dd>
                {state.receipt.privacy.pixelOpsApplied}/{state.receipt.privacy.pixelOpsRequested}{' '}
                applied
                {state.receipt.privacy.pixelOpsOutsideFrame > 0
                  ? `, ${String(state.receipt.privacy.pixelOpsOutsideFrame)} off-screen`
                  : ''}
              </dd>
            </dl>

            <table>
              <thead>
                <tr>
                  <th>At the network boundary</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {receiptNetworkLines(state.receipt).map((line) => (
                  <tr key={line.label}>
                    <td>{line.label}</td>
                    <td class={line.tone === 'bad' ? 'bad' : line.tone === 'ok' ? 'ok' : ''}>
                      {line.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <dl class="rows" style={{ marginTop: '8px' }}>
              <dt>Validation</dt>
              <dd class={state.receipt.validation === 'fail' ? 'bad' : ''}>
                {state.receipt.validation.toUpperCase()}
              </dd>
              <dt>Execution</dt>
              <dd class={state.receipt.execution === 'fail' ? 'bad' : ''}>
                {state.receipt.execution.toUpperCase()}
              </dd>
              <dt>Page check</dt>
              {/*
                * "changed", never "verified". A DOM fingerprint proves that
                * something moved, not that the right thing moved - on a page with
                * a clock in the header it moves every step regardless.
                */}
              <dd class={state.receipt.verification.kind === 'unchanged' ? 'warn' : ''}>
                {state.receipt.verification.kind === 'not-checked'
                  ? 'not checked'
                  : state.receipt.verification.kind === 'changed'
                    ? 'the page changed after the action'
                    : 'the page did NOT change after the action'}
              </dd>
            </dl>

            {onCopyReceipt === undefined ? null : (
              <button
                type="button"
                class="subtle-button"
                onClick={() => onCopyReceipt(formatReceipt(state.receipt))}
              >
                Copy receipt
              </button>
            )}
          </>
        )}
      </section>

      <section class="card">
        <h2>Local agent server</h2>
        {/*
          * LOOPBACK ONLY NOW, and the label says so.
          *
          * This box used to accept any origin and the background filed it under
          * whichever kind it guessed from the current selection. From a control
          * with no kind selector that silently decided a data-sharing question:
          * with `private` selected, pasting a public vendor URL replaced the
          * organization's endpoint, kept `private` selected, and every later
          * step went to a third party while the panel and the copied privacy
          * receipt both said "Private Organization Server".
          *
          * A remote endpoint now has to be entered in the AI backend section
          * above, against a kind the user actually names. This survives for the
          * loopback development flow, where there is nothing to guess: a
          * localhost origin is the Local AI backend and cannot be anything else.
          */}
        <p class="hint">
          For <code>npm run server</code> on this machine. A remote endpoint goes in the AI backend
          section above, under the deployment you choose for it.
        </p>
        <form
          onSubmit={(e: Event) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const input = form.elements.namedItem('origin') as HTMLInputElement | null;
            // Synchronous: awaiting anything here forfeits user-gesture status
            // and the permission prompt silently never appears.
            onGrantOrigin?.(input?.value ?? '');
          }}
        >
          <div class="row">
            <input name="origin" type="text" placeholder="http://localhost:8787" />
            <button type="submit" disabled={runLocked}>
              Grant
            </button>
          </div>
        </form>

        {onToggleScreenshot === undefined ? null : (
          <label class="field option-field" style={{ marginTop: '8px' }}>
            <input
              type="checkbox"
              id="send-shot"
              onChange={(e: Event) => {
                onToggleScreenshot((e.currentTarget as HTMLInputElement).checked);
              }}
            />{' '}
            <span>Share only the verified redacted image with cloud</span>
            <small>The Privacy Gate will display that baked, sanitized image after the run.</small>
          </label>
        )}

        {onToggleVision === undefined ? null : (
          /*
           * Off by default, and labelled with the measurement rather than as a
           * feature. On a contended GPU every attempt hit `infer exceeded
           * 4000 ms`, three attempts per session, and steps took 42-44 s of
           * which ~40 s was that wait - for zero detections, because
           * `yolos-tiny` emits COCO classes the PII mapper mostly cannot use.
           * The step that skipped vision in the same run took 1.8 s.
           */
          <label class="field" style={{ marginTop: '8px' }}>
            <input
              type="checkbox"
              id="use-vision"
              // Reflects what the background has STORED. Uncontrolled, it showed
              // unchecked for a session where vision was on.
              checked={visionEnabled === true}
              onChange={(e: Event) => {
                onToggleVision((e.currentTarget as HTMLInputElement).checked);
              }}
            />{' '}
            Run local vision model (loads itself when enabled; the DOM scan finds PII either way)
          </label>
        )}

        {onTogglePlanOnly === undefined ? null : (
          /*
           * For pointing this at a real, logged-in site. Everything runs -
           * capture, vision, redaction, the server round trip, validation - and
           * only the final click is withheld, so what the redactor strips from
           * somebody's actual name and address can be read off the panel without
           * an agent pressing anything on the page.
           */
          <label class="field" style={{ marginTop: '8px' }}>
            <input
              type="checkbox"
              id="plan-only"
              checked={planOnly === true}
              onChange={(e: Event) => {
                onTogglePlanOnly((e.currentTarget as HTMLInputElement).checked);
              }}
            />{' '}
            Plan only - decide, but never click (for testing on real sites)
          </label>
        )}

        {onSetBudget === undefined ? null : (
          /*
           * The server's context window, which cannot be discovered from the
           * OpenAI-compatible response. The default fits Ollama's stock 4096;
           * a bigger server keeps the `box=` geometry the timeline otherwise
           * reports as `geometry omitted`.
           */
          <label class="field" style={{ marginTop: '8px' }}>
            Context budget (tokens){' '}
            <input
              type="number"
              id="budget-tokens"
              min={1200}
              max={120000}
              step={100}
              /*
               * The stored value first, then the last step's, then the default.
               * A field showing 3400 while steps run at 7000 is worse than no
               * field: the only way to reach the real value is to step up to it.
               */
              key={String(budgetTokens ?? state.tokenBudget ?? 'default')}
              defaultValue={String(budgetTokens ?? state.tokenBudget ?? 3400)}
              style={{ width: '90px' }}
              /*
               * COMMITTED ON BLUR OR ENTER, not on every keystroke. `onChange`
               * fired once per arrow-key press, so nudging 3400 to 7000 sent 36
               * messages and wrote 36 lines into the timeline before the run
               * even started.
               */
              onBlur={(e: Event) => {
                const v = Number((e.currentTarget as HTMLInputElement).value);
                if (Number.isFinite(v)) onSetBudget(v);
              }}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key !== 'Enter') return;
                const v = Number((e.currentTarget as HTMLInputElement).value);
                if (Number.isFinite(v)) onSetBudget(v);
              }}
            />
          </label>
        )}

        {state.serverOrigin === null ? (
          // Not a failure. Planning locally is the mode this project is built
          // around, so it is stated as a mode rather than as a missing thing.
          <p class="empty" style={{ marginTop: '8px' }}>
            No server granted - planning on-device.
          </p>
        ) : (
          <dl class="rows" style={{ marginTop: '8px' }}>
            <dt>Origin</dt>
            <dd>{state.serverOrigin.origin ?? 'none'}</dd>
            <dt>Granted</dt>
            <dd class={state.serverOrigin.granted ? 'ok' : 'warn'}>
              <Status tone={state.serverOrigin.granted ? 'ok' : 'warn'}>
                {state.serverOrigin.granted ? 'yes' : 'no'}
              </Status>
            </dd>
            {state.serverOrigin.error === null ? null : (
              <>
                <dt>Problem</dt>
                <dd class="bad">{state.serverOrigin.error}</dd>
              </>
            )}
          </dl>
        )}
      </section>

      <section class="card">
        <h2>Last action</h2>
        {state.lastAction === null ? (
          <p class="empty">No action yet.</p>
        ) : (
          <>
            <code class="action">{JSON.stringify(state.lastAction, null, 1)}</code>
            <dl class="rows" style={{ marginTop: '8px' }}>
              <dt>Executed</dt>
              <dd class={state.lastExecution?.ok === false ? 'bad' : 'ok'}>
                {state.lastExecution === null
                  ? 'not reported'
                  : `${state.lastExecution.ok ? 'ok' : 'missed'} in ${state.lastExecution.ms.toFixed(0)} ms`}
              </dd>
            </dl>
          </>
        )}
      </section>

      <section class="card">
        <h2>Perception</h2>
        <div class="stats">
          <div class="stat">
            <span class="n">{state.elementCount}</span>
            <span class="k">Elements</span>
          </div>
          <div class="stat">
            <span class="n">{state.metrics.counts.detections}</span>
            <span class="k">Detections</span>
          </div>
          <div class="stat">
            <span class="n">{state.metrics.counts.steps}</span>
            <span class="k">Steps</span>
          </div>
        </div>
      </section>

      {state.errors.length === 0 ? null : (
        <section class="card" role="alert">
          <h2>
            Errors <span class="count">({state.errors.length})</span>
          </h2>
          {/* Newest first: the most recent failure is the one being debugged. */}
          <ul class="notices">
            {[...state.errors]
              .reverse()
              .slice(0, 10)
              .map((e, i) => (
                <li key={`${e}-${String(i)}`}>{e}</li>
              ))}
          </ul>
        </section>
      )}

      <section class="card">
        <h2>
          Redacted <span class="count">({state.redactions.length})</span>
        </h2>
        {kinds.length === 0 ? (
          <p class="empty">Nothing redacted yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Count</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((row) => (
                <tr key={row.kind}>
                  <td>{row.kind}</td>
                  <td>{row.count}</td>
                  <td>{row.strategies.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="card">
        {/*
          * NOTHING MEASURED IS NOT ZERO.
          *
          * This section used to render "Latency 0 ms" with seven 0.0 ms bars and
          * "Peak heap 0.0 MB (derived-from-model-bytes)" before a single step had
          * run. The attributed source made it read as a measurement - a very fast
          * pipeline - rather than as the absence of one. `resource/sample` is
          * emitted by nothing in the codebase, so that 0.0 MB could never have
          * been real.
          *
          * The project's rule is that absent must be distinguishable from zero.
          * `hasRun` is what distinguishes them.
          */}
        <h2>
          Latency{' '}
          {hasRun ? (
            <span class="count">{state.metrics.latency.e2eMs.toFixed(0)} ms wall clock</span>
          ) : null}
        </h2>
        {!hasRun ? (
          <p class="empty">No step has run yet - nothing measured.</p>
        ) : (
          <ul class="bars">
            {bars.map((bar) => (
              <li key={bar.label}>
                <span class="label">{bar.label}</span>
                <span class="track">
                  <span
                    class="fill"
                    style={{ width: `${String(Math.round(bar.fraction * 100))}%` }}
                  />
                </span>
                <span class="value">{bar.ms.toFixed(1)} ms</span>
              </li>
            ))}
          </ul>
        )}

        <dl class="rows" style={{ marginTop: '10px' }}>
          <dt>Peak heap</dt>
          <dd class={hasRun ? '' : 'warn'}>
            {hasRun ? (
              <>
                {state.metrics.resource.peakHeap.mb.toFixed(1)} MB
                <small> ({state.metrics.resource.peakHeap.source})</small>
              </>
            ) : (
              <small>not sampled</small>
            )}
          </dd>
          <dt>Model memory</dt>
          <dd class={state.host?.model == null ? 'warn' : ''}>
            {state.host?.model == null ? (
              <small>not sampled</small>
            ) : (
              <>
                {(state.host.model.weightBytes / 1048576).toFixed(1)} MB
                <small> (measured at load)</small>
              </>
            )}
          </dd>
          <dt>Frame bytes</dt>
          <dd>{hasRun ? state.metrics.resource.frameBytes : <small>not sampled</small>}</dd>
        </dl>
      </section>

      <section class="card">
        <h2>Timeline</h2>
        {state.timeline.length === 0 ? (
          <p class="empty">Nothing yet.</p>
        ) : (
          <ol class="timeline">
            {state.timeline.map((item, i) => (
              <li key={`${item.label}-${String(i)}`} class={item.kind}>
                <span class="label">{item.label}</span> {item.detail}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/*
        * The build stamp.
        *
        * `version` comes from the BUILT MANIFEST, so it describes what is
        * actually installed rather than what the source says. The stamp is
        * written at build time. Together they answer "am I looking at the build
        * I just made" - which matters because a browser keeps serving the old
        * bundle until the extension is reloaded, and every symptom of that looks
        * like a bug in the code rather than in the loading.
        */}
      {build === undefined ? null : (
        <footer class="buildinfo">
          <span>v{build.version}</span>
          <span>built {build.built}</span>
        </footer>
      )}
    </main>
  );
}
