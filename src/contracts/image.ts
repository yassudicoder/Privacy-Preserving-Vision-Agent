/**
 * A decoded RGBA frame.
 *
 * WHY IT LIVES IN CONTRACTS: both halves of the pipeline need this shape. The
 * perception worker holds decoded frames between `detect` and `bake`; the
 * redactor writes pixels into them. The module DAG forbids
 * `perception -> redaction`, so the shape they share has to sit in the leaf both
 * are already allowed to import.
 *
 * It was originally declared in `redaction/canvas-redact.ts`, which still
 * re-exports it so existing imports keep working.
 *
 * Row-major, 4 bytes per pixel, non-premultiplied. `data.length` is always
 * `width * height * 4` - nothing in the codebase tolerates a short buffer, and
 * a short buffer reads as a black image rather than an error.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}
