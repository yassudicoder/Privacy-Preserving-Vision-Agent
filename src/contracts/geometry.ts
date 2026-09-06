/**
 * Coordinate geometry with the space encoded in the type.
 *
 * A silent device-pixel / CSS-pixel mixup shifts every redaction box by the
 * device pixel ratio and quietly destroys redaction precision (20% of the SIH
 * score) without failing anything loudly. So the space is part of the type and
 * the comparison helpers refuse to mix.
 */

export type Space =
  /** Screenshot pixels. Origin = top-left of the captured image. */
  | 'device-px'
  /** CSS pixels relative to the visual viewport. What getBoundingClientRect gives. */
  | 'css-viewport'
  /** CSS pixels relative to the top of the document. Survives scrolling. */
  | 'css-document';

export interface Rect<S extends Space = Space> {
  readonly space: S;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportInfo {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly devicePixelRatio: number;
}

/** Supplies a rect for a DOM element. Browser uses getBoundingClientRect; tests read an attribute. */
export type RectProvider = (el: Element) => Rect<'css-viewport'> | null;

export function rect<S extends Space>(
  space: S,
  x: number,
  y: number,
  width: number,
  height: number,
): Rect<S> {
  return { space, x, y, width, height };
}

// ---------------------------------------------------------------------------
// conversions
// ---------------------------------------------------------------------------

export function deviceToCssViewport(r: Rect<'device-px'>, vp: ViewportInfo): Rect<'css-viewport'> {
  const d = vp.devicePixelRatio || 1;
  return rect('css-viewport', r.x / d, r.y / d, r.width / d, r.height / d);
}

export function cssViewportToDevice(r: Rect<'css-viewport'>, vp: ViewportInfo): Rect<'device-px'> {
  const d = vp.devicePixelRatio || 1;
  return rect('device-px', r.x * d, r.y * d, r.width * d, r.height * d);
}

export function cssViewportToDocument(
  r: Rect<'css-viewport'>,
  vp: ViewportInfo,
): Rect<'css-document'> {
  return rect('css-document', r.x + vp.scrollX, r.y + vp.scrollY, r.width, r.height);
}

export function cssDocumentToViewport(
  r: Rect<'css-document'>,
  vp: ViewportInfo,
): Rect<'css-viewport'> {
  return rect('css-viewport', r.x - vp.scrollX, r.y - vp.scrollY, r.width, r.height);
}

// ---------------------------------------------------------------------------
// comparisons - NoInfer on the second argument pins the space to the first,
// so iou(deviceRect, cssRect) is a compile error rather than a wrong number.
// ---------------------------------------------------------------------------

export function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function intersect<S extends Space>(a: Rect<S>, b: NoInfer<Rect<S>>): Rect<S> | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return rect(a.space, x, y, right - x, bottom - y);
}

export function iou<S extends Space>(a: Rect<S>, b: NoInfer<Rect<S>>): number {
  const inter = intersect(a, b);
  if (inter === null) return 0;
  const i = area(inter);
  const u = area(a) + area(b) - i;
  return u <= 0 ? 0 : i / u;
}

export function union<S extends Space>(a: Rect<S>, b: NoInfer<Rect<S>>): Rect<S> {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return rect(a.space, x, y, right - x, bottom - y);
}

/**
 * Fraction of `inner` that lies inside `outer`. Asymmetric on purpose: a small
 * face box sitting inside a big <img> should score 1.0 even though the IoU is
 * tiny. Used to attach vision boxes to DOM elements.
 */
export function containment<S extends Space>(inner: Rect<S>, outer: NoInfer<Rect<S>>): number {
  const a = area(inner);
  if (a <= 0) return 0;
  const inter = intersect(inner, outer);
  return inter === null ? 0 : area(inter) / a;
}

export function inflate<S extends Space>(r: Rect<S>, px: number): Rect<S> {
  return rect(r.space, r.x - px, r.y - px, r.width + px * 2, r.height + px * 2);
}

export function clampToBounds<S extends Space>(
  r: Rect<S>,
  boundsWidth: number,
  boundsHeight: number,
): Rect<S> {
  const x = Math.max(0, Math.min(r.x, boundsWidth));
  const y = Math.max(0, Math.min(r.y, boundsHeight));
  const right = Math.max(0, Math.min(r.x + r.width, boundsWidth));
  const bottom = Math.max(0, Math.min(r.y + r.height, boundsHeight));
  return rect(r.space, x, y, Math.max(0, right - x), Math.max(0, bottom - y));
}

export function isEmpty(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

export function roundRect<S extends Space>(r: Rect<S>): Rect<S> {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return rect(r.space, x, y, Math.ceil(r.x + r.width) - x, Math.ceil(r.y + r.height) - y);
}

/**
 * Parse `"x,y,w,h"`. Fixtures carry `data-test-rect` because jsdom has no layout
 * engine and getBoundingClientRect() returns all zeros there.
 */
export function parseRectAttr<S extends Space>(value: string | null, space: S): Rect<S> | null {
  if (value === null) return null;
  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return rect(space, x, y, w, h);
}

export function formatRect(r: Rect): string {
  return `${r.space}(${r.x},${r.y},${r.width},${r.height})`;
}
