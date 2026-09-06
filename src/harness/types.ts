import type { DomPath, PiiKind, Untrusted, ViewportInfo, VisionDetection } from '@/contracts/index.ts';

/**
 * Fixture and ground-truth schema.
 *
 * Conventions (also written into CLAUDE.md so they survive):
 *   <id>.html         the page. Self-contained, no network, no scripts.
 *   <id>.truth.json   this schema.
 *   <id>.vision.json  VisionDetection[] a plausible model would emit.
 *
 * Elements that matter carry `data-test-rect="x,y,w,h"` because jsdom has no
 * layout engine - getBoundingClientRect() returns zeros there, so geometry would
 * be untestable without it. In a real browser the same code path reads real
 * layout via a different RectProvider.
 */

export interface TruthLocator {
  /** CSS selector for the element that holds, or is, the sensitive thing. */
  readonly selector: string;
  /** Set when the value lives in an attribute rather than in text. */
  readonly attr?: string;
  /** Set when the value is a substring of the element's text. */
  readonly textMatch?: string;
}

export interface GroundTruthItem {
  readonly id: string;
  readonly kind: PiiKind;
  /**
   * False marks something genuinely sensitive that this build is not expected to
   * catch. Excluded from the recall denominator AND never counted as a false
   * positive. Every one of these needs a `note` saying why - it is a documented
   * gap, not a way to make a number look better.
   */
  readonly mustRedact: boolean;
  readonly locator: TruthLocator;
  /** Exact value. The leak test greps the outgoing payload for this string. */
  readonly literal?: string;
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly note?: string;
}

export interface BenignItem {
  readonly selector: string;
  readonly note: string;
}

/** Ground truth for SIH metric 1: what the server should be told is on screen. */
export interface ExpectedElement {
  readonly id: string;
  readonly role: string;
  /** Accessible name AFTER redaction. Null when the element legitimately has none. */
  readonly name: string | null;
  readonly selector: string;
  readonly states?: readonly string[];
  readonly sensitive: boolean;
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface GroundTruth {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly viewport: ViewportInfo;
  readonly sensitive: readonly GroundTruthItem[];
  readonly benign: readonly BenignItem[];
  readonly expectedElements: readonly ExpectedElement[];
  /** Forged redaction tokens the fixture plants. Only the injection fixture sets it. */
  readonly expectedForgeries?: number;
}

/** A truth item with its selector resolved against the parsed document. */
export interface ResolvedGroundTruthItem extends GroundTruthItem {
  readonly domPath: DomPath | null;
}

export interface Fixture {
  readonly id: string;
  readonly html: Untrusted<string>;
  readonly truth: GroundTruth;
  readonly visionBoxes: readonly VisionDetection[];
}
