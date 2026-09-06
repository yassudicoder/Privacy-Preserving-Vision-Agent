import {
  type Action,
  type BackendKind,
  type ExecutedStep,
  type LatencyBreakdown,
  type MemoryReading,
  type PanelEvent,
  type PrivacyLensRegion,
  type ReceiptLeak,
  type RedactionNonce,
  type StepOutcome,
  type ViewportInfo,
  type VisionResult,
  DEFAULT_BUDGET_POLICY,
  type ElementBudgetPolicy,
  EgressBlockedError,
  assertOutboundContext,
  neutralize,
  type Clarification,
  detectAmbiguity,
} from '@/contracts/index.ts';
import type { CaptureAdapter, CaptureOptions, InferenceHost } from '@/perception/index.ts';
import {
  type BrowserBakeResult,
  type DomPipeline,
  OutboundLeakError,
  assertNoLeak,
  validationContextFor,
} from '@/redaction/index.ts';
import {
  type AgentClient,
  type PlanOutcome,
  PROTOCOL_VERSION,
  parseAction,
  TEXT_ROLES,
  textIntent,
  validateAction,
} from '@/agent-server/index.ts';

/**
 * One step of the agent loop.
 *
 * This is the composition the nine-step comment in background.ts described and
 * nothing executed. It lives in its own module rather than in an entrypoint for
 * one reason: the ORDER is the logic. Capture before detect, detect before
 * merge, merge before bake, bake before sanitize, sanitize before anything
 * leaves the machine. Every one of those orderings is a correctness or a privacy
 * property, and none of them can be tested inside a service worker.
 *
 * Only the browser-bound seams are injected - snapshot, capture, host, client,
 * dom, execute. Everything else is imported directly, because this module is the
 * one place permitted to see perception, redaction and agent-server together.
 *
 * WHY `dom` IS INJECTED RATHER THAN IMPORTED. `redact()` needs a `DOMParser` and
 * this function can run somewhere that has none: Chrome's MV3 background is a
 * service worker with no DOM, while Firefox's is an event page that has one. So
 * the same code either worked or failed depending on the engine - and it failed
 * on Chrome, at every step. The pipeline runs in-process on Firefox and forwards
 * to the offscreen document on Chrome. The redacted `Document` never crosses a
 * boundary; it is retained on the far side and addressed by handle.
 *
 * WHAT NEVER HAPPENS HERE: page text is never read. `snapshot` returns a string
 * that crossed a JSON boundary, and it is passed straight to the pipeline, which
 * re-marks it `Untrusted` at the moment it parses. It cannot be marked here and
 * forwarded - `Untrusted` hides its payload behind a symbol, and symbol keys do
 * not serialise, so the wrapper physically cannot make the trip. The only thing
 * that leaves the machine is the `SanitizedContext`.
 */

export type StepStage =
  | 'snapshot'
  | 'capture'
  | 'detect'
  | 'redact'
  | 'bake'
  | 'sanitize'
  /**
   * The egress gate: the last stage before anything can leave the machine.
   *
   * Its own stage rather than part of `sanitize` or `plan`, because a failure
   * here means something very specific - the payload was built and then REFUSED
   * - and folding it into either neighbour would report it as a sanitizer bug or
   * as a server problem. It is neither.
   */
  | 'verify'
  | 'plan'
  | 'parse'
  | 'validate'
  | 'execute';

export interface SnapshotResult {
  /** Page HTML. Has crossed IPC, so it arrives unwrapped and is re-marked here. */
  readonly html: string;
  readonly viewport: ViewportInfo;
}

export interface ExecuteResult {
  readonly ok: boolean;
  readonly note: string;
}

export interface TargetIdentity {
  readonly role: string;
  readonly name: string | null;
}

export interface StepDeps {
  readonly snapshot: (tabId: number) => Promise<SnapshotResult>;
  readonly capture: CaptureAdapter;
  readonly host: InferenceHost;
  readonly client: AgentClient;
  /**
   * Where redact and sanitize run.
   *
   * REQUIRED, not optional. `redact()` needs a `DOMParser` and Chrome's MV3
   * service worker has none, so every Chrome step failed with "redact:
   * DOMParser is not defined" while Firefox - whose background is an event page
   * WITH a DOM - ran the identical code fine. An optional field defaulting to
   * in-process would make the Chrome fix opt-in, and forgetting to pass it would
   * reproduce that bug exactly. Making it required turns that into a compile
   * error at every call site.
   *
   * Firefox and the tests pass `createInProcessDomPipeline()`; Chrome passes
   * `createRemoteDomPipeline(...)` pointed at the offscreen document.
   */
  readonly dom: DomPipeline;
  /**
   * Performs the action in the page.
   *
   * `domPath` is how the content script finds the element: a ref like `e7` means
   * nothing on the far side, and the path deliberately never travels to the
   * server. Null for actions that name no element.
   */
  readonly execute: (
    tabId: number,
    action: Action,
    domPath: string | null,
    target: TargetIdentity | null,
  ) => Promise<ExecuteResult>;
  /**
   * Shows a local-only mask on the attached page once redaction has completed.
   * This is intentionally separate from baking: it helps a person watch the
   * protection happen, while the baked screenshot remains the network artifact.
   */
  readonly showPrivacyLens?: (
    tabId: number,
    regions: readonly PrivacyLensRegion[],
  ) => Promise<void>;
  /** Panel updates. Optional: the loop must run headless for the harness. */
  readonly emit?: (event: PanelEvent) => void;
  readonly now?: () => number;
  /**
   * ASYNC, because the heap worth reporting is the one the MODEL runs in - the
   * offscreen document on Chrome - and reaching it is a message round trip. A
   * synchronous sampler could only ever read the service worker's own heap,
   * which says nothing about the model, the decoded frames or the ORT arena.
   */
  readonly sampleMemory?: () => Promise<MemoryReading>;
  readonly signal?: AbortSignal;
}

