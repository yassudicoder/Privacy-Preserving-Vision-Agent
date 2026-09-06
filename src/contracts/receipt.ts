import type { BackendDescriptor } from './deployment.ts';
import type { PiiKind } from './detection.ts';

/**
 * What one agent step actually did, as evidence rather than as reassurance.
 *
 * THE RULE THIS TYPE IS BUILT AROUND: nothing here may be a constant.
 *
 * The tempting version of a privacy receipt is a card that prints
 *
 *     RAW PII        NOT SENT
 *     RAW SCREENSHOT NOT SENT
 *
 * with both lines hard-coded, because the architecture says they are true. That
 * card would keep saying it after a regression, and it would be the LAST thing
 * to notice - a UI asserting a property it never measured is worse than no UI,
 * because it converts an open question into a confident answer.
 *
 * So every field below is a tri-state or a count, sourced from an event the
 * pipeline emitted while doing the work. `EgressClaim` in particular has a
 * `not-checked` state, and it is used: a step that failed before the gate ran
 * reports `not-checked`, never `verified-absent`. "We did not look" and "we
 * looked and found nothing" are different, and this project's whole posture is
 * that they must not render the same.
 */

/**
 * The status of one class of data at the network boundary.
 *
 *  - `verified-absent` - a check RAN over the outbound payload and found none.
 *    `checkedFields` says how much was actually examined, because a scanner that
 *    covered zero fields would also report zero findings.
 *  - `sent` - it went, deliberately, and `bytes` says how much. Used for the
 *    sanitized context and for a redacted screenshot: those are supposed to
 *    leave, and pretending otherwise would be the same dishonesty in reverse.
 *  - `blocked` - a gate refused. The step degraded or failed; the reason is the
 *    gate's own message.
 *  - `not-checked` - the step did not reach the gate. NOT a synonym for safe.
 */
export type EgressClaim =
  | { readonly state: 'verified-absent'; readonly checkedFields: number }
  | { readonly state: 'sent'; readonly bytes: number }
  /**
   * Prepared, then planned WITHOUT crossing a network boundary.
   *
   * Its own state rather than `verified-absent`, because those two are answers
   * to different questions and collapsing them would be the receipt's worst
   * possible lie in either direction. `verified-absent` means a check ran over
   * an outbound payload; this means there was no outbound payload. On the
   * `on-device` backend the sanitized context is built in full and handed to a
   * planner in this same process - so "not sent" is true and "we checked the
   * wire and found nothing" would be a claim about a wire that was never used.
   */
  | { readonly state: 'stayed-on-device'; readonly bytes: number }
  | { readonly state: 'blocked'; readonly reason: string }
  | { readonly state: 'not-checked' };

/** Where a leak was found. Kind and field path only - never the value. */
export interface ReceiptLeak {
  readonly kind: PiiKind;
  readonly field: string;
}

/** What the local pipeline saw and did, before anything left. */
export interface ReceiptPerception {
  /** The content script returned a DOM snapshot. */
  readonly domCaptured: boolean;
  /** `captureVisibleTab` returned a frame. Raw, and it never leaves the device. */
  readonly screenshotCaptured: boolean;
  readonly frameBytes: number;
}

export interface ReceiptPrivacy {
  /** Boxes the local vision model returned. Zero is a real answer, not absence. */
  readonly visionDetections: number;
  /** Detections after merging vision boxes with the DOM scan. */
  readonly piiRegions: number;
  readonly redactionsApplied: number;
  readonly redactionsDetected: number;
  /** Placeholder-shaped strings a hostile page planted. Always an attack. */
  readonly forgeriesStripped: number;
  readonly residualRisk: 'none' | 'low' | 'unknown' | null;
  readonly pixelOpsRequested: number;
  readonly pixelOpsApplied: number;
  /**
   * Ops that fell outside the captured viewport.
   *
   * Carried because `applied: 0` is ambiguous without it: PII below the fold is
   * redacted in the text and was never in the picture, which is safe, and it
   * looks identical to ops that overlapped the frame and failed to land, which
   * is a leak.
   */
  readonly pixelOpsOutsideFrame: number;
}

