import {
  type Action,
  type BackendDescriptor,
  type BackendHealth,
  type BackendUnavailable,
  type MetricsSnapshot,
  type PanelEvent,
  type PrivacyReceipt,
  type RedactionEntry,
  type SanitizedPreview,
  type TargetSpec,
  describeTarget,
  emptyReceipt,
  totalVisionMs,
  zeroMetrics,
} from '@/contracts/index.ts';

/**
 * Panel state as a pure reduction over events.
 *
 * All of the panel's behaviour lives in `reducePanel`, so the UI can be verified
 * in Node without rendering anything. The components below it are a thin view.
 */

export interface TimelineItem {
  readonly at: number;
  readonly label: string;
  readonly detail: string;
  /**
   * `warn` is for a step that SUCCEEDED while doing less than asked - a context
   * budget that dropped elements, most of all. It is not an error and must not
   * read like a normal line either, because bounded coverage that looks routine
   * is how "we covered everything" gets believed.
   */
  /**
   * `sent` is a cloud delivery: the one row that means data crossed the line.
   * It used to share `redaction` with on-device work, so a context leaving for
   * a cloud model rendered in the same green as a mask applied on this device.
   */
  readonly kind: 'info' | 'warn' | 'redaction' | 'sent' | 'action' | 'error';
}

/**
 * What the model asked for, as one timeline line.
 *
 * It used to be the verb alone - `type in 8227 ms`, `abort in 244 ms` - so a
 * real amazon.in run that typed into a search box, re-typed, and gave up left
 * no record of WHAT was typed, WHERE, or WHY it stopped, and the server kept
 * no log either. The reason an agent aborts is the most useful line in a
 * failed run. Clipped: it is model output, and the timeline is one line each.
 */
/** How an action named its element: the model's target, or a ref from our own planners. */
function whereOf(a: { readonly ref: unknown; readonly target?: TargetSpec }): string {
  return a.target !== undefined ? describeTarget(a.target, { values: true }) : String(a.ref);
}

function describePlanned(action: Action): string {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
  switch (action.type) {
    case 'click':
      return `click ${whereOf(action)}`;
    case 'type':
      return `type ${whereOf(action)} "${clip(action.text, 40)}"${action.submit ? ' + submit' : ''}`;
    case 'select':
      return `select ${whereOf(action)} "${clip(action.option, 40)}"`;
    case 'ask_user':
      return `ask_user: ${clip(action.question, 120)}`;
    case 'abort':
      return `abort: ${clip(action.reason, 120)}`;
    case 'done':
      return `done: ${clip(action.summary, 120)}`;
    default:
      return action.type;
  }
}

/**
 * Evidence for the current privacy boundary. This is deliberately a compact
 * ledger of measured pipeline events, not an interpretation of page content.
 */
export interface PrivacyGateState {
  readonly capture: { readonly bytes: number; readonly ms: number } | null;
  readonly redaction: {
    readonly detected: number;
    readonly applied: number;
    readonly residualRisk: 'none' | 'low' | 'unknown';
  } | null;
  readonly bake: {
    readonly requested: number;
    readonly applied: number;
    readonly outsideFrame: number;
    readonly bytes: number;
    readonly ms: number;
  } | null;
  readonly prepared: {
    readonly bytes: number;
    readonly imageBytes: number;
    readonly preview: SanitizedPreview | null;
  } | null;
  readonly transmitted: { readonly channel: 'cloud' | 'on-device'; readonly modelId: string } | null;
}