export interface StepInput {
  readonly tabId: number;
  readonly taskId: string;
  readonly step: number;
  readonly goal: string;
  readonly url: string;
  readonly nonce: RedactionNonce;
  readonly salt: string;
  readonly allowedOrigins: readonly string[];
  readonly captureOptions: CaptureOptions;
  /** Element budget. Defaults to DEFAULT_BUDGET_POLICY. */
  readonly budget?: ElementBudgetPolicy;
  /**
   * Plan, but do not touch the page.
   *
   * Everything up to and including validation runs: capture, vision, redaction,
   * the sanitized context, the server round trip and the action check. Only the
   * final click or keystroke is withheld.
   *
   * The point is being able to verify REDACTION on a real, logged-in page -
   * somebody's actual name, address and card on file - without an agent pressing
   * anything on it. That is the one thing this project most needs to demonstrate
   * and the one situation where a wrong click is least acceptable.
   */
  readonly planOnly?: boolean;
  /**
   * Questions already asked and answered.
   *
   * From the USER, like `goal`, so the prompt renders them as instructions
   * rather than behind the data fence.
   */
  readonly clarifications?: readonly Clarification[];
  /**
   * What this task has already done.
   *
   * `SanitizedContext.history` existed and nothing ever filled it, so it was
   * always `[]` - which silently disabled every consumer that depends on it.
   * `LocalPlannerClient` skips refs it has already acted on to avoid clicking
   * the same button forever; with an empty history that loop-breaker never
   * engaged, and the baseline could not make progress.
   */
  readonly history?: readonly ExecutedStep[];
  readonly minConfidence?: number;
  /**
   * Off by default, and an explicit decision rather than a default.
   * `perception/bench.ts` exists to make this an OUTPUT of measurement.
   */
  readonly screenshot?: boolean;
  /** Where the prepared context will be planned. Used only for truthful proof UI. */
  readonly transport?: 'cloud' | 'on-device';
  /**
   * Which deployment is planning this step.
   *
   * Reported, never acted on. Nothing in this function branches on it: the
   * pipeline above the gate is identical for all four kinds, and that identity
   * is the property the whole deployment feature rests on. It travels so the
   * panel and the privacy receipt can name the destination truthfully instead of
   * inferring it from `transport`, which only says whether bytes left at all.
   *
   * `tests/orchestrator/backend-parity.test.ts` asserts the sent payload is
   * byte-identical across every value of this field.
   */
  readonly backend?: BackendKind;
  /**
   * Run the local vision model. OFF by default, from measurement.
   *
   * On a contended GPU every attempt hit `infer exceeded 4000 ms`, three
   * attempts per session, and steps ran 42-44 s of which roughly 40 s was
   * waiting for a model that returned ZERO boxes. The step that skipped vision
   * in the same run took 1.8 s.
   *
   * It is not only the contention. `Xenova/yolos-tiny` emits COCO classes, and
   * of the ten labels `labelToPiiKind` understands only `person` is one -
   * `signature`, `id-document` and `credit-card` are unreachable through it. On
   * a real page it has produced 0 detections while `scanDom` produced 17. So
   * metrics 1 and 2 are currently carried entirely by the DOM scan, and the
   * vision stage is paying ~84% of the step for nothing.
   *
   * Default-off rather than removed: the architecture requires a local vision
   * model, `bench.ts` exists to choose a better one, and this flag is how the
   * comparison gets run. It is a measured default, not a deletion.
   *
   * SAFE ONLY BECAUSE `retain` EXISTS. With vision off, `detect` never runs, so
   * the explicit `retain` command is the ONLY path that puts a frame in the
   * worker. Landing this before that command would have silently disabled every
   * screenshot.
   */
  readonly vision?: boolean;
  readonly clientVersion?: string;
}

export type StepResult =
  | { readonly ok: true; readonly outcome: StepOutcome }
  | {
      readonly ok: false;
      readonly stage: StepStage;
      readonly error: string;
      readonly latency: LatencyBreakdown;
    };

/**
 * Consecutive vision failures, and the point at which we stop asking.
 *
 * Vision timed out on all eight steps of one run, costing its full budget every
 * time AND contending for the GPU with a local LLM - which is why the browser
 * itself went laggy and `capture` climbed from 20 ms to 7 seconds. Continuing to
 * ask a model that has failed three times running is not resilience, it is
 * paying the cost of a feature that is not working.
 *
 * Module-level rather than per-step, because the condition it tracks is about
 * the ENVIRONMENT - a busy GPU - and resets when the environment changes.
 * `resetVisionBreaker()` is called at the start of every agent LOOP run.
 *
 * It previously said it was called on model load. It was not called anywhere
 * at all: the export had zero call sites, so the breaker latched for the life
 * of the worker and there was no way back short of reloading the extension.
 * Model load is the wrong hook regardless - the panel disables the Load model
 * button once a model is loaded, so that path is unreachable by design.
 */
/**
 * Refusals a model can fix if we tell it, versus refusals that are a red flag.
 *
 * These four are mistakes about OUR schema, made by a model that is otherwise
 * doing its job: the wrong verb for an element, text past the cap, a scroll or
 * wait beyond the limit. The action is refused, the reason goes into history,
 * and the next plan can correct it - `not-typeable` even says what to do
 * instead.
 *
 * Everything NOT in this set - `unknown-ref`, `origin-not-allowed`,
 * `sensitive-target`, `bad-url` - is the server naming something it was never
 * given. Those end the task, because giving a server that just tried to address
 * an element we never exposed another turn is not resilience.
 */
