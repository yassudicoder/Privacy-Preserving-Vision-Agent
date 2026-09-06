import type { Action } from './action.ts';
import type { ElementRef, SanitizedContext } from './context.ts';
import type {
  BackendDescriptor,
  BackendHealth,
  BackendKind,
  BackendUnavailable,
} from './deployment.ts';
import type { ReceiptLeak } from './receipt.ts';
import type { Detection, PiiKind } from './detection.ts';
import type { Rect } from './geometry.ts';
import type { Backend, LatencyBreakdown, MemoryReading, ResourceReading } from './metrics.ts';
import type { RedactionLog } from './redaction.ts';
import type { CapturedFrame, EngineConfig, VisionResult } from './vision.ts';

/**
 * Message envelopes between extension contexts.
 *
 * Every context filters on `target` first. chrome.runtime.sendMessage
 * broadcasts to all extension contexts, so an unfiltered listener in the popup
 * will happily eat a message meant for the offscreen document.
 */

export type MessageTarget = 'background' | 'offscreen' | 'content' | 'panel';

export interface Envelope<T extends MessageTarget, K extends string, P> {
  readonly target: T;
  readonly cmd: K;
  readonly payload: P;
}

/**
 * A local-only visual mask shown over the page after redaction.
 *
 * It deliberately carries a category and geometry, never the detected value.
 * The overlay is a presentation aid; the separately baked screenshot is the
 * irreversible artifact that may cross the network boundary.
 */
export interface PrivacyLensRegion {
  readonly kind: PiiKind;
  readonly rect: Rect<'css-viewport'>;
}

/** A thumbnail of the already-baked image. Raw captures never enter panel events. */
export interface SanitizedPreview {
  readonly base64: string;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
}

// --- background -> offscreen (the model host) ------------------------------

export type HostRequest =
  | Envelope<'offscreen', 'init', { readonly config: EngineConfig }>
  | Envelope<'offscreen', 'detect', { readonly frame: CapturedFrame }>
  | Envelope<
      'offscreen',
      'bake',
      { readonly frameId: string; readonly ops: readonly unknown[]; readonly quality: number }
    >
  | Envelope<'offscreen', 'dispose', Record<string, never>>;

export type HostResponse =
  | { readonly ok: true; readonly cmd: 'init'; readonly backend: string; readonly loadMs: number; readonly weightBytes: number }
  | { readonly ok: true; readonly cmd: 'detect'; readonly result: VisionResult }
  | { readonly ok: true; readonly cmd: 'bake'; readonly base64: string; readonly opsApplied: number }
  | { readonly ok: true; readonly cmd: 'dispose' }
  | { readonly ok: false; readonly cmd: string; readonly error: string };

// --- content <-> background ------------------------------------------------

export type ContentRequest =
  | Envelope<'content', 'snapshot', Record<string, never>>
  | Envelope<'content', 'execute', { readonly action: Action }>
  | Envelope<'content', 'highlight', { readonly refs: readonly ElementRef[] }>
  | Envelope<
      'content',
      'privacy/lens',
      { readonly enabled: boolean; readonly regions: readonly PrivacyLensRegion[] }
    >;

// --- anything -> panel -----------------------------------------------------

/**
 * What the panel reduces over. Deliberately a flat, serialisable union: the
 * panel lives in a different context and only ever sees these.
 */
