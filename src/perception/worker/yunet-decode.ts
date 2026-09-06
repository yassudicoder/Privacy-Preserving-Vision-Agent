import { type RawBox, centreToRect } from '../postprocess.ts';

/**
 * Turning YuNet's twelve output tensors into boxes.
 *
 * Pure functions, no ONNX import, no browser. The correctness of the whole
 * model swap lives here, so this is where it can be tested in Node against
 * numbers taken from a real session.
 *
 * WHY A HAND-WRITTEN DECODER AT ALL. transformers.js dispatches
 * `object-detection` to seven architectures (detr, rt_detr, rt_detr_v2, rf_detr,
 * d_fine, table-transformer, yolos) and YuNet is none of them; it also ships
 * neither `config.json` nor `preprocessor_config.json`, which that library
 * requires. So the model cannot load through `TransformersBackend` at all, and
 * the head has to be decoded by hand.
 *
 * The arithmetic below is transcribed from OpenCV's own `face_detect.cpp`
 * `postProcess()`. It is not a reimplementation from a paper.
 */

/** The three feature-map strides YuNet emits, smallest cell first. */
export const YUNET_STRIDES = [8, 16, 32] as const;

/** YuNet's label, chosen to match `LABEL_MAP` so `labelToPiiKind` needs no edit. */
export const YUNET_LABEL = 'face';

/**
 * The subset of YuNet's outputs that produce boxes.
 *
 * Each array is indexed by stride position: `cls[0]` goes with
 * `YUNET_STRIDES[0]`. The model also emits `kps_8/16/32` (five facial landmarks
 * per candidate); they are deliberately not consumed. No contract in this
 * project has a use for them, and carrying data nothing reads is how a decoder
 * grows a second, untested meaning.
 */
export interface YunetOutputs {
  /** Classification logit per anchor, already sigmoid'd by the model. */
  readonly cls: readonly Float32Array[];
  /** Objectness per anchor. */
  readonly obj: readonly Float32Array[];
  /** Box deltas, four per anchor: [dx, dy, logW, logH]. */
  readonly bbox: readonly Float32Array[];
}

export interface DecodeYunetOptions {
  /**
   * Candidates below this are dropped before they are returned.
   *
   * NOT the policy threshold. `decodeDetections` applies the engine's real
   * `scoreThreshold` and NMS downstream, and duplicating that here would put the
   * same decision in two places. This exists only so a 640x640 frame does not
   * return all 8400 anchors, the overwhelming majority of which score ~0.
   */
  readonly floor?: number;
}

/** Low enough to be a memory guard rather than a policy decision. */
const DEFAULT_FLOOR = 0.05;

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Decode to boxes in the PADDED SQUARE's own pixels.
 *
 * That is exactly what `InferenceBackend.infer` promises to return and what
 * `undoLetterbox` inverts, so nothing below the backend changes when the model
 * does.
 */
export function decodeYunet(
  outputs: YunetOutputs,
  inputSize: number,
  options: DecodeYunetOptions = {},
): RawBox[] {
  const floor = options.floor ?? DEFAULT_FLOOR;
  const boxes: RawBox[] = [];

  for (let s = 0; s < YUNET_STRIDES.length; s += 1) {
    const stride = YUNET_STRIDES[s];
    const cls = outputs.cls[s];
    const obj = outputs.obj[s];
    const bbox = outputs.bbox[s];
    if (stride === undefined || cls === undefined || obj === undefined || bbox === undefined) {
      continue;
    }

    // Anchors are laid out row-major over the feature map, so the column index
    // needs the map's width - not the input's.
    const cols = Math.floor(inputSize / stride);
    const anchors = Math.min(cls.length, obj.length, Math.floor(bbox.length / 4));

    for (let i = 0; i < anchors; i += 1) {
      const c = cls[i];
      const o = obj[i];
      if (c === undefined || o === undefined) continue;

      /*
       * The geometric mean of classification and objectness, not the product.
       * OpenCV takes the square root, and dropping it does not break anything
       * loudly - it just shifts every score downward, so a threshold tuned on
       * one convention silently rejects most faces under the other.
       */
      const score = Math.sqrt(clamp01(c) * clamp01(o));
      if (score < floor) continue;

      const dx = bbox[i * 4];
      const dy = bbox[i * 4 + 1];
      const logW = bbox[i * 4 + 2];
      const logH = bbox[i * 4 + 3];
      if (dx === undefined || dy === undefined || logW === undefined || logH === undefined) {
        continue;
      }

      const col = i % cols;
      const row = Math.floor(i / cols);

      // Centre offsets are in CELLS and sizes are log-scaled, both relative to
      // the stride. Getting either wrong yields boxes that are plausible in
      // shape and in the wrong place.
      const cx = (col + dx) * stride;
      const cy = (row + dy) * stride;
      const w = Math.exp(logW) * stride;
      const h = Math.exp(logH) * stride;

      boxes.push({ label: YUNET_LABEL, score, rect: centreToRect(cx, cy, w, h) });
    }
  }

  return boxes;
}

/**
 * RGB frame to the tensor YuNet expects: BGR, CHW, raw 0-255.
 *
 * THE FOOTGUN THIS FILE EXISTS TO CONTAIN. YuNet is trained the way OpenCV
 * feeds it - `blobFromImage` with all defaults, which means NO scaling, NO mean
 * subtraction, and BGR channel order because that is OpenCV's native layout.
 *
 * Feeding RGB instead throws nothing, logs nothing, and returns confident boxes.
 * A measured A/B on one image gave 130 faces for BGR against 36 for RGB - a 72%
 * recall loss - with the top-scoring detection still reading 0.913. There is no
 * symptom to notice.
 *
 * The existing preprocessing path CANNOT be reused: `transformers-env.ts` calls
 * `RawImage.rgb()`, which is the wrong order for this model.
 */
export function rgbaToBgrChw(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    const src = i * 4;
    const r = data[src];
    const g = data[src + 1];
    const b = data[src + 2];
    if (r === undefined || g === undefined || b === undefined) continue;
    // B, G, R - in that order, and unscaled.
    out[i] = b;
    out[plane + i] = g;
    out[plane * 2 + i] = r;
  }
  return out;
}