const CORRECTABLE_REFUSALS: ReadonlySet<string> = new Set([
  'not-typeable',
  'text-too-long',
  'scroll-too-far',
  'wait-too-long',
  'unverified-completion',
]);

function needsAction(goal: string): boolean {
  return /\b(add|buy|cart|checkout|click|enable|fill|go|login|open|search|select|submit|type|write)\b/i.test(goal);
}

function completionVerdict(action: Action, input: StepInput):
  | { readonly ok: true; readonly value: Action }
  | { readonly ok: false; readonly error: { readonly code: 'unverified-completion'; readonly detail: string } } {
  if (action.type !== 'done' || input.step > 1 || (input.history?.length ?? 0) > 0 || !needsAction(input.goal)) {
    return { ok: true, value: action };
  }
  return {
    ok: false,
    error: {
      code: 'unverified-completion',
      detail: 'the model cannot report done for an action-oriented goal before performing an action',
    },
  };
}

function recoverTextAction(
  context: StepOutcome['context'],
  goal: string,
): Extract<Action, { readonly type: 'type' }> | null {
  const intent = textIntent(goal);
  if (intent === null) return null;
  const field = context.elements.find(
    (element) =>
      TEXT_ROLES.has(element.role) &&
      !element.isSensitive &&
      !element.states.includes('disabled') &&
      !element.states.includes('readonly'),
  );
  if (field === undefined) return null;
  return { type: 'type', ref: field.ref, text: intent.text, submit: true };
}

const VISION_FAILURE_LIMIT = 3;
let visionFailures = 0;

/** Called at the start of an agent loop run, so a new task gets a fresh chance. */
export function resetVisionBreaker(): void {
  visionFailures = 0;
}

const NO_MEMORY: MemoryReading = { mb: 0, source: 'derived-from-model-bytes', jsHeapOnly: true };

