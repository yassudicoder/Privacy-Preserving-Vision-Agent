import {
  cssViewportToDevice,
  type Detection,
  type DetectionSource,
  type PiiKind,
  type PixelRedactionOp,
  type RectProvider,
  type RedactedHtml,
  type RedactionEntry,
  type RedactionLog,
  type RedactionNonce,
  type RedactionStrategy,
  type RedactionSummary,
  type Untrusted,
  type ViewportInfo,
  type VisionDetection,
  redactionNonce,
  TEST_SALT,
  unsafeUnwrap,
} from '@/contracts/index.ts';
import { attributeRectProvider, createDomIndex, resolveDomPath, scanDom } from './dom-scan.ts';
import { mergeDetections } from './merge.ts';
import { applyStrategy, spliceSpan } from './strategies.ts';

/**
 * redact(html, visionBoxes) -> { html, log }
 *
 * The load-bearing pure function. Runs identically in the content script and in
 * jsdom under vitest, which is the whole point: redaction correctness is
 * verifiable without a browser.
 */

export interface RedactOptions {
  readonly strategyFor?: (kind: PiiKind) => RedactionStrategy;
  /** Detections below this are logged as skipped, not applied. */
  readonly minConfidence?: number;
  readonly viewport?: ViewportInfo;
  readonly padPx?: number;
  readonly rectOf?: RectProvider;
  readonly nonce?: RedactionNonce;
  readonly salt?: string;
  readonly frameId?: string;
  readonly url?: string;
  /** Injected so logs are deterministic under test. */
  readonly now?: number;
  /**
   * Also black out, IN PIXELS, everything that was redacted in the DOM.
   *
   * Off by default because it costs a pixel op per detection and the ops are
   * only ever baked into a screenshot - if no image is being sent they are
   * wasted work.
   *
   * On when one IS being sent, and then it is not optional. A placeholder in the
   * HTML does not repaint pixels that were captured before it existed: the text
   * leaving the machine says `[[PII:EMAIL:1:...]]` while the picture beside it
   * still reads `yash@example.com`. Measured on the profile-pii fixture - 7
   * detections, all 7 with geometry, all 7 handled in the DOM, and only 2
   * producing a pixel op. Five values redacted in text and visible in the image.
   *
   * The screenshot must be redacted to at least the standard the text is.
   */
  readonly pixelCoverAll?: boolean;
}

export interface RedactResult {
  readonly html: RedactedHtml;
  readonly log: RedactionLog;
  readonly detections: readonly Detection[];
  /** Pixel edits the frame still needs. `redact` only has HTML; it cannot apply these. */
  readonly pixelOps: readonly PixelRedactionOp[];
  /** The mutated document, so sanitize() does not have to re-parse. */
  readonly doc: Document;
}

export const DEFAULT_VIEWPORT: ViewportInfo = {
  cssWidth: 1280,
  cssHeight: 800,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
};

/** Strip query and fragment - both routinely carry tokens and identifiers. */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?')[0]?.split('#')[0] ?? '';
  }
}

function spanKey(det: Detection): string {
  return `${String(det.domPath)}|${det.attr ?? 'text'}|${det.nodeIndex ?? -1}`;
}

function buildSummary(
  entries: readonly RedactionEntry[],
  pixelOps: readonly PixelRedactionOp[],
  forgeriesStripped: number,
): RedactionSummary {
  const byKind: Partial<Record<PiiKind, number>> = {};
  const bySource: Partial<Record<DetectionSource, number>> = {};
  let nodesRemoved = 0;
  let attributesDropped = 0;
  let placeholdersInserted = 0;

  for (const e of entries) {
    if (!e.applied) continue;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    if (e.strategy === 'remove-node') nodesRemoved++;
    if (e.strategy === 'drop-attribute') attributesDropped++;
    if (e.placeholder !== null) placeholdersInserted++;
  }

  return {
    byKind,
    bySource,
    nodesRemoved,
    attributesDropped,
    placeholdersInserted,
    pixelOpsQueued: pixelOps.length,
    forgeriesStripped,
  };
}

