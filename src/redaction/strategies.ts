import {
  type Detection,
  type PiiKind,
  type PixelRedactionOp,
  type RedactionEntry,
  type RedactionNonce,
  type RedactionStrategy,
  type ViewportInfo,
  cssViewportToDevice,
  DEFAULT_STRATEGY,
  isVisualOnly,
  makePlaceholder,
} from '@/contracts/index.ts';
import { charClassOf } from './patterns.ts';
import { type DomIndex, readControlValue, resolveDomPath, writeControlValue } from './dom-scan.ts';

/**
 * Turning a detection into an edit.
 *
 * The kind says what we WANT to do. Where the detection actually sits says what
 * we CAN do. `resolveStrategy` reconciles the two - asking to remove a node when
 * the PII is a substring of a text node is not a meaningful instruction.
 */

export interface StrategyContext {
  readonly doc: Document;
  readonly nonce: RedactionNonce;
  readonly viewport: ViewportInfo;
  readonly strategyFor?: (kind: PiiKind) => RedactionStrategy;
  /** Extra padding on pixel redactions. Model boxes are rarely tight. */
  readonly padPx?: number;
  /**
   * A sibling index for resolving `det.domPath`, valid only while the caller
   * makes no STRUCTURAL change to `doc`.
   *
   * Present for the span-rewrite phase, which only assigns `Text.data` and
   * attributes; absent for the removals phase, whose whole job is to move
   * elements and which must therefore resolve against the live document. A
   * `remove-node` reached through an index built before the removals would
   * resolve a stale ordinal - the wrong element, deleted, silently.
   */
  readonly index?: DomIndex;
}

export function resolveStrategy(det: Detection, intent: RedactionStrategy): RedactionStrategy {
  // Pixel strategies only make sense with a rect and no text to rewrite.
  if (intent === 'blur' || intent === 'blackout' || intent === 'pixelate') {
    return det.rect !== null ? intent : 'placeholder';
  }

  // A substring inside a text node or an attribute can only be substituted.
  if (det.textSpan !== null) {
    return intent === 'mask-chars' ? 'mask-chars' : 'placeholder';
  }

  // A whole-value detection on a form control: strip the value, keep the control.
  if (det.attr === 'value') {
    return intent === 'placeholder' ? 'placeholder' : 'drop-attribute';
  }

  if (det.attr !== null) return 'placeholder';
  if (intent === 'remove-node') return 'remove-node';

  // Visual-only kinds with no DOM anchor have to be handled in pixels.
  if (isVisualOnly(det.kind) && det.rect !== null) return 'blackout';

  return 'placeholder';
}

function shapeOf(value: string): RedactionEntry['preservedShape'] {
  return { length: value.length, charClass: charClassOf(value) };
}


export interface ApplyOutcome {
  readonly entry: RedactionEntry;
  readonly pixelOp: PixelRedactionOp | null;
}

function entry(
  det: Detection,
  strategy: RedactionStrategy,
  applied: boolean,
  reason: string,
  extras: {
    placeholder?: string | null;
    preservedShape?: RedactionEntry['preservedShape'];
  } = {},
): RedactionEntry {
  return {
    detectionId: det.id,
    kind: det.kind,
    source: det.source,
    strategy,
    applied,
    target: { domPath: det.domPath, rect: det.rect, attr: det.attr },
    placeholder: extras.placeholder ?? null,
    preservedShape: extras.preservedShape ?? null,
    confidence: det.confidence,
    reason,
  };
}

/**
 * Apply one detection.
 *
 * Text-span edits are NOT applied here - spans shift as soon as one is replaced,
 * so `redact()` batches them per text node and applies right-to-left. This
 * function handles everything that is positionally independent.
 */
