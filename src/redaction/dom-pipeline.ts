import type {
  Detection,
  ExecutedStep,
  Clarification,
  PixelRedactionOp,
  RedactionLog,
  RedactionNonce,
  SanitizedContext,
  SanitizedContextShape,
  ViewportInfo,
  VisionDetection,
} from '@/contracts/index.ts';
import { markUntrusted, type ElementBudgetPolicy } from '@/contracts/index.ts';
import { redact } from './redact.ts';
import { buildSanitizedContext, extractRefPaths, receiveSanitizedContext } from './sanitize.ts';
import { type BrowserBakeResult } from './browser-bake.ts';
import { receiveBakedScreenshot } from './canvas-redact.ts';

/**
 * Where the redacted Document lives.
 *
 * THE PROBLEM THIS SOLVES. `redact()` calls `new DOMParser()`, and
 * `buildSanitizedContext()` consumes the `Document` it returns. Chrome's MV3
 * background is a service worker with NO DOM, so calling either from the
 * background fails with "redact: DOMParser is not defined" - which is exactly
 * what every Chrome step did. Firefox's background is an event page that DOES
 * have a DOM, so the identical code worked there, and the whole loop ran. One
 * codebase, two engines, one of them silently unable to run a core stage.
 *
 * WHY IT IS A SEAM RATHER THAN A MOVE. A `Document` cannot cross
 * `runtime.sendMessage`. So on Chrome the Document has to be created, used and
 * discarded inside the offscreen document, and the background can only send
 * inputs and receive serialisable outputs. Two implementations of one interface:
 * in-process for Firefox and every test, remote for Chrome.
 *
 * WHY THE HANDLE. `redact` and `sanitize` are two calls that share a Document,
 * and on Chrome they are two separate messages. The Document is retained between
 * them, keyed by the frame id - the same shape `LocalWorkerRuntime` already uses
 * to keep a decoded bitmap between `detect` and `bake`, and for the same reason:
 * the expensive, unserialisable thing stays put.
 *
 * WHAT DOES NOT CHANGE. The orchestrator still decides the ORDER. Redact before
 * bake before sanitize is still enforced there, and `buildSanitizedContext`
 * still only accepts a `BakedScreenshot` that `bakeRedactions` can mint.
 */

export const DOM_REDACT_CMD = 'dom/redact';
export const DOM_SANITIZE_CMD = 'dom/sanitize';

export interface DomRedactRequest {
  /** Keys the retained Document. The frame id, so it is unique per step. */
  readonly handle: string;
  /**
   * Page HTML as a bare string.
   *
   * `Untrusted<T>` holds its payload behind a module-private symbol, and symbol
   * keys are not serialised - `JSON.stringify` of an Untrusted value yields
   * `{}`. That is a deliberate property (page text cannot leak by accident) and
   * it means the wrapper CANNOT cross a message boundary. So the wire carries a
   * bare string and the receiving side re-marks it, which is the same contract
   * the content script -> background hop already has.
   */
  readonly html: string;
  readonly visionBoxes: readonly VisionDetection[];
  readonly viewport: ViewportInfo;
  readonly nonce: RedactionNonce;
  readonly salt: string;
  readonly minConfidence: number;
  readonly frameId: string;
  readonly url: string;
  readonly now: number;
  /**
   * Cover DOM-handled detections in pixels too.
   *
   * Travels on the wire because the decision belongs to the step - it knows
   * whether a screenshot is going to a server - and the redaction happens on the
   * far side.
   */
  readonly pixelCoverAll?: boolean;
}

/** Everything from `RedactResult` except the Document, which cannot travel. */
export interface DomRedactReply {
  readonly log: RedactionLog;
  readonly detections: readonly Detection[];
  readonly pixelOps: readonly PixelRedactionOp[];
}

export interface DomSanitizeRequest {
  readonly handle: string;
  readonly viewport: ViewportInfo;
  readonly url: string;
  readonly taskId: string;
  readonly step: number;
  /** From the USER. Never from the page. */
  readonly goal: string;
  readonly history: readonly ExecutedStep[];
  /** Q&A with the user. Plain data, so it survives postMessage on Chrome. */
  readonly clarifications: readonly Clarification[];
  readonly screenshot: BrowserBakeResult | null;
  /**
   * The element budget. Plain data, because this crosses `postMessage` on
   * Chrome and a function cannot travel.
   */
  readonly budget: ElementBudgetPolicy;
}