function zeroLatency(): LatencyBreakdown {
  return {
    captureMs: 0,
    visionMs: 0,
    redactMs: 0,
    bakeMs: 0,
    serializeMs: 0,
    serverMs: 0,
    executeMs: 0,
    e2eMs: 0,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runAgentStep(deps: StepDeps, input: StepInput): Promise<StepResult> {
  const now = deps.now ?? ((): number => Date.now());
  const emit = deps.emit ?? ((): void => {});
  const t0 = now();

  const timing = { ...zeroLatency() };
  const dom = deps.dom;
  let stage: StepStage = 'snapshot';
  /*
   * Tracked outside the try so the cleanup below can reach it.
   *
   * The retained frame is decoded and UNREDACTED. Leaving it for the worker's
   * own eviction meant the raw pixels of the user's screen outlived the step
   * that captured them, in a document whose owner may since have been torn down.
   */
  let capturedFrameId: string | null = null;

  /** Marks the current stage, times it, and turns a throw into a staged failure. */
  const fail = (err: unknown): StepResult => {
    const msg = message(err);
    const e2eMs = now() - t0;
    emit({ type: 'error', scope: stage, message: msg });
    // Emitted on the failure path too: a step that died after 4 s of vision is a
    // different problem from one that died instantly, and the panel could not
    // tell them apart.
    emit({ type: 'step/done', step: input.step, ok: false, e2eMs });
    return { ok: false, stage, error: msg, latency: { ...timing, e2eMs } };
  };

  try {
    // --- 1. snapshot -------------------------------------------------------
    stage = 'snapshot';
    const snap = await deps.snapshot(input.tabId);
    /*
     * The HTML stays a bare string here and is re-marked inside the pipeline,
     * one file over, at the moment it is parsed.
     *
     * It cannot be marked at this point and forwarded: `Untrusted<T>` keeps its
     * payload behind a module-private symbol, symbol keys are not serialised, so
     * `JSON.stringify` of an Untrusted value yields `{}`. That is a deliberate
     * property - page text cannot leak by accidental inclusion in a payload -
     * and it means the wrapper physically cannot cross the boundary to the
     * offscreen document. Nothing in this function reads the string; it is
     * carried from one seam to another.
     */

    // --- 2. capture --------------------------------------------------------
    stage = 'capture';
    const tCapture = now();
    const frame = await deps.capture.capture(input.tabId, snap.viewport, input.captureOptions);
    capturedFrameId = frame.frameId;
    timing.captureMs = now() - tCapture;
    emit({
      type: 'frame/captured',
      frameId: frame.frameId,
      bytes: frame.encodedBytes,
      ms: timing.captureMs,
    });

    // --- 3. detect ---------------------------------------------------------
    stage = 'detect';
    const tVision = now();
    /*
     * VISION DEGRADES, IT DOES NOT ABORT.
     *
     * A failure here used to end the step and stop the loop. That is the wrong
     * severity: vision ENHANCES the detection set, and `scanDom` produces the
     * rest independently - every successful run so far reported
     * `vision 0 box(es)` while redaction still applied 15 detections from the
     * DOM. Losing the boxes costs recall on metric 1; losing the task costs
     * everything.
     *
     * It bit for real when a local LLM was running: Ollama held 3.5 GB of the
     * 6 GB GPU and the extension's WebGPU model, competing for the same device,
     * blew past its 15 s timeout. Two local models on one laptop GPU is a
     * configuration this project should survive, not die on.
     *
     * REPORTED, NEVER SWALLOWED. The panel gets an error entry and the vision
     * timing still lands, so a run with degraded perception is visible as such
     * rather than looking like a page with nothing on it. Silently substituting
     * an empty result would make metric 1 look fine while it was not being
     * measured at all.
     */
    let vision: VisionResult;
    const visionOn = input.vision === true;
    /*
     * Whether the worker was ASKED to hold this frame's decoded bitmap.
     *
     * Deliberately "asked", not "is holding". `detect` retains before it infers,
     * so a detect that times out during the forward pass still leaves the frame
     * retained - and from here a rejected request cannot say whether it failed
     * at decode (nothing retained) or at inference (retained). Being optimistic
     * costs at most one bake that fails and degrades; being pessimistic would
     * silently drop the screenshot on the single most common failure.
     */
    let retained = false;
    const skipVision = !visionOn || visionFailures >= VISION_FAILURE_LIMIT;
    try {
      if (skipVision) {
        // Reported once per step so the degradation stays visible, but no longer
        // paid for.
        emit({
          type: 'notice',
          scope: 'detect',
          message: visionOn
            ? `vision skipped after ${String(visionFailures)} consecutive failures`
            : 'vision off - detections from the DOM scan only',
        });

        /*
         * SKIPPING INFERENCE MUST NOT SKIP REDACTING THE IMAGE.
         *
         * Retention used to live only inside `detect`. So when this branch did
         * its job - decline to infer, carry on - the frame never reached the
         * worker, and the `bake` further down failed with "no retained frame
         * ... It was never detected", taking the whole step with it. The
         * degradation path destroyed what it existed to protect, and it did so
         * only on the fourth step, which made it look like a page problem.
         *
         * Only when a screenshot is actually wanted: a text-only run has no
         * reason to decode a raw frame in the worker, and retained frames are
         * decoded and UNREDACTED.
         */
        if (input.screenshot === true) {
          try {
            await deps.host.request<null>('retain', frame);
            retained = true;
          } catch (retainErr) {
            /*
             * Recorded, not thrown. A failure here costs the screenshot, and the
             * bake below is gated on `retained` so it will not run and produce
             * the misleading "never detected" message for what is really a
             * retention failure.
             */
            emit({
              type: 'error',
              scope: 'bake',
              message: `frame not retained, screenshot unavailable: ${message(retainErr)}`,
            });
          }
        }

        throw new Error('vision disabled for this session');
      }
      // Set BEFORE the await: detect retains the frame before it infers, so
      // this is true even on the paths where the request below rejects.
      retained = true;
      vision = await deps.host.request<VisionResult>('detect', frame);
      visionFailures = 0;
    } catch (err) {
      if (!skipVision) {
        visionFailures += 1;
        const detail = message(err);
        emit({ type: 'error', scope: 'detect', message: `vision unavailable: ${detail}` });
      }
      vision = {
        frameId: frame.frameId,
        detections: [],
        backend: 'stub',
        modelId: 'unavailable',
        timings: { decodeMs: 0, preprocessMs: 0, inferMs: 0, postprocessMs: 0 },
      };
    }
    timing.visionMs = now() - tVision;
    emit({ type: 'vision/done', result: vision, ms: timing.visionMs });

    // --- 4. redact ---------------------------------------------------------
    // Merges DOM detections with the vision boxes and rewrites the HTML. Pure,
    // and the pixel edits it cannot perform come back as pixelOps.
    stage = 'redact';
    const tRedact = now();
    /*
     * Delegated, because `redact` needs a DOMParser and this function may be
     * running in a context that has none. Chrome's MV3 background is a service
     * worker with no DOM; Firefox's is an event page that has one. The pipeline
     * is the seam: in-process on Firefox, forwarded to the offscreen document on
     * Chrome. The redacted Document never crosses a boundary - it is retained on
     * the far side and addressed by `handle` until `sanitize` consumes it.
     */
    const redaction = await dom.redact({
      handle: frame.frameId,
      html: snap.html,
      visionBoxes: vision.detections,
      viewport: snap.viewport,
      salt: input.salt,
      nonce: input.nonce,
      minConfidence: input.minConfidence ?? 0.5,
      /*
       * When an image is going to the server, everything redacted in the DOM
       * must be blacked out in the image too - otherwise the text says
       * `[[PII:EMAIL:1:...]]` and the picture beside it still reads the address.
       */
      pixelCoverAll: input.screenshot === true,
      frameId: frame.frameId,
      url: input.url,
      now: frame.capturedAt,
    });
    timing.redactMs = now() - tRedact;
    emit({ type: 'detections/merged', detections: redaction.detections, ms: timing.redactMs });
    emit({ type: 'redaction/done', log: redaction.log, ms: timing.redactMs });

    /*
     * Give the user a live, local proof without changing the page's data.
     * Only classification + geometry travel back to the content script; values
     * remain confined to the redaction pipeline. The mask is cleared before
     * every later snapshot, so it can never become input to the next capture.
     */
    if (deps.showPrivacyLens !== undefined) {
      const regions: PrivacyLensRegion[] = redaction.log.entries.flatMap((entry) =>
        entry.applied && entry.target.rect !== null
          ? [{ kind: entry.kind, rect: entry.target.rect }]
          : [],
      );
      try {
        await deps.showPrivacyLens(input.tabId, regions);
        emit({
          type: 'notice',
          scope: 'privacy lens',
          message:
            regions.length === 0
              ? 'no visible regions to mask on this viewport'
              : `${String(regions.length)} local mask(s) shown on the page`,
        });
      } catch (lensErr) {
        // The lens is evidence UI, never a reason to interrupt the privacy gate.
        emit({
          type: 'notice',
          scope: 'privacy lens',
          message: `could not show the page mask: ${message(lensErr)}`,
        });
      }
    }

    // --- 5. bake -----------------------------------------------------------
    // Second round trip on purpose: the ops depend on the merge, and the merge
    // needs the DOM. The worker still holds the decoded frame, so this costs no
    // second decode and no second multi-megabyte transfer.
    stage = 'bake';
    let screenshot: BrowserBakeResult | null = null;
    /*
     * No longer gated on `pixelOps.length > 0`.
     *
     * That condition meant a page whose PII was all DOM-handled produced no ops
     * and therefore no screenshot - so ticking "send screenshot" did nothing on
     * exactly the pages that mattered. It was also accidentally load-bearing:
     * before `pixelCoverAll`, sending an image on such a page would have shipped
     * the unredacted pixels. Coverage is now complete, so the gate can go.
     */
    /*
     * REFUSE TO SEND AN UNCOVERED IMAGE.
     *
     * `pixelCoverAll` asks for a blackout over every applied detection, and it
     * can only deliver one where the detection has geometry. If redaction
     * applied changes and produced NO pixel ops at all, the picture does not
     * match the text - and shipping it would put back exactly what the text
     * redaction removed.
     *
     * This is the failure that actually happened: the offscreen document parses
     * HTML with no layout, so every rect was null, `bake` reported
     * `0 pixel op(s)`, and the image went to the model unredacted. The content
     * script now stamps real geometry, and this is the guard for the next reason
     * it goes missing.
     *
     * Refusing is the safe direction: a model that gets text only is a weaker
     * agent, and a model that gets an unredacted screenshot is the thing this
     * project exists to prevent.
     */
    /*
     * PER DETECTION, not in aggregate.
     *
     * This was `appliedCount > 0 && pixelOps.length === 0`, which asks whether
     * ANY op exists rather than whether EACH redaction got one. On a page with
     * one coverable PII item and one uncoverable one, a single op disarmed the
     * whole guard and the image was sent with the second still legible.
     *
     * Worse, the page could supply that one op itself: `data-test-rect` was
     * page-authored until `stampGeometry` began clearing it, and
     * `attributeRectProvider` reads it back with no provenance check. One forged
     * rect, one pixel op, guard disarmed. Both halves of that are fixed - this
     * one, and the removeAttribute in stamp-geometry.ts - and they have to be
     * fixed together, because either alone leaves the other exploitable.
     *
     * The join is on `detectionId`, which both sides already carry.
     */
    const applied = redaction.log.entries.filter((e) => e.applied);
    const covered = new Set(redaction.pixelOps.map((o) => String(o.detectionId)));
    const uncoveredEntries = applied.filter((e) => !covered.has(String(e.detectionId)));
    const uncovered = uncoveredEntries.length > 0;
    if (input.screenshot === true && uncovered) {
      // Kinds, never values. The panel needs to know WHAT was left exposed to
      // judge the severity; the value is the thing being protected.
      const kinds = [...new Set(uncoveredEntries.map((e) => String(e.kind)))].join(', ');
      emit({
        type: 'error',
        scope: 'bake',
        message:
          `screenshot NOT sent: ${String(uncoveredEntries.length)} of ` +
          `${String(applied.length)} applied redaction(s) produced no pixel op ` +
          `(${kinds}), so the image would still show them`,
      });
    }

    if (input.screenshot === true && !uncovered && !retained) {
      // Distinct wording from the two other refusals, so the panel says which
      // one fired instead of three causes sharing one message.
      emit({
        type: 'error',
        scope: 'bake',
        message: 'screenshot unavailable: the worker was never given this frame to hold',
      });
    }

    if (input.screenshot === true && !uncovered && retained) {
      const tBake = now();
      try {
        const baked = await deps.host.request<BrowserBakeResult>('bake', {
          frameId: frame.frameId,
          ops: redaction.pixelOps,
          quality: input.captureOptions.quality,
        });
        timing.bakeMs = now() - tBake;
        emit({
          type: 'bake/done',
          opsApplied: baked.opsApplied,
          opsRequested: baked.opsRequested,
          opsOutsideFrame: baked.opsOutsideFrame,
          bytes: baked.base64.length,
          ms: timing.bakeMs,
        });

        /*
         * DID EVERY OP THAT COULD HAVE LANDED, LAND?
         *
         * `opsApplied: 0` has two opposite readings and the panel used to print
         * both as `bake 0 pixel op(s)`. A screenshot shows the VIEWPORT while the
         * DOM scan reads the whole document, so a value below the fold is
         * redacted in the text and was never in the picture - zero ops applied is
         * then correct and nothing is exposed. The other reading is that ops
         * covering visible PII were computed and failed to land, which is a
         * redaction that did not happen.
         *
         * The frame-relative check is what separates them, and it is the only
         * one that matters: an op that overlapped the captured frame and did not
         * apply means the image still shows what the text had stripped.
         */
        const shouldHaveLanded = baked.opsRequested - baked.opsOutsideFrame;
        if (shouldHaveLanded > baked.opsApplied) {
          screenshot = null;
          emit({
            type: 'error',
            scope: 'bake',
            message:
              `screenshot NOT sent: ${String(shouldHaveLanded)} pixel op(s) overlapped the ` +
              `captured frame but only ${String(baked.opsApplied)} applied, so the image would ` +
              'still show what the text redaction removed',
          });
        } else {
          screenshot = baked;
        }
      } catch (bakeErr) {
        /*
         * A FAILED BAKE COSTS THE IMAGE, NOT THE STEP.
         *
         * This file already applies that principle twice - vision degrades
         * rather than aborts, and "no image" is the safe direction when
         * redactions are uncovered. It did not apply it to the stage that
         * CONSUMES the degraded one, so a bake failure propagated to the outer
         * catch and stopped the whole loop. In a real run that turned a
         * recoverable fourth step into `loop stopped after 4 step(s): error`.
         *
         * The class is wider than the retained-frame case that exposed it: the
         * offscreen document can be torn down between redact and bake, the
         * encoder can fail, and `bake` refuses when no model is loaded. None of
         * those should end a task that can still be planned from text.
         */
        timing.bakeMs = now() - tBake;
        screenshot = null;
        emit({
          type: 'error',
          scope: 'bake',
          message: `screenshot dropped, continuing text-only: ${message(bakeErr)}`,
        });
      }
    }

    // --- 6. sanitize -------------------------------------------------------
    // The only thing permitted to leave the machine. Runs beside the retained
    // Document, which is why it goes through the same pipeline as redact.
    stage = 'sanitize';
    const tSerialize = now();
    const sanitized = await dom.sanitize({
      handle: frame.frameId,
      viewport: snap.viewport,
      url: input.url,
      taskId: input.taskId,
      step: input.step,
      goal: input.goal,
      history: input.history ?? [],
      clarifications: input.clarifications ?? [],
      screenshot,
      budget: input.budget ?? DEFAULT_BUDGET_POLICY,
    });
    const context = sanitized.context;
    timing.serializeMs = now() - tSerialize;
    emit({
      type: 'context/sent',
      bytes: JSON.stringify(context).length,
      imageBytes: context.screenshot === null ? 0 : context.screenshot.base64.length,
      elementCount: context.elements.length,
      elementsAvailable: context.budget.available,
      estimatedTokens: context.budget.estimatedTokens,
      tokenBudget: context.budget.tokenBudget,
      dropped: context.budget.dropped,
      namesTruncated: context.budget.namesTruncated,
      geometryOmitted: context.budget.geometryOmitted,
      duplicatesCollapsed: context.budget.duplicatesCollapsed,
      preview:
        context.screenshot === null
          ? null
          : {
              base64: context.screenshot.base64,
              format: context.screenshot.format,
              width: context.screenshot.width,
              height: context.screenshot.height,
            },
    });

    // --- 6b. verify ---------------------------------------------------------
    /*
     * THE EGRESS GATE. Two checks, both fail-closed, and neither optional.
     *
     * WHY HERE AS WELL AS INSIDE THE CLIENT. `HttpAgentClient` runs the SHAPE
     * check immediately before its `fetch`, which is the strongest possible
     * placement and covers all three off-device deployments because they are one
     * class. But it cannot run the CONTENT check: that needs `scanTextPatterns`,
     * and `agent-server` may import only `contracts`. This function is the one
     * layer that sees `redaction` and `agent-server` together, so it is the only
     * place the second check can live.
     *
     * The consequence, stated plainly: the deep PII re-scan runs for EVERY
     * backend including `on-device`. That is deliberate. The requirement is not
     * "check harder when the destination is a cloud" - it is that the boundary
     * does not move when the destination does. A leak that only manifests
     * on-device is still a bug in redaction, and finding it on the mode nobody
     * fears is how it gets fixed before it matters.
     *
     * WHY IT FAILS THE STEP RATHER THAN DEGRADING. `step.ts` degrades in three
     * places already - vision failing, a bake failing, an uncovered screenshot -
     * and every one of them drops an ENHANCEMENT while keeping a payload that
     * was still verified. There is no equivalent subset here: if the text about
     * to be sent still contains an unredacted value, there is nothing safe left
     * to send, and a screenshot violation at this point means one of the three
     * guards above it has a hole. Both are hard failures.
     *
     * WHAT A FINDING MEANS. The redactor scanned page text at `minConfidence`
     * and replaced what it found. This scans the already-redacted text at the
     * SAME threshold. The two are the same code with the same setting, so a
     * match now is something the redactor was configured to catch and missed.
     */
    stage = 'verify';
    const minConfidence = input.minConfidence ?? 0.5;
    let leaks: readonly ReceiptLeak[] = [];
    let checkedFields = 0;
    try {
      /*
       * Shape first. A payload that is not the right shape cannot be
       * meaningfully content-scanned - `outboundTextFields` would walk fields
       * that are not there and report a reassuring zero.
       */
      assertOutboundContext(context);
      const verdict = assertNoLeak(context, { minConfidence });
      checkedFields = verdict.fieldsScanned;
      emit({
        type: 'privacy/verified',
        step: input.step,
        checkedFields,
        leaks: [],
        blocked: false,
        reason: null,
      });
    } catch (gateErr) {
      if (gateErr instanceof OutboundLeakError) {
        leaks = gateErr.verdict.findings.map((f) => ({ kind: f.kind, field: f.field }));
        checkedFields = gateErr.verdict.fieldsScanned;
      } else if (!(gateErr instanceof EgressBlockedError)) {
        throw gateErr;
      }
      const reason = message(gateErr);
      emit({
        type: 'privacy/verified',
        step: input.step,
        checkedFields,
        leaks,
        blocked: true,
        reason,
      });
      // `fail()` emits the staged error and `step/done`. The request is never
      // made: this is before `client.plan` and there is no path around it.
      return fail(gateErr);
    }

    /*
     * ASK BEFORE PLANNING, when the goal does not pick between two candidates.
     *
     * Deterministic and local: the model was measured NOT to volunteer a
     * question - same reply whether the instruction sat in the RULES block or at
     * the very end of the prompt - so waiting for it to ask means guessing
     * forever. See `detectAmbiguity`.
     *
     * Before the server call, deliberately. There is nothing to plan yet, the
     * round trip would be wasted, and the question is composed from the page's
     * own accessible names rather than from anything a server said - which keeps
     * it on the safe side of the trust boundary.
     *
     * Skipped once an answer exists, so answering resumes the task instead of
     * being asked the same thing again.
     */
    if ((input.clarifications ?? []).length === 0) {
      const ambiguous = detectAmbiguity(input.goal, context.elements);
      if (ambiguous !== null) {
        const question = ambiguous.question;
        emit({
          type: 'notice',
          scope: 'plan',
          message: `needs an answer: ${question}`,
        });
        emit({
          type: 'notice',
          scope: 'plan',
          message: `choices: ${ambiguous.candidates.join(' | ')}`,
        });
        const e2e = now() - t0;
        emit({ type: 'step/done', step: input.step, ok: true, e2eMs: e2e });
        return {
          ok: true,
          outcome: {
            step: input.step,
            context,
            action: { type: 'ask_user', question },
            latency: { ...timing, e2eMs: e2e },
            memory: (await deps.sampleMemory?.()) ?? NO_MEMORY,
            error: null,
          },
        };
      }
    }

    // --- 7. plan -----------------------------------------------------------
    stage = 'plan';
    const tServer = now();
    const askServer = (correction?: string): Promise<PlanOutcome> =>
      deps.client.plan(
        {
          protocolVersion: PROTOCOL_VERSION,
          context,
          clientVersion: input.clientVersion ?? 'dev',
          ...(correction === undefined ? {} : { correction }),
        },
        deps.signal ?? new AbortController().signal,
      );
    const planned = await askServer();
    timing.serverMs = now() - tServer;

    if (!planned.ok) {
      /*
       * NO `server/response` here.
       *
       * Emitting one with `rawLength: 0` made the panel report "server no usable
       * action (0 chars)" for what was actually a transport failure - the
       * request never reached a model, so there was no response of any length.
       * The real cause followed on the next line, but the misleading line came
       * first and read like a model that had answered badly.
       *
       * Absent is not zero. The staged failure below says what happened.
       */
      return fail(new Error(`server: ${planned.error.error}`));
    }

    /*
     * The previous event means a context was prepared; this one means a planner
     * actually accepted it. Keeping those separate lets the UI prove that only
     * sanitized context crossed the boundary, without calling a failed request
     * a successful cloud transmission.
     */
    emit({
      type: 'context/transmitted',
      channel: input.transport ?? 'on-device',
      modelId: planned.response.modelId,
      ...(input.backend === undefined ? {} : { backend: input.backend }),
    });

    // --- 8. parse and validate ---------------------------------------------
    // The runtime backstop. Even a fully compromised server cannot name a target
    // we did not expose, because validateAction checks against this context.
    stage = 'parse';
    const parsed = parseAction(planned.response.raw);
    emit({
      type: 'server/response',
      action: parsed.ok ? parsed.value : null,
      ms: timing.serverMs,
      rawLength: planned.response.raw.length,
      modelId: planned.response.modelId,
    });
    if (!parsed.ok) {
      /*
       * SHOW WHAT CAME BACK.
       *
       * The panel reported `no usable action (688 chars)` and not one of those
       * characters, so a real failure on a real site could only be guessed at -
       * and two hypotheses were tested and discarded before anyone could see
       * that the answer was in the reply all along.
       *
       * Neutralised and capped, because this is text from a remote endpoint:
       * untrusted by the same rule that governs page content, and rendered as a
       * diagnostic rather than trusted as one.
       */
      const snippet = neutralize(planned.response.raw).replace(/\s+/g, ' ').slice(0, 220);
      return fail(
        new Error(
          `unparseable action: ${parsed.error.code} (${parsed.error.detail})` +
            (snippet === '' ? '' : ` - model said: ${snippet}`),
        ),
      );
    }

    stage = 'validate';
    const vctx = validationContextFor(context, input.allowedOrigins);
    let action = parsed.value;
    let verdict = validateAction(action, vctx);
    const completion = completionVerdict(action, input);
    if (!completion.ok) verdict = completion;

    if (!verdict.ok && verdict.error.code === 'unverified-completion') {
      const recovered = recoverTextAction(context, input.goal);
      if (recovered !== null) {
        const recoveredVerdict = validateAction(recovered, vctx);
        if (recoveredVerdict.ok) {
          action = recovered;
          verdict = recoveredVerdict;
          emit({
            type: 'notice',
            scope: 'validate',
            message: `safe text-entry recovery selected ${String(recovered.ref)}`,
          });
        }
      }
    }

    /*
     * ONE RE-PLAN, WITH THE REFUSAL IN FRONT OF THE MODEL.
     *
     * MEASURED, not assumed. With `TYPEABLE` rendered and rule 6 rewritten, a 3B
     * model at temperature 0 still returned
     * `{"type":"type","ref":"e14","text":"Add Laptop Pro to cart"}` at a BUTTON -
     * the right element, the wrong verb, three runs in a row. Handed the SAME
     * prompt plus a short CORRECTION block naming what it just got wrong, it
     * returned `{"type":"click","ref":"e14"}` first try.
     *
     * So the missing piece was never another rule. It was feedback at the moment
     * of the mistake, rather than a history line it would read a step later and
     * ignore.
     *
     * Bounded at ONE. A second refusal is reported and the step ends: a model
     * that cannot take the correction will not take it on the third attempt
     * either, and an unbounded retry is a way to send a hostile server an
     * unlimited number of tries at the allowlist.
     *
     * Only for CORRECTABLE refusals. `unknown-ref` and `origin-not-allowed` are
     * a server asking for something it was never given, and re-asking it is the
     * opposite of a backstop.
     */
    if (!verdict.ok && CORRECTABLE_REFUSALS.has(verdict.error.code)) {
      // Captured as a const: `action` is reassigned below, so narrowing it
      // inside a callback does not survive.
      const refused = action;
      const ref = 'ref' in refused ? String(refused.ref) : '';
      const role =
        ref === ''
          ? 'element'
          : (context.elements.find((e) => String(e.ref) === ref)?.role ?? 'element');
      const correction =
        `Your previous reply was {"type":"${refused.type}","ref":"${ref}",...} and it was ` +
        `REJECTED: ${verdict.error.detail}
` +
        `Ref ${ref} is a ${role}. Reply again with a valid action for what you are ` +
        'trying to do.';

      emit({
        type: 'notice',
        scope: 'validate',
        message: `re-planning once: ${verdict.error.code} at ${ref}`,
      });

      const tRetry = now();
      const retried = await askServer(correction);
      timing.serverMs += now() - tRetry;

      if (retried.ok) {
        const reparsed = parseAction(retried.response.raw);
        if (reparsed.ok) {
          const secondBase = validateAction(reparsed.value, vctx);
          const secondCompletion = completionVerdict(reparsed.value, input);
          const second = secondBase.ok && !secondCompletion.ok ? secondCompletion : secondBase;
          if (second.ok) {
            action = reparsed.value;
            verdict = second;
            emit({
              type: 'notice',
              scope: 'validate',
              message: `correction accepted: ${action.type}`,
            });
          }
        }
      }
      if (!verdict.ok && verdict.error.code === 'unverified-completion') {
        const recovered = recoverTextAction(context, input.goal);
        if (recovered !== null) {
          const recoveredVerdict = validateAction(recovered, vctx);
          if (recoveredVerdict.ok) {
            action = recovered;
            verdict = recoveredVerdict;
            emit({
              type: 'notice',
              scope: 'validate',
              message: `safe text-entry recovery selected ${String(recovered.ref)}`,
            });
          }
        }
      }
    }

    if (!verdict.ok) {
      /*
       * A CORRECTABLE REFUSAL IS A STEP OUTCOME, NOT A DEAD TASK.
       *
       * This used to `fail()`, which ends the step with ok:false and stops the
       * loop. That made validation actively harmful: catching a bad action
       * cheaply is worth nothing if catching it kills the task. A real run ended
       * `loop stopped after 2 step(s): error` because the model typed at a
       * button on its second step - a mistake it corrects perfectly well when
       * told.
       *
       * The shape is the one a MISSED action already uses: the step succeeds,
       * `outcome.error` says what went wrong, and the loop records it in history
       * so the next plan can see it. A model that keeps repeating the refusal is
       * then stopped by the loop's own repeat guard, which is where that
       * decision belongs - a refusal is evidence, and two of them are a pattern.
       *
       * NOT EVERY REFUSAL IS CORRECTABLE, and the difference is the whole
       * security story. `CORRECTABLE_REFUSALS` covers mistakes a well-behaved
       * model makes about our schema. Everything else - a ref we never sent, an
       * origin outside the grant, typing into a field holding PII - is the
       * server asking for something it was never permitted to do. CLAUDE.md
       * calls the ref allowlist the runtime backstop against a fully compromised
       * server; handing such a server another turn to try again is the opposite
       * of a backstop, so those still end the task.
       */
      const detail = `refused action: ${verdict.error.code} (${verdict.error.detail})`;
      if (verdict.error.code === 'unverified-completion') {
        return fail(new Error(detail));
      }
      if (!CORRECTABLE_REFUSALS.has(verdict.error.code)) {
        return fail(new Error(detail));
      }
      emit({ type: 'error', scope: 'validate', message: detail });
      const refusedE2e = now() - t0;
      emit({ type: 'step/done', step: input.step, ok: true, e2eMs: refusedE2e });
      return {
        ok: true,
        outcome: {
          step: input.step,
          context,
          action,
          latency: { ...timing, e2eMs: refusedE2e },
          memory: (await deps.sampleMemory?.()) ?? NO_MEMORY,
          error: detail,
        },
      };
    }

    // --- 9. execute --------------------------------------------------------
    stage = 'execute';
    const tExecute = now();
    /*
     * The ref -> element map stays on the client. `extractRefPaths` walks the
     * same elements, in the same order, that `extractElements` assigned refs to,
     * so `e7` here is the element `e7` was in the context we sent.
     */
    const refPaths = new Map(sanitized.refPaths);
    const domPath = 'ref' in action ? (refPaths.get(String(action.ref)) ?? null) : null;
    const executed =
      input.planOnly === true
        ? { ok: true, note: 'plan only - the page was not touched' }
        : await deps.execute(
            input.tabId,
            action,
            domPath,
            'ref' in action
              ? (() => {
                  const target = context.elements.find((element) => element.ref === action.ref);
                  return target === undefined
                    ? null
                    : { role: target.role, name: target.name?.text ?? null };
                })()
              : null,
          );
    timing.executeMs = now() - tExecute;
    emit({
      type: 'action/executed',
      action,
      ok: executed.ok,
      ms: timing.executeMs,
      ...(input.planOnly === true ? { withheld: true } : {}),
    });

    const e2eMs = now() - t0;
    emit({ type: 'step/done', step: input.step, ok: true, e2eMs });

    return {
      ok: true,
      outcome: {
        step: input.step,
        context,
        action,
        latency: { ...timing, e2eMs },
        memory: (await deps.sampleMemory?.()) ?? NO_MEMORY,
        error: executed.ok ? null : executed.note,
      },
    };
  } catch (err) {
    return fail(err);
  } finally {
    /*
     * Always, including on every failure path. A step that died at `plan` still
     * captured a frame, and that frame is a picture of the user's screen.
     *
     * Fire-and-forget with the rejection swallowed: this is cleanup, and a
     * worker that has already gone away cannot be told to forget something it
     * no longer has. Turning that into a step failure would replace a real
     * error with a misleading one.
     */
    if (capturedFrameId !== null) {
      void deps.host.request('release', { frameId: capturedFrameId }).catch(() => {});
    }
  }
}