export function applyStrategy(
  det: Detection,
  ctx: StrategyContext,
  ordinal: number,
): ApplyOutcome {
  const intent = (ctx.strategyFor ?? ((k: PiiKind) => DEFAULT_STRATEGY[k]))(det.kind);
  const strategy = resolveStrategy(det, intent);
  const placeholder = makePlaceholder(det.kind, ordinal, ctx.nonce);

  // --- pixel strategies: queued, not applied here -------------------------
  if (strategy === 'blackout' || strategy === 'blur' || strategy === 'pixelate') {
    if (det.rect === null) {
      return { entry: entry(det, strategy, false, 'no rect available for a pixel redaction'), pixelOp: null };
    }
    const pad = ctx.padPx ?? 4;
    const padded = {
      space: 'css-viewport' as const,
      x: det.rect.x - pad,
      y: det.rect.y - pad,
      width: det.rect.width + pad * 2,
      height: det.rect.height + pad * 2,
    };
    return {
      entry: entry(det, strategy, true, 'queued as a pixel redaction'),
      pixelOp: {
        detectionId: det.id,
        kind: det.kind,
        strategy,
        rect: cssViewportToDevice(padded, ctx.viewport),
        intensity: strategy === 'blur' ? 8 : strategy === 'pixelate' ? 12 : 1,
      },
    };
  }

  if (det.domPath === null) {
    return { entry: entry(det, strategy, false, 'detection has no DOM anchor'), pixelOp: null };
  }

  const el = resolveDomPath(ctx.doc, det.domPath, ctx.index);
  if (el === null) {
    return { entry: entry(det, strategy, false, 'DOM path no longer resolves'), pixelOp: null };
  }

  // --- text-span edits are deferred to redact() ---------------------------
  if (det.textSpan !== null) {
    return { entry: entry(det, strategy, false, 'deferred to batched span rewrite'), pixelOp: null };
  }

  switch (strategy) {
    case 'drop-attribute': {
      const attr = det.attr ?? 'value';
      if (attr === 'value') {
        const had = readControlValue(el) ?? '';
        writeControlValue(el, '');
        return {
          entry: entry(det, strategy, true, `cleared the value of <${el.tagName.toLowerCase()}>`, {
            preservedShape: shapeOf(had),
          }),
          pixelOp: null,
        };
      }
      const had = el.getAttribute(attr) ?? '';
      el.setAttribute(attr, '');
      return {
        entry: entry(det, strategy, true, `stripped @${attr}`, { preservedShape: shapeOf(had) }),
        pixelOp: null,
      };
    }

    case 'remove-node': {
      el.remove();
      return { entry: entry(det, strategy, true, 'node removed'), pixelOp: null };
    }

    case 'mask-chars': {
      const attr = det.attr ?? 'value';
      if (attr === 'value') {
        const had = readControlValue(el) ?? '';
        writeControlValue(el, '*'.repeat(had.length));
        return {
          entry: entry(det, strategy, true, 'masked the control value', {
            preservedShape: shapeOf(had),
          }),
          pixelOp: null,
        };
      }
      const had = el.getAttribute(attr) ?? '';
      el.setAttribute(attr, '*'.repeat(had.length));
      return {
        entry: entry(det, strategy, true, `masked @${attr}`, { preservedShape: shapeOf(had) }),
        pixelOp: null,
      };
    }

    case 'placeholder': {
      const attr = det.attr;
      if (attr === null) {
        const had = el.textContent ?? '';
        el.textContent = placeholder;
        return {
          entry: entry(det, strategy, true, 'element text replaced', {
            placeholder,
            preservedShape: shapeOf(had),
          }),
          pixelOp: null,
        };
      }
      if (attr === 'value') {
        const had = readControlValue(el) ?? '';
        writeControlValue(el, placeholder);
        return {
          entry: entry(det, strategy, true, 'control value replaced', {
            placeholder,
            preservedShape: shapeOf(had),
          }),
          pixelOp: null,
        };
      }
      const had = el.getAttribute(attr) ?? '';
      el.setAttribute(attr, placeholder);
      return {
        entry: entry(det, strategy, true, `@${attr} replaced`, {
          placeholder,
          preservedShape: shapeOf(had),
        }),
        pixelOp: null,
      };
    }

    default:
      return { entry: entry(det, strategy, false, `strategy ${strategy} not applicable here`), pixelOp: null };
  }
}

/** Replace `[start,end)` in `text` with `replacement`. */
export function spliceSpan(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return text.slice(0, start) + replacement + text.slice(end);
}