export interface DomSanitizeReply {
  readonly context: SanitizedContext;
  /**
   * ref -> DOM path, as entries.
   *
   * A `Map` JSON-stringifies to `{}`, so sending one would arrive empty and
   * every action would report a miss with no indication why.
   */
  readonly refPaths: readonly (readonly [string, string])[];
}

export interface DomPipeline {
  redact(req: DomRedactRequest): Promise<DomRedactReply>;
  sanitize(req: DomSanitizeRequest): Promise<DomSanitizeReply>;
}

/** How many redacted Documents to hold at once. One step needs exactly one. */
const DEFAULT_MAX_HELD = 2;

interface Held {
  readonly doc: Document;
  readonly log: RedactionLog;
  readonly detections: readonly Detection[];
}

/**
 * Runs in whatever context calls it. Requires a DOM.
 *
 * Used by Firefox's event page, by the offscreen document on Chrome, and by
 * every test. It is the real implementation; the remote one is only a courier.
 */
export function createInProcessDomPipeline(maxHeld = DEFAULT_MAX_HELD): DomPipeline {
  const held = new Map<string, Held>();

  return {
    /*
     * `async` deliberately, though nothing here awaits.
     *
     * `redact()` throws SYNCHRONOUSLY - a missing DOMParser is a ReferenceError
     * raised during the call, not a rejected promise. From a method declared
     * `Promise<DomRedactReply>`, that means a caller writing
     * `pipeline.redact(...).catch(...)` never sees the error: it escapes past the
     * handler as a synchronous throw. `async` converts every throw in this body
     * into the rejection the signature already promises.
     */
    async redact(req) {
      // Re-marked on arrival. From here the type system will not let this string
      // be treated as anything but data.
      const result = redact(markUntrusted(req.html), req.visionBoxes, {
        viewport: req.viewport,
        salt: req.salt,
        nonce: req.nonce,
        minConfidence: req.minConfidence,
        frameId: req.frameId,
        url: req.url,
        now: req.now,
        ...(req.pixelCoverAll === true ? { pixelCoverAll: true } : {}),
      });

      held.set(req.handle, {
        doc: result.doc,
        log: result.log,
        detections: result.detections,
      });
      // Bounded. A step that fails between redact and sanitize would otherwise
      // leak a Document holding the whole page.
      while (held.size > maxHeld) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }

      return {
        log: result.log,
        detections: result.detections,
        pixelOps: result.pixelOps,
      };
    },

    // async for the same reason as redact: buildSanitizedContext can throw.
    async sanitize(req) {
      const entry = held.get(req.handle);
      if (entry === undefined) {
        // Named, not silently empty. An empty context would sail through the
        // rest of the step and produce a plan about a page nobody looked at.
        throw new Error(`dom pipeline: no redacted document for handle "${req.handle}"`);
      }
      try {
        const context = buildSanitizedContext({
          doc: entry.doc,
          log: entry.log,
          detections: entry.detections,
          viewport: req.viewport,
          url: req.url,
          taskId: req.taskId,
          step: req.step,
          goal: req.goal,
          history: req.history,
          clarifications: req.clarifications,
          screenshot: req.screenshot === null ? null : receiveBakedScreenshot(req.screenshot),
          budget: req.budget,
        });
        return { context, refPaths: [...extractRefPaths(entry.doc)] };
      } finally {
        // Freed whether or not the build succeeded.
        held.delete(req.handle);
      }
    },
  };
}

/**
 * Forwards both calls to a context that has a DOM. Chrome only.
 *
 * `request` is the offscreen channel, passed in rather than imported so this
 * file needs no knowledge of hosts, and so the DAG stays acyclic - `redaction`
 * may not import `perception`.
 */
export function createRemoteDomPipeline(
  request: (cmd: string, payload: unknown) => Promise<unknown>,
): DomPipeline {
  return {
    async redact(req) {
      return (await request(DOM_REDACT_CMD, req)) as DomRedactReply;
    },
    async sanitize(req) {
      const wire = (await request(DOM_SANITIZE_CMD, req)) as {
        context: SanitizedContextShape;
        refPaths: readonly (readonly [string, string])[];
      };
      /*
       * Re-branded, because JSON stripped the nominal marker.
       *
       * This is weaker than the in-process path, where the context is the one
       * `buildSanitizedContext` actually minted. It is unavoidable for anything
       * that crosses a boundary - `receiveBakedScreenshot` makes the same trade
       * for the same reason - and it is confined to this one function so the
       * weakening is greppable rather than ambient.
       */
      return { context: receiveSanitizedContext(wire.context), refPaths: wire.refPaths };
    },
  };
}