export function redact(
  html: Untrusted<string>,
  visionBoxes: readonly VisionDetection[],
  opts: RedactOptions = {},
): RedactResult {
  const minConfidence = opts.minConfidence ?? 0.5;
  const rectOf = opts.rectOf ?? attributeRectProvider;
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const nonce = opts.nonce ?? redactionNonce('00000000');
  const salt = opts.salt ?? TEST_SALT;

  const source = unsafeUnwrap(html, 'dom-parse');
  const doc = new DOMParser().parseFromString(source, 'text/html');

  // scanDom strips placeholder forgeries first, so every text offset below is
  // relative to already-cleaned text.
  const scan = scanDom(doc, { rectOf, salt });
  const merged = mergeDetections(scan.detections, visionBoxes, { doc, rectOf });

  const applicable = merged.filter((d) => d.confidence >= minConfidence);
  const skipped = merged.filter((d) => d.confidence < minConfidence);

  const ctx = {
    doc,
    nonce,
    viewport,
    ...(opts.strategyFor !== undefined ? { strategyFor: opts.strategyFor } : {}),
    ...(opts.padPx !== undefined ? { padPx: opts.padPx } : {}),
  };

  const entries: RedactionEntry[] = [];
  const pixelOps: PixelRedactionOp[] = [];
  const ordinals: Partial<Record<PiiKind, number>> = {};
  const nextOrdinal = (kind: PiiKind): number => {
    const n = (ordinals[kind] ?? 0) + 1;
    ordinals[kind] = n;
    return n;
  };

  // Order matters. Span rewrites shift offsets, and node removal invalidates
  // every nth-of-type path after it, so removals go last.
  const spanEdits = applicable.filter((d) => d.textSpan !== null && d.domPath !== null);
  const positional = applicable.filter((d) => d.textSpan === null);

  // --- 1. batched span rewrites, right-to-left within each target ----------
  const groups = new Map<string, Detection[]>();
  for (const det of spanEdits) {
    const key = spanKey(det);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [det]);
    else list.push(det);
  }

  /*
   * ONE INDEX FOR THE SPAN PHASE, and it must not outlive it.
   *
   * The loop below assigns `Text.data` and calls `setAttribute`; neither moves
   * an element, so every nth-of-type ordinal it resolves stays true for the
   * whole phase. `remove-node` strategies DO move elements, and they run in the
   * next loop, which is passed nothing and resolves uncached.
   *
   * This is what made a 1,000-row page take 6.3 minutes: one `querySelector`
   * per detection group at 307 ms each. See `DomIndex`.
   */
  const spanIndex = createDomIndex();
  /*
   * `applyStrategy` resolves the path AGAIN, and for a span edit it then throws
   * the element away ("deferred to batched span rewrite"). Uncached that was one
   * full-table walk per detection for no result at all - the single largest cost
   * left at 100,000 rows after the index landed, because the tripwire test at
   * 2,000 rows is far too small to show it.
   *
   * The removals loop below deliberately keeps the un-indexed `ctx`.
   */
  const spanCtx = { ...ctx, index: spanIndex };

  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => (b.textSpan?.start ?? 0) - (a.textSpan?.start ?? 0));
    const first = ordered[0];
    if (first === undefined || first.domPath === null) continue;
    const el = resolveDomPath(doc, first.domPath, spanIndex);
    if (el === null) {
      for (const det of ordered) {
        entries.push({
          detectionId: det.id,
          kind: det.kind,
          source: det.source,
          strategy: 'placeholder',
          applied: false,
          target: { domPath: det.domPath, rect: det.rect, attr: det.attr },
          placeholder: null,
          preservedShape: null,
          confidence: det.confidence,
          reason: 'DOM path no longer resolves',
        });
      }
      continue;
    }

    for (const det of ordered) {
      const span = det.textSpan;
      if (span === null) continue;
      const outcome = applyStrategy(det, spanCtx, nextOrdinal(det.kind));
      const strategy = outcome.entry.strategy;
      const ordinal = ordinals[det.kind] ?? 1;
      const replacement =
        strategy === 'mask-chars'
          ? '*'.repeat(span.end - span.start)
          : `[[PII:${det.kind.toUpperCase().replace(/-/g, '_')}:${ordinal}:${nonce}]]`;

      let applied = false;
      let had = '';

      if (det.attr !== null) {
        had = el.getAttribute(det.attr) ?? '';
        if (span.end <= had.length) {
          el.setAttribute(det.attr, spliceSpan(had, span.start, span.end, replacement));
          applied = true;
        }
      } else {
        const node = el.childNodes[det.nodeIndex ?? -1];
        if (node !== undefined && node.nodeType === 3) {
          const text = node as Text;
          had = text.data;
          if (span.end <= had.length) {
            text.data = spliceSpan(had, span.start, span.end, replacement);
            applied = true;
          }
        }
      }

      entries.push({
        detectionId: det.id,
        kind: det.kind,
        source: det.source,
        strategy,
        applied,
        target: { domPath: det.domPath, rect: det.rect, attr: det.attr },
        placeholder: applied && strategy !== 'mask-chars' ? replacement : null,
        preservedShape: {
          length: span.end - span.start,
          charClass: 'unknown',
        },
        confidence: det.confidence,
        reason: applied ? 'span rewritten' : 'span no longer within the target text',
      });
    }
  }

  // --- 2. positional edits, removals last ---------------------------------
  const removalsLast = [...positional].sort((a, b) => {
    const aRemove = a.attr === null && a.textSpan === null ? 1 : 0;
    const bRemove = b.attr === null && b.textSpan === null ? 1 : 0;
    return aRemove - bRemove;
  });

  const coverAll = opts.pixelCoverAll === true;
  const pad = opts.padPx ?? 4;

  for (const det of removalsLast) {
    const outcome = applyStrategy(det, ctx, nextOrdinal(det.kind));
    entries.push(outcome.entry);
    if (outcome.pixelOp !== null) pixelOps.push(outcome.pixelOp);
  }

  /*
   * ONE PASS, AFTER EVERY PATH.
   *
   * Detections are applied in three separate loops - span edits, attribute and
   * node edits, and removals - and text PII goes through the FIRST of them. A
   * cover-all written into one loop covered a third of the cases and measured as
   * doing nothing, which is how this ended up here instead.
   *
   * Deduped on detectionId so a detection that already produced a pixel op (a
   * vision box, say) is not blacked out twice.
   */
  if (coverAll) {
    const already = new Set(pixelOps.map((op) => String(op.detectionId)));
    const appliedIds = new Set(
      entries.filter((e) => e.applied).map((e) => String(e.detectionId)),
    );
    for (const det of merged) {
      if (det.rect === null) continue;
      if (!appliedIds.has(String(det.id))) continue;
      if (already.has(String(det.id))) continue;
      pixelOps.push({
        detectionId: det.id,
        kind: det.kind,
        // Blackout, not blur: this is text, and a blur that leaves it legible is
        // worse than no redaction because it looks like one.
        strategy: 'blackout',
        rect: cssViewportToDevice(
          {
            space: 'css-viewport',
            x: det.rect.x - pad,
            y: det.rect.y - pad,
            width: det.rect.width + pad * 2,
            height: det.rect.height + pad * 2,
          },
          viewport,
        ),
        intensity: 1,
      });
    }
  }

  // --- 3. record what we deliberately did not touch ------------------------
  for (const det of skipped) {
    entries.push({
      detectionId: det.id,
      kind: det.kind,
      source: det.source,
      strategy: 'placeholder',
      applied: false,
      target: { domPath: det.domPath, rect: det.rect, attr: det.attr },
      placeholder: null,
      preservedShape: null,
      confidence: det.confidence,
      reason: `below minConfidence ${minConfidence}`,
    });
  }

  const anyFailed = entries.some((e) => !e.applied && !e.reason.startsWith('below minConfidence'));
  const residualRisk: RedactionLog['residualRisk'] = anyFailed
    ? 'unknown'
    : skipped.length > 0
      ? 'low'
      : 'none';

  const log: RedactionLog = {
    schemaVersion: 1,
    frameId: opts.frameId ?? 'frame-0',
    url: sanitizeUrl(opts.url ?? ''),
    nonce,
    createdAt: opts.now ?? Date.now(),
    entries,
    summary: buildSummary(entries, pixelOps, scan.forgeriesStripped),
    residualRisk,
  };

  return {
    html: doc.documentElement.outerHTML as RedactedHtml,
    log,
    detections: merged,
    pixelOps,
    doc,
  };
}