export interface PanelState {
  readonly session: {
    readonly taskId: string;
    readonly goal: string;
    readonly running: boolean;
    readonly step: number;
  } | null;
  readonly redactions: readonly RedactionEntry[];
  readonly metrics: MetricsSnapshot;
  readonly timeline: readonly TimelineItem[];
  /**
   * What the runtime reports about itself. Null means "never reported", which
   * is deliberately distinct from a host that reported itself stopped.
   */
  readonly host: {
    readonly kind: string | null;
    readonly running: boolean;
    readonly modelLoaded: boolean;
    readonly note: string;
    /**
     * What init() measured. Null while the model has not loaded - deliberately
     * not zeroes, because "0 MB on wasm" reads as a loaded model on a bad
     * backend rather than as no model at all.
     */
    readonly model: {
      readonly backend: string;
      readonly loadMs: number;
      readonly weightBytes: number;
    } | null;
  } | null;
  /**
   * Which tab the extension may drive, and why not when it may not.
   *
   * activeTab is granted per-tab by the toolbar click and revoked by navigation,
   * so this is genuine state the user must see: a step failing because the page
   * reloaded looks exactly like a broken agent otherwise.
   */
  readonly attachedTab: {
    readonly tabId: number | null;
    readonly note: string;
    /** The site the agent is on, so the panel can NAME it rather than say "a page". */
    readonly origin: string | null;
    /** False when the access dies with the current page (an `activeTab` grant). */
    readonly durable: boolean;
  } | null;
  /**
   * The loop, when one is running or has run.
   *
   * `reason` is null while running and a StopReason afterwards. "done" and
   * "max-steps" both mean the loop ended without throwing and mean opposite
   * things about the task, so the panel shows the reason rather than a state.
   */
  readonly loop: {
    readonly running: boolean;
    readonly step: number;
    readonly maxSteps: number;
    readonly reason: string | null;
  } | null;
  /** Null until the user has tried. Distinct from "tried and was declined". */
  readonly serverOrigin: {
    readonly origin: string | null;
    readonly granted: boolean;
    readonly error: string | null;
  } | null;
  readonly lastAction: Action | null;
  readonly lastExecution: { readonly ok: boolean; readonly ms: number } | null;
  /** Elements in the last context sent. The only visible proxy for metric 1. */
  readonly elementCount: number;
  /**
   * The prompt budget the last step ran under.
   *
   * Held so the panel's input can show what is actually in force rather than a
   * hardcoded default that may disagree with the background's stored value.
   */
  readonly tokenBudget: number | null;
  readonly errors: readonly string[];
  /** Set when the last step was refused. The panel surfaces this prominently. */
  readonly lastRefusal: string | null;
  /** The local privacy-gate proof for the most recent agent step. */
  readonly privacyGate: PrivacyGateState;
  /**
   * Which deployment the next step will use. Null until the background says.
   *
   * A `BackendDescriptor` and not the raw `DeploymentConfig`, deliberately: this
   * object is rendered, and the descriptor is the shape with no field capable of
   * holding a credential.
   */
  readonly deployment: BackendDescriptor | null;
  /** The last health probe. Null means never probed, which is not "down". */
  readonly backendHealth: BackendHealth | null;
  /**
   * A backend that could not be reached, held until the user resolves it.
   *
   * Held rather than pushed into `errors` because this one needs BUTTONS. It is
   * the "no silent fallback" flow: the alternatives are offered here and nothing
   * acts on them until a click changes the selection.
   */
  readonly backendUnavailable: BackendUnavailable | null;
  /**
   * The receipt for the step in progress, and the finished ones.
   *
   * Two fields, because a receipt is only truthful once its step has ended: a
   * half-filled one says `validation: not-reached` for a step that simply has
   * not validated yet. `current` is the accumulator and `receipts` is the
   * record.
   */
  readonly receipt: PrivacyReceipt;
  readonly receipts: readonly PrivacyReceipt[];
}

export const initialPanelState: PanelState = {
  loop: null,
  attachedTab: null,
  session: null,
  redactions: [],
  metrics: zeroMetrics(),
  host: null,
  serverOrigin: null,
  lastAction: null,
  lastExecution: null,
  elementCount: 0,
  tokenBudget: null,
  timeline: [],
  errors: [],
  lastRefusal: null,
  privacyGate: {
    capture: null,
    redaction: null,
    bake: null,
    prepared: null,
    transmitted: null,
  },
  deployment: null,
  backendHealth: null,
  backendUnavailable: null,
  receipt: emptyReceipt(0),
  receipts: [],
};

const MAX_TIMELINE = 200;
/**
 * How many finished receipts to keep.
 *
 * The loop's own ceiling is 8 steps, so this holds several whole tasks. Bounded
 * at all because the panel is long-lived and a receipt carries per-step arrays.
 */
const MAX_RECEIPTS = 40;

function pushReceipt(
  receipts: readonly PrivacyReceipt[],
  receipt: PrivacyReceipt,
): readonly PrivacyReceipt[] {
  const next = [...receipts, receipt];
  return next.length > MAX_RECEIPTS ? next.slice(next.length - MAX_RECEIPTS) : next;
}

