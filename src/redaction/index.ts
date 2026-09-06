/**
 * DOM PII detection, merge with vision boxes, redaction, and the sanitized
 * payload. The only module permitted to mint a SanitizedContext.
 */
export { redact, sanitizeUrl, DEFAULT_VIEWPORT } from './redact.ts';
export type { RedactOptions, RedactResult } from './redact.ts';

export { stampGeometry, RECT_ATTR, type StampResult } from './stamp-geometry.ts';
export { scanDom, canonicalPath, resolveDomPath, elementRole, accessibleName, attributeRectProvider, stripForgeriesFromDoc, resetDetectionIds } from './dom-scan.ts';
export type { DomScanOptions, DomScanResult } from './dom-scan.ts';

export { scanTextPatterns, dedupeMatches, charClassOf, luhnValid, verhoeffValid, panValid, ipv4Valid, ssnValid } from './patterns.ts';
export type { PatternMatch, CharClass } from './patterns.ts';

export { mergeDetections, attachToElement, pixelOnly, countByKind } from './merge.ts';
export type { MergeOptions } from './merge.ts';

export { resolveStrategy, applyStrategy, spliceSpan } from './strategies.ts';
export type { StrategyContext, ApplyOutcome } from './strategies.ts';

export { createImage, cloneImage, blackoutRect, boxBlurRect, pixelateRect, applyPixelOps, bakeRedactions, regionStats, unchangedOutside } from './canvas-redact.ts';
export type { RgbaImage, ApplyResult, ImageEncoder, RegionStats } from './canvas-redact.ts';
export { receiveBakedScreenshot } from './canvas-redact.ts';
export { createBrowserBake } from './browser-bake.ts';
export type { BrowserBakeResult } from './browser-bake.ts';

export { buildSanitizedContext, extractElements, extractRefPaths, validationContextFor } from './sanitize.ts';
export type { BuildContextInput, ExtractOptions } from './sanitize.ts';

/*
 * The content half of the egress gate.
 *
 * `contracts/egress.ts` checks the payload's SHAPE and can run inside the
 * network client. This re-runs the PII DETECTORS over the text about to be sent,
 * which needs `scanTextPatterns` and therefore has to live in this module -
 * `agent-server` may import only contracts. The orchestrator sees both and calls
 * both.
 */
export { verifyOutboundRedaction, assertNoLeak, outboundTextFields, OutboundLeakError } from './egress.ts';
export type { LeakFinding, RedactionVerdict, VerifyOptions } from './egress.ts';

/*
 * The DOM pipeline: where redact and sanitize run.
 *
 * Chrome's MV3 service worker has no DOMParser, so on Chrome both must happen in
 * the offscreen document. `receiveSanitizedContext` is deliberately NOT exported
 * here - minting a SanitizedContext stays inside this module, and only
 * `createRemoteDomPipeline` needs it.
 */
export {
  DOM_REDACT_CMD,
  DOM_SANITIZE_CMD,
  createInProcessDomPipeline,
  createRemoteDomPipeline,
} from './dom-pipeline.ts';
export type {
  DomPipeline,
  DomRedactRequest,
  DomRedactReply,
  DomSanitizeRequest,
  DomSanitizeReply,
} from './dom-pipeline.ts';
