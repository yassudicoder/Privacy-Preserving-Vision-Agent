import {
  type DetectionSource,
  type EgressClaim,
  type PiiKind,
  type PrivacyReceipt,
  type RedactionStrategy,
  backendLabel,
  describeClaim,
} from '@/contracts/index.ts';
import type { PanelState } from './state.ts';

/** Derived views. Pure, so the numbers the panel shows are the numbers tests check. */

export interface KindRow {
  readonly kind: PiiKind;
  readonly count: number;
  readonly strategies: readonly RedactionStrategy[];
}

export function groupRedactionsByKind(state: PanelState): KindRow[] {
  const byKind = new Map<PiiKind, { count: number; strategies: Set<RedactionStrategy> }>();
  for (const entry of state.redactions) {
    const row = byKind.get(entry.kind) ?? { count: 0, strategies: new Set<RedactionStrategy>() };
    row.count += 1;
    row.strategies.add(entry.strategy);
    byKind.set(entry.kind, row);
  }
  return [...byKind.entries()]
    .map(([kind, row]) => ({ kind, count: row.count, strategies: [...row.strategies] }))
    .sort((a, b) => b.count - a.count);
}

export function groupRedactionsBySource(state: PanelState): { source: DetectionSource; count: number }[] {
  const bySource = new Map<DetectionSource, number>();
  for (const entry of state.redactions) {
    bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
  }
  return [...bySource.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

/** The single number a judge is most likely to ask about. */
export function endToEndMs(state: PanelState): number {
  return state.metrics.latency.e2eMs;
}

export interface LatencyBar {
  readonly label: string;
  readonly ms: number;
  readonly fraction: number;
}

/** Latency breakdown as proportions, for the panel's stacked bar. */
export function latencyBars(state: PanelState): LatencyBar[] {
  const l = state.metrics.latency;
  const parts: readonly (readonly [string, number])[] = [
    ['capture', l.captureMs],
    ['vision', l.visionMs],
    ['redact', l.redactMs],
    ['bake', l.bakeMs],
    ['serialize', l.serializeMs],
    ['server', l.serverMs],
    ['execute', l.executeMs],
  ];
  const total = parts.reduce((acc, [, ms]) => acc + ms, 0);
  return parts.map(([label, ms]) => ({
    label,
    ms,
    fraction: total === 0 ? 0 : ms / total,
  }));
}

/**
 * Whether the panel should warn. Surfacing "we found PII but did not redact it"
 * matters more than any other number on the screen.
 */
export function privacyWarnings(state: PanelState): string[] {
  const warnings: string[] = [];
  const unapplied = state.redactions.filter((r) => !r.applied);
  if (unapplied.length > 0) {
    warnings.push(`${String(unapplied.length)} detection(s) were not redacted`);
  }
  if (state.metrics.counts.forgeriesStripped > 0) {
    warnings.push(
      `${String(state.metrics.counts.forgeriesStripped)} forged redaction token(s) removed from page content`,
    );
  }
  if (state.lastRefusal !== null) {
    warnings.push(`last action refused: ${state.lastRefusal}`);
  }
  /*
   * A BLOCKED EGRESS IS THE LOUDEST THING THIS PANEL CAN SAY.
   *
   * Everything else in this list is "we did less than we might have". This one
   * is "the pipeline produced a payload that would have leaked, and we stopped
   * it" - which is simultaneously the system working and a defect upstream. It
   * has to be visible without scrolling to a receipt.
   *
   * The KINDS are named and the values are not. The findings carry a field path
   * and a PII kind by construction; there is nothing here that could print the
   * leaked string even if this line wanted to.
   */
  const leaks = state.receipt.network.leaks;
  if (leaks.length > 0) {
    const kinds = [...new Set(leaks.map((l) => l.kind))].join(', ');
    warnings.push(
      `outbound context BLOCKED: ${String(leaks.length)} unredacted value(s) (${kinds}) found by the egress check`,
    );
  }
  if (state.backendUnavailable !== null) {
    warnings.push(
      `${backendLabel(state.backendUnavailable.kind)} is unavailable - nothing was sent anywhere, ` +
        'and no other backend was tried',
    );
  }
  return warnings;
}

/** One line per network claim, for the receipt view. Order is deliberate. */
export interface ReceiptLine {
  readonly label: string;
  readonly value: string;
  /**
   * `bad` is reserved for a gate that BLOCKED. A "SENT" line is not a warning -
   * the sanitized context is supposed to be sent, and colouring it as a hazard
   * would teach a reader to ignore the colour.
   */
  readonly tone: 'ok' | 'sent' | 'bad' | 'idle';
}

function toneOf(claim: EgressClaim): ReceiptLine['tone'] {
  switch (claim.state) {
    case 'verified-absent':
    case 'stayed-on-device':
      return 'ok';
    case 'sent':
      return 'sent';
    case 'blocked':
      return 'bad';
    case 'not-checked':
      return 'idle';
  }
}

/**
 * The receipt's NETWORK section, as displayable lines.
 *
 * Every value comes from `describeClaim`, which renders the four states
 * distinctly - including `NOT CHECKED`, which is what a step that failed before
 * the gate produces. The temptation this exists to resist is printing
 * `RAW PII  NOT SENT` unconditionally: it would be true today, it would stay on
 * screen after a regression, and it would be the last thing anyone doubted.
 */
export function receiptNetworkLines(receipt: PrivacyReceipt): ReceiptLine[] {
  const net = receipt.network;
  return [
    { label: 'Raw DOM', value: describeClaim(net.rawDom), tone: toneOf(net.rawDom) },
    { label: 'Raw PII', value: describeClaim(net.rawPii), tone: toneOf(net.rawPii) },
    {
      label: 'Raw screenshot',
      value: describeClaim(net.rawScreenshot),
      tone: toneOf(net.rawScreenshot),
    },
    {
      label: 'Sanitized context',
      value: describeClaim(net.sanitizedContext),
      tone: toneOf(net.sanitizedContext),
    },
    {
      label: 'Redacted screenshot',
      value: describeClaim(net.redactedScreenshot),
      tone: toneOf(net.redactedScreenshot),
    },
  ];
}

/**
 * The receipt as plain text, for copying into a report or an issue.
 *
 * Deliberately derived from the same `PrivacyReceipt` the panel renders, so the
 * pasted version cannot say something different from the screen. It contains
 * counts, field paths, kinds and a backend name - never a page value, never an
 * endpoint credential, never a token.
 */
export function formatReceipt(receipt: PrivacyReceipt): string {
  const lines: string[] = [];
  const pad = (label: string, value: string): string => `${label.padEnd(22)}${value}`;

  lines.push(`STEP ${String(receipt.step).padStart(2, '0')}`);
  lines.push('');
  lines.push('PERCEPTION');
  lines.push(pad('DOM captured', receipt.perception.domCaptured ? 'yes' : 'no'));
  lines.push(
    pad(
      'Screenshot captured',
      receipt.perception.screenshotCaptured
        ? `yes (${String(receipt.perception.frameBytes)} bytes, kept on this device)`
        : 'no',
    ),
  );
  lines.push('');
  lines.push('LOCAL PRIVACY');
  lines.push(pad('Vision detections', String(receipt.privacy.visionDetections)));
  lines.push(pad('PII regions', String(receipt.privacy.piiRegions)));
  lines.push(
    pad(
      'Redactions',
      `${String(receipt.privacy.redactionsApplied)}/${String(receipt.privacy.redactionsDetected)} applied`,
    ),
  );
  lines.push(
    pad(
      'Pixel masks',
      `${String(receipt.privacy.pixelOpsApplied)}/${String(receipt.privacy.pixelOpsRequested)} applied` +
        (receipt.privacy.pixelOpsOutsideFrame > 0
          ? `, ${String(receipt.privacy.pixelOpsOutsideFrame)} off-screen`
          : ''),
    ),
  );
  if (receipt.privacy.forgeriesStripped > 0) {
    // Always an attack, never a coincidence. Stated as such.
    lines.push(
      pad('Forged tokens', `${String(receipt.privacy.forgeriesStripped)} stripped from page text`),
    );
  }
  lines.push('');
  lines.push('NETWORK');
  for (const line of receiptNetworkLines(receipt)) lines.push(pad(line.label, line.value));
  if (receipt.network.leaks.length > 0) {
    // Kind and field. Never the value - see `LeakFinding`.
    for (const leak of receipt.network.leaks) {
      lines.push(pad('  leak', `${leak.kind} in ${leak.field}`));
    }
  }
  lines.push('');
  lines.push('DEPLOYMENT');
  lines.push(
    pad('Backend', receipt.deployment === null ? 'not reported' : backendLabel(receipt.deployment.kind)),
  );
  lines.push(pad('Endpoint', receipt.deployment?.endpoint ?? 'none - planned on this device'));
  lines.push(
    pad(
      'Transport',
      receipt.deployment === null
        ? 'not reported'
        : !receipt.deployment.offDevice
          ? 'never left this device'
          : receipt.deployment.encrypted
            ? 'https'
            : 'http (loopback)',
    ),
  );
  lines.push(pad('Authenticated', receipt.deployment?.authenticated === true ? 'yes' : 'no'));
  lines.push('');
  lines.push('MODEL');
  /*
   * What ANSWERED, then what was configured. Two facts, in that order, because
   * the measurement is the one that is true and the setting is the one that can
   * be wrong. Printing only the setting is how a report describes a model that
   * never ran.
   */
  lines.push(pad('Answered', receipt.modelAnswered ?? 'no plan returned'));
  lines.push(pad('Configured', receipt.deployment?.model ?? 'not set'));
  lines.push('');
  lines.push('ACTION');
  lines.push(
    pad(
      'Planned',
      receipt.action === null
        ? 'none'
        : `${receipt.action.type}${receipt.action.ref === null ? '' : ` ${receipt.action.ref}`}`,
    ),
  );
  lines.push(pad('Validation', receipt.validation.toUpperCase()));
  lines.push(pad('Execution', receipt.execution.toUpperCase()));
  lines.push(
    pad(
      'Page check',
      receipt.verification.kind === 'not-checked'
        ? 'NOT CHECKED'
        : receipt.verification.kind === 'changed'
          ? 'page changed after the action'
          : 'page did NOT change after the action',
    ),
  );
  if (receipt.e2eMs !== null) {
    lines.push('');
    lines.push(pad('Wall clock', `${String(Math.round(receipt.e2eMs))} ms`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The shield strip
// ---------------------------------------------------------------------------

/** One pipeline stage's state, for the four dots. */
export type ShieldTone = 'idle' | 'running' | 'ok' | 'warn' | 'bad';

export interface ShieldStage {
  readonly key: 'capture' | 'redact' | 'mask' | 'send';
  readonly label: string;
  readonly tone: ShieldTone;
  /** Read by a screen reader. Colour alone conveys nothing to one. */
  readonly detail: string;
}

export interface ShieldSummary {
  readonly stages: readonly ShieldStage[];
  /** One line, always a MEASUREMENT or an explicit statement that none exists. */
  readonly sentence: string;
  readonly tone: ShieldTone;
  /** Where the last context went, or null before one went anywhere. */
  readonly tag: string | null;
}

/**
 * The always-visible privacy line, as a pure function of measured state.
 *
 * WHY THIS IS A SELECTOR AND NOT MARKUP. The card it replaces was styled with a
 * constant green border, a constant green gradient and a constant shadow, so it
 * read "safe" before a single step had run - and it kept reading safe after a
 * step failed, because no error path writes to `privacyGate` and every null
 * branch says "Waiting...". A panel that is green at rest is green after a
 * regression, which is the one thing this project's proof surface must never be.
 *
 * Written as a selector so the rule that governs the privacy receipt -
 * "no line may be a constant" - is testable here the same way.
 *
 * THE RULES IT ENFORCES:
 *  - Grey is not green. Nothing has run means four idle dots and a sentence
 *    that says so, never an absence dressed as a pass.
 *  - No adjective without a number. "Protected" is a claim; "5/5 redacted" is a
 *    measurement.
 *  - A partial is amber. `applied < detected` is not a success.
 *  - "sent" appears only when a transmission actually happened, and it always
 *    carries where it went - the same words mean different things on-device and
 *    on a cloud.
 */
export function shieldSummary(state: PanelState): ShieldSummary {
  const g = state.privacyGate;

  const capture: ShieldStage =
    g.capture === null
      ? { key: 'capture', label: 'Capture', tone: 'idle', detail: 'no screen captured yet' }
      : {
          key: 'capture',
          label: 'Capture',
          tone: 'ok',
          detail: `${String(g.capture.bytes)} bytes captured on this device`,
        };

  /*
   * `applied < detected` is AMBER, never green. The redactor found something it
   * could not remove, and the difference is exactly the thing a person needs to
   * see. `residualRisk` is carried into the detail because the log computes it
   * and nothing rendered it.
   */
  const redact: ShieldStage =
    g.redaction === null
      ? { key: 'redact', label: 'Redact', tone: 'idle', detail: 'no PII scan has run' }
      : {
          key: 'redact',
          label: 'Redact',
          tone: g.redaction.applied >= g.redaction.detected ? 'ok' : 'warn',
          detail:
            `${String(g.redaction.applied)} of ${String(g.redaction.detected)} detections redacted` +
            ` (residual risk ${g.redaction.residualRisk})`,
        };

  /*
   * Ops that fell OUTSIDE the captured frame are not a failure: a screenshot
   * shows the viewport while the DOM scan reads the whole document, so PII below
   * the fold is redacted in the text and was never in the picture. Only a
   * deficit among ops that overlapped the frame is amber.
   */
  const mask: ShieldStage = ((): ShieldStage => {
    if (g.bake === null) {
      return { key: 'mask', label: 'Mask', tone: 'idle', detail: 'no image was baked' };
    }
    const couldLand = g.bake.requested - g.bake.outsideFrame;
    const short = couldLand - g.bake.applied;
    return {
      key: 'mask',
      label: 'Mask',
      tone: short > 0 ? 'bad' : 'ok',
      detail:
        `${String(g.bake.applied)} of ${String(g.bake.requested)} pixel masks applied` +
        (g.bake.outsideFrame > 0 ? `, ${String(g.bake.outsideFrame)} off-screen` : '') +
        (short > 0 ? ` - ${String(short)} overlapped the frame and did NOT land` : ''),
    };
  })();

  /*
   * PREPARED IS NOT SENT. A context can be built and then refused at the egress
   * gate; rendering that as a completed send would be the panel asserting the
   * one thing it must never assert.
   */
  const send: ShieldStage =
    g.transmitted !== null
      ? {
          key: 'send',
          label: 'Send',
          tone: 'ok',
          detail:
            g.transmitted.channel === 'cloud'
              ? `Sanitized context delivered to ${g.transmitted.modelId}`
              : `planned on this device (${g.transmitted.modelId}) - nothing was sent`,
        }
      : g.prepared !== null
        ? {
            key: 'send',
            label: 'Send',
            tone: 'running',
            detail: `${String(g.prepared.bytes)} bytes prepared, not yet accepted by a planner`,
          }
        : { key: 'send', label: 'Send', tone: 'idle', detail: 'nothing has been sent' };

  const stages = [capture, redact, mask, send] as const;

  const worst: ShieldTone = stages.some((s) => s.tone === 'bad')
    ? 'bad'
    : stages.some((s) => s.tone === 'warn')
      ? 'warn'
      : stages.some((s) => s.tone === 'running')
        ? 'running'
        : stages.every((s) => s.tone === 'idle')
          ? 'idle'
          : 'ok';

  const tag =
    g.transmitted === null
      ? null
      : g.transmitted.channel === 'cloud'
        ? `Cloud · ${g.transmitted.modelId}`
        : 'On-device';

  // The sentence. Every branch is a measurement or an explicit "not checked".
  let sentence: string;
  if (g.capture === null && g.redaction === null) {
    sentence = 'Nothing captured yet - no check has run';
  } else if (g.redaction === null) {
    sentence = 'Captured on this device - PII scan has not run';
  } else {
    const parts = [`${String(g.redaction.applied)}/${String(g.redaction.detected)} redacted`];
    if (g.bake !== null) {
      const off = g.bake.outsideFrame > 0 ? `, ${String(g.bake.outsideFrame)} off-screen` : '';
      parts.push(`${String(g.bake.applied)}/${String(g.bake.requested)} masks${off}`);
    }
    parts.push(
      g.transmitted === null
        ? g.prepared === null
          ? 'nothing sent'
          : 'prepared, not sent'
        : g.transmitted.channel === 'cloud'
          ? 'sanitized context sent'
          : 'stayed on this device',
    );
    sentence = parts.join(' · ');
  }

  return { stages, sentence, tone: worst, tag };
}
