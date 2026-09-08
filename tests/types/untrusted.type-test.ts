/**
 * Negative type tests.
 *
 * These are checked by `tsc --noEmit`, which `npm test` runs first. Every
 * `@ts-expect-error` below FAILS THE BUILD if the code it guards ever starts
 * compiling. That is the point: these assert that a mistake is impossible, not
 * merely that it did not happen today.
 *
 * Vitest does not run this file (no `.test.ts` suffix) - there is nothing to
 * run. The assertion is the compile.
 */

import type {
  BakedScreenshot,
  DataAtom,
  Rect,
  SanitizedContext,
  SanitizedContextShape,
  Untrusted,
} from '@/contracts/index.ts';
import {
  iou,
  markUntrusted,
  rect,
  redactionNonce,
  toDataAtom,
  unsafeUnwrap,
  emptyBudgetReport,
} from '@/contracts/index.ts';
import type { PlanRequest } from '@/agent-server/index.ts';
import { encodeRequest, PROTOCOL_VERSION, renderPrompt } from '@/agent-server/index.ts';

// ---------------------------------------------------------------------------
// Untrusted<T> cannot be used where a plain string is expected
// ---------------------------------------------------------------------------

declare const pageText: Untrusted<string>;

function wantsPlainString(_s: string): void {}

// @ts-expect-error page text must not flow into a plain string parameter
wantsPlainString(pageText);

// The only way through is an explicit, reasoned unwrap.
wantsPlainString(unsafeUnwrap(pageText, 'regex-scan'));

// @ts-expect-error the reason must be one of the sanctioned set
unsafeUnwrap(pageText, 'because-i-said-so');

// A plain string is not automatically page data either - marking is deliberate.
const marked: Untrusted<string> = markUntrusted('from the DOM');
wantsPlainString(unsafeUnwrap(marked, 'test-fixture'));

// ---------------------------------------------------------------------------
// Only a DataAtom crosses the network boundary
// ---------------------------------------------------------------------------

declare const atom: DataAtom;
function wantsAtom(_a: DataAtom): void {}
wantsAtom(atom);

// @ts-expect-error a raw string is not a DataAtom, however innocent it looks
wantsAtom('just a string');

// @ts-expect-error toDataAtom only accepts page-marked text
toDataAtom('unmarked', { redacted: false });

// ---------------------------------------------------------------------------
// SanitizedContext is nominal: only redaction/sanitize.ts can mint one
// ---------------------------------------------------------------------------

declare const realContext: SanitizedContext;
renderPrompt(realContext);

/**
 * A perfectly well-formed context shape, hand-built outside redaction/.
 * It satisfies `SanitizedContextShape` in every detail and is still refused,
 * because passing through `buildSanitizedContext` is what makes it true.
 */
const handBuilt: SanitizedContextShape = {
  // A hand-built analysis is refused for the same reason the context is: the
  // brand is what says the numbers came from the engine, not the shape.
  analysis: null,
  schemaVersion: 1,
  taskId: 't',
  step: 0,
  goal: 'g',
  url: 'https://x.invalid/',
  title: atom,
  viewport: { cssWidth: 0, cssHeight: 0, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  elements: [],
  screenshot: null,
  redactionSummary: {
    byKind: {},
    bySource: {},
    nodesRemoved: 0,
    attributesDropped: 0,
    placeholdersInserted: 0,
    pixelOpsQueued: 0,
    forgeriesStripped: 0,
  },
  nonce: redactionNonce('abc'),
  history: [],
  clarifications: [],
  budget: emptyBudgetReport(0),
};

// @ts-expect-error the right shape is still not a SanitizedContext
renderPrompt(handBuilt);

declare const realRequest: PlanRequest;
encodeRequest(realRequest);

// @ts-expect-error the wire format takes a SanitizedContext, never raw page HTML
encodeRequest({ protocolVersion: PROTOCOL_VERSION, context: pageText, clientVersion: 'x' });

// ---------------------------------------------------------------------------
// BakedScreenshot cannot be asserted by hand
// ---------------------------------------------------------------------------

function wantsBaked(_s: BakedScreenshot): void {}

// @ts-expect-error claiming redactions were baked does not make it so
wantsBaked({
  base64: 'AAAA',
  format: 'jpeg',
  width: 10,
  height: 10,
  opsApplied: 3,
  opsRequested: 3,
});

// ---------------------------------------------------------------------------
// Coordinate spaces do not mix
// ---------------------------------------------------------------------------

const deviceRect: Rect<'device-px'> = rect('device-px', 0, 0, 10, 10);
const cssRect: Rect<'css-viewport'> = rect('css-viewport', 0, 0, 10, 10);

iou(deviceRect, rect('device-px', 5, 5, 10, 10));
iou(cssRect, rect('css-viewport', 5, 5, 10, 10));

// @ts-expect-error comparing a screenshot rect with a layout rect is meaningless
iou(deviceRect, cssRect);

// @ts-expect-error ...in either order
iou(cssRect, deviceRect);