export type PanelEvent =
  | { readonly type: 'session/start'; readonly taskId: string; readonly goal: string; readonly at: number }
  | { readonly type: 'frame/captured'; readonly frameId: string; readonly bytes: number; readonly ms: number }
  | { readonly type: 'vision/done'; readonly result: VisionResult; readonly ms: number }
  | {
      readonly type: 'detections/merged';
      readonly detections: readonly Detection[];
      readonly ms: number;
    }
  | { readonly type: 'redaction/done'; readonly log: RedactionLog; readonly ms: number }
  | {
      readonly type: 'bake/done';
      readonly opsApplied: number;
      /**
       * Requested and outside-frame travel with applied because `opsApplied: 0`
       * alone is ambiguous, and the two readings are opposites: every op landed
       * outside the captured viewport (safe - that content is not in the
       * picture) versus ops that overlapped the frame and did not apply (a
       * redaction that was supposed to happen and did not).
       */
      readonly opsRequested: number;
      readonly opsOutsideFrame: number;
      readonly bytes: number;
      readonly ms: number;
    }
  | {
      readonly type: 'context/sent';
      readonly bytes: number;
      /**
       * Image bytes, split out of `bytes`.
       *
       * `bytes` is `JSON.stringify(context).length`, which folds the base64
       * screenshot in with the text - so nobody could see which half grew, and
       * the token overflow looked like it came from nowhere.
       */
      readonly imageBytes: number;
      readonly elementCount: number;
      readonly elementsAvailable: number;
      readonly estimatedTokens: number;
      readonly tokenBudget: number;
      readonly dropped: readonly { readonly ref: string; readonly role: string }[];
      readonly namesTruncated: number;
      readonly geometryOmitted: boolean;
      /** Rows removed because they duplicated a (role, name) already sent. */
      readonly duplicatesCollapsed: number;
      /**
       * The safe, baked image rendered in the proof panel. Omitted by old
       * event producers; null means this step deliberately has no image.
       */
      readonly preview?: SanitizedPreview | null;
    }
  /** Emitted only after a planner successfully receives the prepared context. */
  | {
      readonly type: 'context/transmitted';
      /**
       * Whether the payload left the device. Two values, on purpose.
       *
       * `cloud` here has always meant OFF-DEVICE, not "a cloud vendor" - it is
       * the answer to "did bytes cross a socket", which is the question the
       * privacy gate cares about and the only one it can answer from this
       * layer. `backend` below says WHICH off-device deployment, and it is what
       * the receipt and the settings UI read. Kept as two fields rather than
       * widened into one, because a panel that has to map four kinds back onto
       * "did it leave" would be re-deriving the safety-relevant fact from the
       * cosmetic one.
       */
      readonly channel: 'cloud' | 'on-device';
      readonly modelId: string;
      /** Which deployment answered. Absent from older producers. */
      readonly backend?: BackendKind;
    }
  /**
   * The deployment the next step will use.
   *
   * Emitted whenever the selection or its configuration changes, and once when
   * the panel asks. Carries a `BackendDescriptor`, which is a type with no field
   * capable of holding a credential - `authenticated` is a boolean.
   */
  | { readonly type: 'backend/selected'; readonly descriptor: BackendDescriptor }
  /** The result of probing a backend. Measured, never assumed from the config. */
  | { readonly type: 'backend/health'; readonly health: BackendHealth }
  /**
   * A backend could not be reached, and NOTHING was done about it.
   *
   * This event is the "no silent fallback" rule made visible. The obvious
   * behaviour when a private server is down is to try the cloud: the task keeps
   * moving, and the sanitized context of an organisation that deliberately chose
   * a private deployment has just been handed to a third party, with every
   * downstream event still reporting a successful delivery.
   *
   * So the step fails, this is emitted, and the panel renders the alternatives
   * as BUTTONS. Switching requires a click that changes the stored selection,
   * which then emits `backend/selected` and lands on the next receipt.
   */
  | { readonly type: 'backend/unavailable'; readonly unavailable: BackendUnavailable }
  /**
   * What the egress gates found in the payload for this step.
   *
   * `checkedFields` travels with the verdict because a scanner that examined
   * nothing also reports nothing found, and the receipt must be able to tell
   * "verified absent" from "never looked". Leaks carry a KIND and a FIELD PATH
   * and never a value - putting the leaked string in the leak report would leak
   * it, into the panel and the timeline both.
   */
  | {
      readonly type: 'privacy/verified';
      readonly step: number;
      readonly checkedFields: number;
      readonly leaks: readonly ReceiptLeak[];
      /** True when a gate refused and the request was not made. */
      readonly blocked: boolean;
      readonly reason: string | null;
    }
  /**
   * Whether the page actually changed after the action ran.
   *
   * The model saying `done` is a claim; this is an observation. It is a
   * fingerprint comparison, which proves that something changed and not that the
   * right thing changed - so it is reported as `changed`/`unchanged` rather than
   * as `verified`, and the receipt says the same.
   */
  | {
      readonly type: 'page/verified';
      readonly step: number;
      readonly changed: boolean;
    }
  /**
   * A plan came back. `modelId` says WHO answered.
   *
   * The timeline labelled every plan "server", including one produced entirely
   * on-device - so a run that never touched the configured model looked
   * identical to one that did, and "server type in 0 ms" read as an impossibly
   * fast network call rather than as the local baseline it actually was. The
   * planner is now named.
   */
  | {
      readonly type: 'server/response';
      readonly action: Action | null;
      readonly ms: number;
      readonly rawLength: number;
      readonly modelId: string;
    }
  | {
      readonly type: 'action/executed';
      readonly action: Action;
      readonly ok: boolean;
      readonly ms: number;
      /**
       * Plan-only: the action was decided and deliberately NOT performed.
       *
       * Reported because `ok: true` alone reads as "the click landed", and in
       * plan-only mode nothing was clicked. The receipt would otherwise print
       * `EXECUTION PASS` for a run whose whole purpose was to touch nothing -
       * which is the mode used for pointing the agent at a real logged-in page,
       * where a false success claim is least acceptable.
       */
      readonly withheld?: boolean;
    }
  /**
   * What the inference host can actually do right now.
   *
   * Not part of the step pipeline - the background emits this in reply to a
   * status query. It exists because `running` alone is misleading: the host can
   * be up with no model bundled, which a panel showing a green dot would report
   * as healthy. `modelLoaded` and `note` are what make the real state legible.
   */
  | {
      readonly type: 'host/status';
      readonly kind: string | null;
      readonly running: boolean;
      readonly modelLoaded: boolean;
      readonly note: string;
      /**
       * What `init()` actually returned. Absent until the model has loaded, and
       * absent is meaningfully different from zero - a panel showing "0 MB,
       * wasm" for a model that was never asked to load would be a lie told
       * confidently. Every field here is measured by the backend, not declared
       * by the config that requested it.
       */
      readonly model?: {
        readonly backend: Backend;
        readonly loadMs: number;
        readonly weightBytes: number;
      };
    }
  /**
   * Something worth saying that is NOT a failure.
   *
   * "planning via http://localhost:8787" and the planner's own reasoning were
   * both being emitted as `error`, so the panel listed them under Errors in red.
   * A UI that calls normal operation an error teaches you to ignore the error
   * list, which is the opposite of what it is for.
   */
  | { readonly type: 'notice'; readonly scope: string; readonly message: string }
  /** The loop began a step. `maxSteps` is the ceiling it will not pass. */
  | { readonly type: 'loop/step'; readonly step: number; readonly maxSteps: number }
  /**
   * The loop ended, and WHY.
   *
   * The reason is the point. "done" and "max-steps" are both the loop finishing
   * without an exception, and they mean opposite things about whether the task
   * was accomplished - a panel that showed only "stopped" would be hiding the
   * distinction that matters most.
   */
  | {
      readonly type: 'loop/stopped';
      readonly reason: string;
      readonly steps: number;
      readonly error: string | null;
    }
  /**
   * A step finished, with its real wall-clock duration.
   *
   * `LatencyBreakdown.e2eMs` is documented as "wall clock for the whole step,
   * NOT the sum of the above - they overlap". The panel had no source for it, so
   * it synthesised one by adding the stage times up: precisely the thing the
   * contract says the field is not. `runAgentStep` has always computed the real
   * value; nothing carried it here.
   */
  | {
      readonly type: 'step/done';
      readonly step: number;
      readonly ok: boolean;
      readonly e2eMs: number;
    }
  /**
   * Which tab the extension may actually touch.
   *
   * activeTab is per-tab and dies on navigation, so this is real state the user
   * has to be able to see - "run a step" failing because the page reloaded is
   * otherwise indistinguishable from a broken agent.
   */
  | {
      readonly type: 'tab/attached';
      readonly tabId: number | null;
      readonly note: string;
    }
  /**
   * The server origin the user supplied, and whether the browser granted it.
   * `granted: false` with an origin set means the user declined - a normal
   * outcome that the panel must show rather than treat as an absence.
   */
  | {
      readonly type: 'origin/status';
      readonly origin: string | null;
      readonly granted: boolean;
      readonly error: string | null;
    }
  | { readonly type: 'resource/sample'; readonly reading: ResourceReading }
  | { readonly type: 'error'; readonly scope: string; readonly message: string }
  | { readonly type: 'session/end'; readonly reason: 'done' | 'abort' | 'error'; readonly at: number };

// --- the orchestrator's view of one step -----------------------------------

export interface StepOutcome {
  readonly step: number;
  readonly context: SanitizedContext;
  readonly action: Action | null;
  readonly latency: LatencyBreakdown;
  readonly memory: MemoryReading;
  readonly error: string | null;
}