function push(timeline: readonly TimelineItem[], item: TimelineItem): readonly TimelineItem[] {
  const next = [...timeline, item];
  return next.length > MAX_TIMELINE ? next.slice(next.length - MAX_TIMELINE) : next;
}

function withLatency(
  state: PanelState,
  patch: Partial<MetricsSnapshot['latency']>,
): MetricsSnapshot {
  const latency = { ...state.metrics.latency, ...patch };
  return {
    ...state.metrics,
    latency: {
      ...latency,
      /*
       * CARRIED, not computed.
       *
       * This used to sum the stage times, which `LatencyBreakdown` explicitly
       * says e2eMs is not - the stages overlap, and the sum is neither the wall
       * clock nor anything else meaningful. The real figure now arrives on
       * `step/done`; until a step completes this keeps whatever it had, and the
       * Latency section is hidden entirely before the first step.
       */
      e2eMs: latency.e2eMs,
    },
  };
}

export function reducePanel(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case 'session/start':
      return {
        ...initialPanelState,
        /*
         * The DEPLOYMENT SURVIVES A NEW SESSION, and the health probe with it.
         *
         * Everything else here is per-task and correctly cleared. The selected
         * backend is not: it is a SETTING, owned by the background, and the
         * panel has no way to re-derive it - clearing it would blank the
         * settings UI at the start of every run and leave the receipt's
         * `deployment` null for the first step of every task, which is the field
         * the whole demonstration turns on.
         */
        deployment: state.deployment,
        backendHealth: state.backendHealth,
        session: { taskId: event.taskId, goal: event.goal, running: true, step: 0 },
        receipt: emptyReceipt(0, event.taskId),
        timeline: [{ at: event.at, label: 'session', detail: event.goal, kind: 'info' }],
      };

    case 'frame/captured':
      return {
        ...state,
        /*
         * A NEW STEP STARTS HERE.
         *
         * `capture` is the first event any step emits - `snapshot` emits none -
         * so this is where the accumulator resets. Resetting on `loop/step`
         * instead would miss the single-step button, which never emits one.
         *
         * The deployment is carried in rather than left null: the receipt has to
         * name which backend the step ran on, and that fact is known before the
         * step starts, not after it transmits.
         */
        receipt: {
          ...emptyReceipt(state.receipt.step + 1, state.session?.taskId ?? null),
          deployment: state.deployment,
          perception: { domCaptured: true, screenshotCaptured: true, frameBytes: event.bytes },
        },
        // A new step supersedes the previous unavailable-backend banner; the
        // errors list keeps the record.
        backendUnavailable: null,
        /*
         * THE WHOLE PROOF RESETS, not just `capture`.
         *
         * This spread `...state.privacyGate` and overwrote only `capture`, so
         * `redaction`, `bake`, `prepared` and `transmitted` survived into the
         * next step - and nothing else cleared them, because `session/start` is
         * emitted by no production code path.
         *
         * The result: step 2 captures a frame and then dies at redact, the
         * receipt card correctly reports `not-checked` everywhere, and the
         * Privacy Gate section directly above it still shows "Sanitized context
         * delivered to qwen2.5vl:3b" marked complete, step 1's mask counts, and
         * step 1's sanitized preview image - for a step in which nothing was
         * sanitized and nothing was sent. Two sections of one panel
         * disagreeing, with the reassuring green one being the wrong one.
         */
        privacyGate: {
          capture: { bytes: event.bytes, ms: event.ms },
          redaction: null,
          bake: null,
          prepared: null,
          transmitted: null,
        },
        /*
         * A refusal belongs to the step that was refused. Left standing, it
         * produced a permanent "last action refused" banner - including after a
         * later step corrected the action and succeeded.
         */
        lastRefusal: null,
        metrics: {
          ...withLatency(state, { captureMs: event.ms }),
          resource: { ...state.metrics.resource, frameBytes: event.bytes },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: 'capture',
          detail: `${String(event.bytes)} bytes in ${event.ms.toFixed(1)} ms`,
          kind: 'info',
        }),
      };

    case 'vision/done': {
      const metrics = withLatency(state, {
        visionMs: event.ms > 0 ? event.ms : totalVisionMs(event.result.timings),
      });
      return {
        ...state,
        receipt: {
          ...state.receipt,
          privacy: {
            ...state.receipt.privacy,
            visionDetections: event.result.detections.length,
          },
        },
        metrics: {
          ...metrics,
          resource: { ...metrics.resource, backend: event.result.backend },
          counts: {
            ...metrics.counts,
            detections: metrics.counts.detections + event.result.detections.length,
          },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: 'vision',
          detail: `${String(event.result.detections.length)} box(es) via ${event.result.backend}`,
          kind: 'info',
        }),
      };
    }

    case 'detections/merged':
      return {
        ...state,
        receipt: {
          ...state.receipt,
          privacy: { ...state.receipt.privacy, piiRegions: event.detections.length },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: 'merge',
          detail: `${String(event.detections.length)} detection(s) after merge`,
          kind: 'info',
        }),
      };

    case 'redaction/done': {
      const applied = event.log.entries.filter((e) => e.applied);
      const metrics = withLatency(state, { redactMs: event.ms });
      return {
        ...state,
        redactions: [...state.redactions, ...applied],
        receipt: {
          ...state.receipt,
          privacy: {
            ...state.receipt.privacy,
            redactionsApplied: applied.length,
            redactionsDetected: event.log.entries.length,
            forgeriesStripped: event.log.summary.forgeriesStripped,
            residualRisk: event.log.residualRisk,
          },
        },
        privacyGate: {
          ...state.privacyGate,
          redaction: {
            detected: event.log.entries.length,
            applied: applied.length,
            residualRisk: event.log.residualRisk,
          },
        },
        metrics: {
          ...metrics,
          counts: {
            ...metrics.counts,
            redactions: metrics.counts.redactions + applied.length,
            forgeriesStripped:
              metrics.counts.forgeriesStripped + event.log.summary.forgeriesStripped,
          },
        },
        timeline: push(state.timeline, {
          at: event.log.createdAt,
          label: 'redaction',
          detail: `${String(applied.length)} applied, residual risk ${event.log.residualRisk}`,
          kind: 'redaction',
        }),
      };
    }

    case 'bake/done':
      return {
        ...state,
        receipt: {
          ...state.receipt,
          privacy: {
            ...state.receipt.privacy,
            pixelOpsRequested: event.opsRequested,
            pixelOpsApplied: event.opsApplied,
            pixelOpsOutsideFrame: event.opsOutsideFrame,
          },
        },
        privacyGate: {
          ...state.privacyGate,
          bake: {
            requested: event.opsRequested,
            applied: event.opsApplied,
            outsideFrame: event.opsOutsideFrame,
            bytes: event.bytes,
            ms: event.ms,
          },
        },
        metrics: withLatency(state, { bakeMs: event.ms }),
        timeline: push(state.timeline, {
          at: 0,
          label: 'bake',
          /*
           * `N pixel op(s)` alone was unreadable. A run showing `bake 0 pixel
           * op(s)` could mean the image was clean because the PII was below the
           * fold, or that redactions were computed and failed to land. Same
           * line, opposite meanings.
           */
          detail:
            `${String(event.opsApplied)}/${String(event.opsRequested)} pixel op(s)` +
            (event.opsOutsideFrame > 0
              ? `, ${String(event.opsOutsideFrame)} off-screen`
              : '') +
            `, ${String(event.bytes)} bytes`,
          kind: 'redaction',
        }),
      };

    case 'context/sent':
      return {
        ...state,
        elementCount: event.elementCount,
        tokenBudget: event.tokenBudget,
        /*
         * PREPARED, not transmitted. The bytes are recorded here and the CLAIM
         * is left alone: `context/sent` fires when the payload has been built,
         * and a payload can be built and then refused by the egress gate, or
         * built and then fail to reach a server. Marking it "SENT" at this point
         * would be the receipt reporting a transmission that had not happened -
         * which is the exact failure the two-event split (`context/sent` then
         * `context/transmitted`) was introduced to prevent.
         */
        receipt: {
          ...state.receipt,
          /*
           * An event with no `analysis` field leaves the previous value alone.
           * Defaulting it to `not-run` here would let an older producer erase a
           * real result, and "nothing was analysed" is a claim this receipt is
           * not entitled to make on the strength of a missing field.
           */
          analysis: event.analysis ?? state.receipt.analysis,
          network: {
            ...state.receipt.network,
            sanitizedContext: { state: 'not-checked' },
            redactedScreenshot:
              event.imageBytes > 0
                ? { state: 'not-checked' }
                : { state: 'verified-absent', checkedFields: 1 },
          },
        },
        privacyGate: {
          ...state.privacyGate,
          prepared: {
            bytes: event.bytes,
            imageBytes: event.imageBytes,
            preview: event.preview ?? null,
          },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: 'sent',
          /*
           * A DROP IS NOT A NORMAL STEP. CLAUDE.md: "if a workflow bounds
           * coverage, log what was dropped - silent truncation reads as covered
           * everything when it didn't." The refs are included because the panel
           * is a debug view and a human needs to see what went missing.
           */
          detail:
            (event.elementCount === event.elementsAvailable
              ? `${String(event.elementCount)} element(s)`
              : `${String(event.elementCount)} of ${String(event.elementsAvailable)} element(s)` +
                ` - dropped ${String(event.dropped.length)}` +
                ` (${event.dropped
                  .slice(0, 6)
                  .map((d) => d.ref)
                  .join(', ')}${event.dropped.length > 6 ? ', ...' : ''})`) +
            `, ~${String(event.estimatedTokens)}/${String(event.tokenBudget)} tok` +
            (event.duplicatesCollapsed > 0
              ? `, ${String(event.duplicatesCollapsed)} duplicate(s) collapsed`
              : '') +
            (event.geometryOmitted ? ', geometry omitted' : '') +
            (event.namesTruncated > 0
              ? `, ${String(event.namesTruncated)} name(s) truncated`
              : '') +
            `, ${String(event.bytes)} bytes` +
            (event.imageBytes > 0 ? ` (${String(event.imageBytes)} image)` : ''),
          kind: event.elementCount === event.elementsAvailable ? 'info' : 'warn',
        }),
      };

    case 'context/transmitted': {
      /*
       * The bytes come from `privacyGate.prepared`, which `context/sent` filled
       * one event earlier. Deliberately not re-derived and not carried on this
       * event: there is exactly one measurement of the payload size, taken where
       * the payload was built, and a second number computed elsewhere would
       * eventually disagree with it.
       */
      const prepared = state.privacyGate.prepared;
      const offDevice = event.channel === 'cloud';
      /*
       * NO MEASUREMENT, NO CLAIM.
       *
       * This read `prepared?.bytes ?? 0` and printed "SENT (0 bytes)" when
       * `context/sent` had not been seen - a receipt line asserting both that a
       * transmission happened and that it was empty, neither of which was
       * measured. `not-checked` is the honest answer: something was transmitted,
       * and this panel never saw how much.
       */
      const claim = (n: number | undefined): PrivacyReceipt['network']['sanitizedContext'] =>
        n === undefined
          ? { state: 'not-checked' }
          : offDevice
            ? { state: 'sent', bytes: n }
            : { state: 'stayed-on-device', bytes: n };
      return {
        ...state,
        receipt: {
          ...state.receipt,
          modelAnswered: event.modelId,
          network: {
            ...state.receipt.network,
            sanitizedContext: claim(prepared?.bytes),
            redactedScreenshot:
              prepared === null || prepared === undefined
                ? { state: 'not-checked' }
                : prepared.imageBytes === 0
                  ? { state: 'verified-absent', checkedFields: 1 }
                  : claim(prepared.imageBytes),
          },
        },
        privacyGate: {
          ...state.privacyGate,
          transmitted: { channel: event.channel, modelId: event.modelId },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: event.channel === 'cloud' ? 'privacy gate' : 'local planner',
          detail:
            event.channel === 'cloud'
              ? `sanitized context delivered to ${event.modelId}`
              : `sanitized context stayed on-device (${event.modelId})`,
          // Cloud crossed the line; on-device did not. Same row, two facts -
          // the label and the text already said so, and now the colour does.
          kind: event.channel === 'cloud' ? 'sent' : 'redaction',
        }),
      };
    }

    case 'server/response':
      return {
        ...state,
        metrics: withLatency(state, { serverMs: event.ms }),
        timeline: push(state.timeline, {
          at: 0,
          // The planner that answered, not a generic 'server'.
          label: event.modelId,
          detail:
            event.action === null
              ? `no usable action (${String(event.rawLength)} chars)`
              : `${describePlanned(event.action)} in ${event.ms.toFixed(0)} ms`,
          kind: 'info',
        }),
      };

    case 'action/executed': {
      const metrics = withLatency(state, { executeMs: event.ms });
      return {
        ...state,
        session:
          state.session === null ? null : { ...state.session, step: state.session.step + 1 },
        /*
         * `steps` IS NOT INCREMENTED HERE. It is incremented on `step/done`,
         * which every step emits on every path - success, refusal, and a stage
         * that threw. Counting here as well made the panel's Steps stat exactly
         * double reality for any step that executed an action, and half of a
         * doubled number looks like a plausible number, which is why it stood.
         */
        metrics,
        lastAction: event.action,
        receipt: {
          ...state.receipt,
          action: {
            type: event.action.type,
            ref: 'ref' in event.action ? String(event.action.ref) : null,
            // Resolved by the orchestrator against the context it sent, not
            // looked up here: refs are positional ordinals renumbered every
            // step, so this panel has no page to resolve one against.
            name: null,
          },
          /*
           * Reaching `action/executed` means validation PASSED - the step
           * refuses before executing otherwise. The `error` case below marks it
           * `fail` when a refusal was reported, and that event arrives first.
           */
          validation: state.receipt.validation === 'fail' ? 'fail' : 'pass',
          execution: event.withheld === true ? 'withheld' : event.ok ? 'pass' : 'fail',
        },
        // ok:false is a page-level miss - a stale ref, a vanished button. It is
        // recorded as an attempt that missed, never as an absence.
        lastExecution: { ok: event.ok, ms: event.ms },
        timeline: push(state.timeline, {
          at: 0,
          label: 'action',
          detail: `${event.action.type}${'ref' in event.action ? ` ${whereOf(event.action)}` : ''} ${event.ok ? 'ok' : 'failed'}`,
          kind: 'action',
        }),
      };
    }

    case 'origin/status':
      return {
        ...state,
        serverOrigin: { origin: event.origin, granted: event.granted, error: event.error },
      };

    case 'tab/attached':
      return {
        ...state,
        attachedTab: {
          tabId: event.tabId,
          note: event.note,
          origin: event.origin ?? null,
          durable: event.durable === true,
        },
      };

    case 'loop/step':
      return {
        ...state,
        loop: { running: true, step: event.step, maxSteps: event.maxSteps, reason: null },
      };

    case 'loop/stopped':
      return {
        ...state,
        loop: {
          running: false,
          step: event.steps,
          maxSteps: state.loop?.maxSteps ?? event.steps,
          reason: event.reason,
        },
        timeline: push(state.timeline, {
          at: 0,
          label: 'loop',
          detail: `stopped after ${String(event.steps)} step(s): ${event.reason}${event.error === null ? '' : ` - ${event.error}`}`,
          kind: event.reason === 'done' ? 'info' : 'error',
        }),
      };

    case 'notice':
      // Timeline only. Deliberately NOT added to `errors`.
      return {
        ...state,
        timeline: push(state.timeline, {
          at: 0,
          label: event.scope,
          detail: event.message,
          kind: 'info',
        }),
      };

    case 'step/done': {
      /*
       * THE RECEIPT IS SEALED HERE, and only here.
       *
       * A receipt is only truthful once its step has ended: mid-step it says
       * `execution: not-reached` for a step that simply has not executed yet,
       * and reading that as evidence would be reading a half-written page. On
       * every path - success, refusal, or a stage that threw - `step/done` is
       * emitted, so a failed step produces a receipt that records how far it got
       * rather than no receipt at all.
       *
       * The step number comes from the EVENT, not from the accumulator, so a
       * receipt cannot end up filed under a step it did not describe.
       */
      /*
       * SEALED ONLY IF THE ACCUMULATOR IS THIS STEP'S.
       *
       * The accumulator resets on `frame/captured`, and a step can fail BEFORE
       * that - `snapshot` throws, or capture itself does. `step/done` still
       * fires, and stamping `event.step` onto whatever was in the accumulator
       * filed the PREVIOUS step's measurements under the new step's number: a
       * receipt showing redactions, masks and a transmission for a step that
       * never read the page.
       *
       * THE DISCRIMINATOR IS "fresh and started", and both halves are needed:
       *
       *  - `e2eMs === null` means this accumulator has not already been sealed.
       *    Only `step/done` sets it, and only `frame/captured` clears it. Without
       *    this, the previous step's SEALED receipt is re-sealed under the new
       *    number.
       *  - `domCaptured` means a step actually started into this accumulator.
       *    Without this, the very first step - failing before `frame/captured`
       *    with a pristine accumulator - would be treated as owned.
       *
       * Deliberately NOT `state.receipt.step === event.step`, which was the first
       * attempt. The panel derives its own step number by incrementing on
       * `frame/captured`, while `event.step` comes from the background's counter;
       * a panel opened mid-session starts at 0 against an event that says 5, and
       * every step would then be filed as un-owned and emptied.
       */
      const owned = state.receipt.e2eMs === null && state.receipt.perception.domCaptured;
      const sealed: PrivacyReceipt = {
        ...(owned ? state.receipt : emptyReceipt(event.step, state.session?.taskId ?? null)),
        ...(owned ? {} : { deployment: state.deployment }),
        step: event.step,
        e2eMs: event.e2eMs,
      };
      return {
        ...state,
        receipt: sealed,
        receipts: pushReceipt(state.receipts, sealed),
        metrics: {
          ...state.metrics,
          latency: { ...state.metrics.latency, e2eMs: event.e2eMs },
          counts: { ...state.metrics.counts, steps: state.metrics.counts.steps + 1 },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: `step ${String(event.step)}`,
          // "wall clock" said explicitly: the bars above are stage times that
          // overlap, and their sum is not this number.
          detail: `${event.ok ? 'ok' : 'failed'} in ${String(Math.round(event.e2eMs))} ms wall clock`,
          kind: event.ok ? 'info' : 'error',
        }),
      };
    }

    case 'host/status':
      return {
        ...state,
        host: {
          kind: event.kind,
          running: event.running,
          modelLoaded: event.modelLoaded,
          note: event.note,
          model: event.model ?? null,
        },
      };

    case 'resource/sample':
      return { ...state, metrics: { ...state.metrics, resource: event.reading } };

    case 'backend/selected':
      return {
        ...state,
        deployment: event.descriptor,
        /*
         * A SWITCH CLEARS THE FAILURE AND THE PROBE.
         *
         * `backendUnavailable` describes ONE backend; leaving it in place after
         * the user switches would keep offering to switch away from a backend
         * they are no longer using, and would leave a red banner over a working
         * run. `backendHealth` goes for the same reason - it is a measurement of
         * a different endpoint, and stale health shown against a new backend is
         * exactly the kind of confident-and-wrong report this panel avoids
         * everywhere else. Null means "not probed", and the panel renders that
         * as unknown rather than as down.
         */
        backendUnavailable: null,
        backendHealth:
          state.backendHealth?.kind === event.descriptor.kind ? state.backendHealth : null,
        receipt: { ...state.receipt, deployment: event.descriptor },
        timeline: push(state.timeline, {
          at: 0,
          label: 'backend',
          detail:
            `${event.descriptor.kind}` +
            (event.descriptor.endpoint === null ? '' : ` - ${event.descriptor.endpoint}`) +
            (event.descriptor.model === null ? '' : ` (${event.descriptor.model})`) +
            (event.descriptor.authenticated ? ' [authenticated]' : ''),
          kind: 'info',
        }),
      };

    case 'backend/health':
      return {
        ...state,
        backendHealth: event.health,
        timeline: push(state.timeline, {
          at: 0,
          label: 'backend health',
          detail: event.health.reachable
            ? `${event.health.kind}: connected${event.health.plannerId === null ? '' : ` (${event.health.plannerId})`}`
            : `${event.health.kind}: unavailable${event.health.error === null ? '' : ` - ${event.health.error}`}`,
          kind: event.health.reachable ? 'info' : 'error',
        }),
      };

    case 'backend/unavailable':
      return {
        ...state,
        backendUnavailable: event.unavailable,
        /*
         * In `errors` TOO, not only in the banner. The banner is dismissed by
         * acting on it; the error list is the record that it happened, and a
         * failure that leaves no trace once resolved is a failure nobody can
         * account for afterwards.
         */
        errors: [
          ...state.errors,
          `backend: ${event.unavailable.kind} unavailable - ${event.unavailable.error}`,
        ],
        timeline: push(state.timeline, {
          at: 0,
          label: 'backend',
          detail:
            `${event.unavailable.kind} unavailable - NOT falling back; ` +
            `${String(event.unavailable.alternatives.length)} alternative(s) offered`,
          kind: 'error',
        }),
      };

    case 'privacy/verified':
      return {
        ...state,
        receipt: {
          ...state.receipt,
          network: {
            ...state.receipt.network,
            leaks: event.leaks,
            /*
             * All three claims come from ONE gate result, because one gate
             * produced them. `rawDom` is the shape check's unexpected-key
             * refusal plus the content scan's raw-markup rule; `rawPii` is the
             * detector re-run; `rawScreenshot` is the op-counter check that only
             * a baked image can satisfy.
             *
             * `checkedFields` travels into two of them verbatim so the panel can
             * print "0 field(s) checked" when that is what happened - a scanner
             * that examined nothing reports nothing found, and the difference has
             * to be visible.
             */
            rawDom: event.blocked
              ? { state: 'blocked', reason: event.reason ?? 'refused' }
              : { state: 'verified-absent', checkedFields: event.checkedFields },
            rawPii: event.blocked
              ? { state: 'blocked', reason: event.reason ?? 'refused' }
              : { state: 'verified-absent', checkedFields: event.checkedFields },
            rawScreenshot: event.blocked
              ? { state: 'blocked', reason: event.reason ?? 'refused' }
              : { state: 'verified-absent', checkedFields: 1 },
            ...(event.blocked
              ? {
                  sanitizedContext: {
                    state: 'blocked' as const,
                    reason: event.reason ?? 'refused',
                  },
                  redactedScreenshot: {
                    state: 'blocked' as const,
                    reason: event.reason ?? 'refused',
                  },
                }
              : {}),
          },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: 'egress gate',
          detail: event.blocked
            ? `BLOCKED: ${event.reason ?? 'refused'}`
            : `${String(event.checkedFields)} field(s) re-scanned, no unredacted content found`,
          kind: event.blocked ? 'error' : 'redaction',
        }),
      };

    case 'page/verified': {
      /*
       * Applied to the receipt for THAT step, which has usually already been
       * sealed - the loop compares fingerprints after `step/done`. Matching on
       * the step number rather than patching the newest entry means a late or
       * out-of-order event cannot attach a verification to the wrong step.
       */
      const verification = { kind: event.changed ? ('changed' as const) : ('unchanged' as const) };
      /*
       * MATCHED ON (taskId, step), not on step alone.
       *
       * Step numbers restart at 1 for every run, and `receipts` holds several
       * runs. Matching on the number alone patched EVERY receipt numbered 3 -
       * including one from a previous task, with a verification that describes a
       * different page. Only the LAST match is updated, which is the one this
       * event is about.
       */
      const taskId = state.session?.taskId ?? null;
      const matches = (r: PrivacyReceipt): boolean =>
        r.step === event.step && r.taskId === taskId;
      let lastMatch = -1;
      state.receipts.forEach((r, i) => {
        if (matches(r)) lastMatch = i;
      });
      return {
        ...state,
        receipt: matches(state.receipt) ? { ...state.receipt, verification } : state.receipt,
        receipts: state.receipts.map((r, i) => (i === lastMatch ? { ...r, verification } : r)),
        timeline: push(state.timeline, {
          at: 0,
          label: 'page check',
          // "changed", never "verified": a fingerprint proves something moved,
          // not that the right thing moved.
          detail: event.changed
            ? `step ${String(event.step)}: the page changed after the action`
            : `step ${String(event.step)}: the page did NOT change after the action`,
          kind: event.changed ? 'info' : 'warn',
        }),
      };
    }

    case 'error':
      return {
        ...state,
        errors: [...state.errors, `${event.scope}: ${event.message}`],
        lastRefusal: event.scope === 'validate' ? event.message : state.lastRefusal,
        receipt:
          event.scope === 'validate'
            ? { ...state.receipt, validation: 'fail' }
            : state.receipt,
        metrics: {
          ...state.metrics,
          counts: { ...state.metrics.counts, errors: state.metrics.counts.errors + 1 },
        },
        timeline: push(state.timeline, {
          at: 0,
          label: event.scope,
          detail: event.message,
          kind: 'error',
        }),
      };

    case 'session/end':
      return {
        ...state,
        session: state.session === null ? null : { ...state.session, running: false },
        timeline: push(state.timeline, {
          at: event.at,
          label: 'session',
          detail: `ended: ${event.reason}`,
          kind: 'info',
        }),
      };

    default:
      return state;
  }
}

export function reduceAll(
  events: readonly PanelEvent[],
  from: PanelState = initialPanelState,
): PanelState {
  return events.reduce(reducePanel, from);
}