/** What crossed - and did not cross - the network boundary. */
export interface ReceiptNetwork {
  /**
   * Raw page HTML.
   *
   * Structurally impossible rather than merely unobserved: `PlanRequest` carries
   * a `SanitizedContext` and nothing else, and `contracts/egress.ts` refuses any
   * key the sanitizer does not emit. Still reported as a CHECK result, because
   * `unexpected-field` firing is exactly how that structural claim would be
   * found to have stopped being true.
   */
  readonly rawDom: EgressClaim;
  /** Result of re-running the PII detectors over the outbound text. */
  readonly rawPii: EgressClaim;
  /** Whether an unbaked frame reached the payload. Checked by its op counters. */
  readonly rawScreenshot: EgressClaim;
  readonly sanitizedContext: EgressClaim;
  readonly redactedScreenshot: EgressClaim;
  readonly leaks: readonly ReceiptLeak[];
}

/** The action, and whether each local check passed. */
export type CheckOutcome = 'pass' | 'fail' | 'withheld' | 'not-reached';

export interface ReceiptAction {
  readonly type: string;
  readonly ref: string | null;
  /** Accessible name at execution time. Already redacted; page-derived. */
  readonly name: string | null;
}

/**
 * Post-action verification.
 *
 * `done` from the model is a CLAIM. This is what the client observed. A
 * fingerprint of the live DOM is a weak check - it says something changed, not
 * that the right thing changed - and it is labelled as exactly that rather than
 * as "VERIFIED", because overstating it would be the same failure as a
 * hard-coded NOT SENT.
 */
export type PageVerification =
  | { readonly kind: 'changed' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'not-checked' };

export interface PrivacyReceipt {
  readonly step: number;
  readonly taskId: string | null;
  readonly perception: ReceiptPerception;
  readonly privacy: ReceiptPrivacy;
  readonly network: ReceiptNetwork;
  /** Which deployment this step was planned on. Null before one is selected. */
  readonly deployment: BackendDescriptor | null;
  /**
   * What ACTUALLY answered, from `PlanResponse.modelId`.
   *
   * Deliberately separate from `deployment.model`, which is what the operator
   * typed into settings. When the two disagree, this one is the measurement and
   * the panel shows both - a settings field silently overriding a measurement is
   * how a demo ends up describing a model that never ran.
   */
  readonly modelAnswered: string | null;
  readonly action: ReceiptAction | null;
  readonly validation: CheckOutcome;
  readonly execution: CheckOutcome;
  readonly verification: PageVerification;
  readonly e2eMs: number | null;
}

const NOT_CHECKED: EgressClaim = { state: 'not-checked' };

/**
 * A receipt with nothing asserted yet.
 *
 * Every claim starts at `not-checked` and every count at zero, so a step that
 * dies at `snapshot` produces a receipt that says so instead of one that
 * inherits a previous step's numbers.
 */
export function emptyReceipt(step: number, taskId: string | null = null): PrivacyReceipt {
  return {
    step,
    taskId,
    perception: { domCaptured: false, screenshotCaptured: false, frameBytes: 0 },
    privacy: {
      visionDetections: 0,
      piiRegions: 0,
      redactionsApplied: 0,
      redactionsDetected: 0,
      forgeriesStripped: 0,
      residualRisk: null,
      pixelOpsRequested: 0,
      pixelOpsApplied: 0,
      pixelOpsOutsideFrame: 0,
    },
    network: {
      rawDom: NOT_CHECKED,
      rawPii: NOT_CHECKED,
      rawScreenshot: NOT_CHECKED,
      sanitizedContext: NOT_CHECKED,
      redactedScreenshot: NOT_CHECKED,
      leaks: [],
    },
    deployment: null,
    modelAnswered: null,
    action: null,
    validation: 'not-reached',
    execution: 'not-reached',
    verification: { kind: 'not-checked' },
    e2eMs: null,
  };
}

/** One line per claim, for a text rendering of the receipt. */
export function describeClaim(claim: EgressClaim): string {
  switch (claim.state) {
    case 'verified-absent':
      return `NOT SENT (${String(claim.checkedFields)} field(s) checked)`;
    case 'sent':
      return `SENT (${String(claim.bytes)} bytes)`;
    case 'stayed-on-device':
      return `NOT SENT - planned on this device (${String(claim.bytes)} bytes prepared)`;
    case 'blocked':
      return `BLOCKED - ${claim.reason}`;
    case 'not-checked':
      // Never "not sent". The step did not get far enough to know.
      return 'NOT CHECKED - the step did not reach the gate';
  }
}
