/*
 * Generates the images used by vision.html.
 *
 *   node test-site/make-images.mjs
 *
 * Deterministic: same input, byte-identical output, so regenerating does not
 * churn the repo. No dependencies - a PNG encoder over node:zlib is less
 * trouble than adding sharp/canvas to devDependencies for eight files.
 *
 * WHY THE FACES ARE DRAWN RATHER THAN PHOTOGRAPHED. A test lab cannot ship
 * photographs of real people, and it must work offline. So the faces are
 * rasterised from canonical proportions - eyes at 0.44 of head height,
 * inter-pupil spacing 0.45 of head width, nose base 0.635, mouth 0.775. Those
 * ratios are the whole trick: YuNet is a frontal photographic detector, and it
 * is the geometry it keys on, not the realism.
 *
 * These are MEASURED, not assumed. `npx tsx test-site/verify-vision.ts` scores
 * every file below through the shipped weights and the shipped ORT wasm build.
 * Do not change a parameter here without re-running it.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./images/', import.meta.url));

// ---------------------------------------------------------------- PNG output

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** RGBA in, 8-bit RGB PNG out. Adaptive per-row filtering (min sum of abs). */
export function encodePng(rgba, width, height) {
  const bpp = 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = x * bpp;
      cur[d] = rgba[s];
      cur[d + 1] = rgba[s + 1];
      cur[d + 2] = rgba[s + 2];
    }
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (f === 0) v = cur[i];
        else if (f === 1) v = cur[i] - a;
        else if (f === 2) v = cur[i] - b;
        else if (f === 3) v = cur[i] - ((a + b) >> 1);
        else v = cur[i] - paethPredict(a, b, c);
        v &= 0xff;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    const off = y * (stride + 1);
    raw[off] = best;
    cand[best].copy(raw, off + 1);
    cur.copy(prev);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour RGB
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- raster helpers

const SS = 2; // supersample factor, for anti-aliased edges

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

class Surface {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.buf = new Float32Array(w * h * 3);
  }
  /*
   * FLOORED, because a fractional index is a SILENT no-op.
   *
   * `buf[(y * w + x) * 3]` with a fractional x or y writes to a non-integer
   * index of a Float32Array, which JavaScript discards without error. The first
   * product renderer computed every coordinate as a fraction of the canvas
   * (`W * 0.62`, `(W - sw) / 2`) and produced images that were entirely blank
   * except for the one shape drawn through `fillEllipse`, which floors its own
   * bounds. Nothing threw and nothing warned - the pictures were simply empty.
   *
   * Existing callers already pass integers, so flooring is a no-op for them.
   */
  set(x, y, rgb) {
    const i = ((y | 0) * this.w + (x | 0)) * 3;
    this.buf[i] = rgb[0]; this.buf[i + 1] = rgb[1]; this.buf[i + 2] = rgb[2];
  }
  get(x, y) {
    const i = ((y | 0) * this.w + (x | 0)) * 3;
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2]];
  }
  blend(x, y, rgb, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.set(x, y, mix(this.get(x, y), rgb, Math.min(1, a)));
  }
  rect(x0, y0, w, h, rgb) {
    // Floored at the edges too, so a fractional origin does not shift every
    // scanline by a sub-pixel and leave a one-row seam.
    const ys = Math.max(0, Math.floor(y0));
    const ye = Math.min(this.h, Math.floor(y0 + h));
    const xs = Math.max(0, Math.floor(x0));
    const xe = Math.min(this.w, Math.floor(x0 + w));
    for (let y = ys; y < ye; y += 1) {
      for (let x = xs; x < xe; x += 1) this.set(x, y, rgb);
    }
  }
}

function fillEllipse(c, cx, cy, rx, ry, color, soft = 1.5, alpha = 1) {
  const x0 = Math.max(0, Math.floor(cx - rx - 3));
  const x1 = Math.min(c.w - 1, Math.ceil(cx + rx + 3));
  const y0 = Math.max(0, Math.floor(cy - ry - 3));
  const y1 = Math.min(c.h - 1, Math.ceil(cy + ry + 3));
  const scale = Math.min(rx, ry);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const edge = (1 - Math.sqrt(dx * dx + dy * dy)) * scale;
      let cov;
      if (edge >= soft) cov = 1;
      else if (edge <= -soft) cov = 0;
      else cov = (edge + soft) / (2 * soft);
      if (cov <= 0) continue;
      c.blend(x, y, typeof color === 'function' ? color(x, y) : color, cov * alpha);
    }
  }
}

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Downsample the supersampled surface to RGBA, adding deterministic grain. */
function resolve(c, w, h, grain, seed) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const n = SS * SS;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const p = c.get(x * SS + sx, y * SS + sy);
          r += p[0]; g += p[1]; b += p[2];
        }
      }
      const gr = (hash2(x, y, seed) - 0.5) * grain;
      const i = (y * w + x) * 4;
      rgba[i] = r / n + gr;
      rgba[i + 1] = g / n + gr;
      rgba[i + 2] = b / n + gr;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

// -------------------------------------------------------------------- a face

function renderFace(w, h, p = {}) {
  const o = {
    seed: 1,
    headCenterX: 0.5, headCenterY: 0.52,
    headHeight: 0.66, headAspect: 0.74,
    skin: [222, 178, 149], skinShadow: [176, 130, 104],
    hair: [58, 42, 34], shirt: [72, 92, 122],
    bg: [206, 212, 218],
    lip: [176, 106, 96],
    grain: 5,
    ...p,
  };

  const W = w * SS, H = h * SS;
  const c = new Surface(W, H);

  const bgTop = mix(o.bg, [255, 255, 255], 0.35);
  const bgBot = mix(o.bg, [0, 0, 0], 0.12);
  for (let y = 0; y < H; y += 1) {
    const row = mix(bgTop, bgBot, y / (H - 1));
    for (let x = 0; x < W; x += 1) {
      const nx = (x / W - 0.5) * 2, ny = (y / H - 0.5) * 2;
      const v = 1 - 0.18 * Math.min(1, nx * nx + ny * ny);
      c.set(x, y, [row[0] * v, row[1] * v, row[2] * v]);
    }
  }

  const hh = o.headHeight * H;
  const rx = (hh * o.headAspect) / 2;
  const ry = hh / 2;
  const cx = o.headCenterX * W;
  const cy = o.headCenterY * H;
  const hw = rx * 2;

  // neck and shoulders
  fillEllipse(c, cx, cy + ry * 1.07, rx * 0.34, ry * 0.36, mix(o.skin, o.skinShadow, 0.42), 2 * SS);
  fillEllipse(c, cx, H + ry * 0.25, rx * 1.75, ry * 1.05, o.shirt, 2.5 * SS);

  // hair mass behind the head
  fillEllipse(c, cx, cy - ry * 0.12, rx * 1.1, ry * 1.06, (x, y) => {
    const t = Math.min(1, Math.max(0, (y - (cy - ry)) / (2 * ry)));
    return mix(mix(o.hair, [255, 255, 255], 0.12), o.hair, t);
  }, 2 * SS);

  // face, lit from upper-left
  fillEllipse(c, cx, cy, rx, ry, (x, y) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    const lambert = 0.5 - 0.42 * dx - 0.3 * dy;
    const base = mix(o.skin, o.skinShadow, Math.min(1, Math.max(0, 1 - lambert)) * 0.9);
    const cheek = Math.exp(-(((Math.abs(dx) - 0.55) ** 2) / 0.05 + ((dy - 0.22) ** 2) / 0.08));
    return mix(base, [216, 150, 138], cheek * 0.3);
  }, 2 * SS);

  fillEllipse(c, cx, cy - ry * 0.86, rx * 1.02, ry * 0.42, o.hair, 3 * SS, 0.96);

  const topY = cy - ry;
  const eyeY = topY + hh * 0.44;
  const eyeDX = hw * 0.225;
  const eyeRX = hw * 0.115;
  const eyeRY = hh * 0.042;
  const noseY = topY + hh * 0.635;
  const mouthY = topY + hh * 0.775;

  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    fillEllipse(c, ex, eyeY + eyeRY * 0.3, eyeRX * 1.75, hh * 0.052, mix(o.skin, o.skinShadow, 0.55), 4 * SS, 0.55);
    fillEllipse(c, ex, eyeY, eyeRX, eyeRY, [243, 241, 238], 1.2 * SS);
    const ir = eyeRY * 1.02;
    fillEllipse(c, ex, eyeY, ir, ir, (x, y) =>
      mix([96, 74, 52], [48, 34, 24], Math.min(1, Math.hypot(x - ex, y - eyeY) / ir)), 1 * SS);
    fillEllipse(c, ex, eyeY, ir * 0.44, ir * 0.44, [16, 14, 12], 1 * SS);
    fillEllipse(c, ex - ir * 0.32, eyeY - ir * 0.34, ir * 0.18, ir * 0.18, [255, 255, 255], 0.8 * SS, 0.9);
    fillEllipse(c, ex, eyeY - eyeRY * 0.72, eyeRX * 1.02, eyeRY * 0.34, [52, 40, 34], 1 * SS, 0.85);
    fillEllipse(c, ex, eyeY - hh * 0.075, eyeRX * 1.25, hh * 0.017, mix(o.hair, [255, 255, 255], 0.08), 1.6 * SS, 0.92);
  }

  fillEllipse(c, cx, (eyeY + noseY) / 2, hw * 0.045, (noseY - eyeY) * 0.55, mix(o.skin, [255, 255, 255], 0.3), 4 * SS, 0.5);
  fillEllipse(c, cx, noseY, hw * 0.085, hh * 0.035, mix(o.skin, o.skinShadow, 0.45), 3 * SS, 0.75);
  for (const s of [-1, 1]) {
    fillEllipse(c, cx + s * hw * 0.058, noseY + hh * 0.012, hw * 0.02, hh * 0.011, mix(o.skinShadow, [0, 0, 0], 0.45), 1.2 * SS, 0.8);
  }

  const mw = hw * 0.175;
  fillEllipse(c, cx, mouthY, mw, hh * 0.03, o.lip, 1.5 * SS, 0.95);
  fillEllipse(c, cx, mouthY, mw * 0.95, hh * 0.005, mix(o.lip, [0, 0, 0], 0.55), 1 * SS, 0.9);
  fillEllipse(c, cx, mouthY + hh * 0.017, mw * 0.7, hh * 0.012, mix(o.lip, [255, 255, 255], 0.32), 1.6 * SS, 0.6);
  fillEllipse(c, cx, mouthY + hh * 0.072, hw * 0.16, hh * 0.03, mix(o.skin, o.skinShadow, 0.4), 4 * SS, 0.45);

  return resolve(c, w, h, o.grain, o.seed);
}

// ------------------------------------------------------- the negative controls

function renderLandscape(w, h) {
  const c = new Surface(w * SS, h * SS);
  const W = w * SS, H = h * SS;
  for (let y = 0; y < H; y += 1) {
    const t = y / H;
    for (let x = 0; x < W; x += 1) c.set(x, y, [120 + 110 * t, 165 + 70 * t, 220 - 20 * t]);
  }
  const sx = W * 0.72, sy = H * 0.3, sr = Math.min(W, H) * 0.13;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = Math.hypot(x - sx, y - sy) / sr;
      if (d >= 1.6) continue;
      const g = (1 - d / 1.6) ** 2;
      c.blend(x, y, [255, 246, 200], g);
    }
  }
  for (const b of [
    { base: 0.60, amp: 0.055, freq: 2.1, col: [96, 140, 96] },
    { base: 0.73, amp: 0.045, freq: 3.3, col: [70, 112, 78] },
    { base: 0.86, amp: 0.035, freq: 1.6, col: [48, 84, 60] },
  ]) {
    for (let x = 0; x < W; x += 1) {
      const yTop = Math.floor(H * (b.base + b.amp * Math.sin((x / W) * Math.PI * b.freq + b.freq)));
      for (let y = Math.max(0, yTop); y < H; y += 1) c.set(x, y, b.col);
    }
  }
  return resolve(c, w, h, 3, 11);
}

/*
 * A product photo: laptop, phone or headphones on a soft studio background.
 *
 * These exist to be the boring half of the test. Searching for "laptop" should
 * surface products, and NONE of them may produce a face detection - a model that
 * fires on a screen bezel or a pair of round earcups is spending redaction
 * precision (20% of the score) on nothing. Rounded dark shapes on a light
 * background are exactly the shape that fools weak detectors, which is the point.
 */
function renderProduct(w, h, kind, opts = {}) {
  const W = w * SS, H = h * SS;
  const c = new Surface(W, H);
  const bg = opts.bg ?? [238, 240, 243];
  const body = opts.body ?? [176, 180, 188];
  const dark = opts.dark ?? [38, 42, 50];

  // Studio backdrop with a soft vertical falloff.
  for (let y = 0; y < H; y += 1) {
    const t = y / H;
    for (let x = 0; x < W; x += 1) {
      c.set(x, y, [bg[0] - 16 * t, bg[1] - 16 * t, bg[2] - 14 * t]);
    }
  }
  // Contact shadow.
  fillEllipse(c, W * 0.5, H * 0.80, W * 0.34, H * 0.05, [120, 124, 132], 3, 0.35);

  if (kind === 'laptop') {
    const sw = W * 0.62, sh = H * 0.40;
    const sx = (W - sw) / 2, sy = H * 0.20;
    c.rect(sx, sy, sw, sh, dark);                                    // lid
    c.rect(sx + sw * 0.035, sy + sh * 0.07, sw * 0.93, sh * 0.86, [22, 26, 34]); // screen
    // A faint desktop glow, so it does not read as a solid black rectangle.
    for (let y = 0; y < sh * 0.86; y += 1) {
      const t = y / (sh * 0.86);
      for (let x = 0; x < sw * 0.93; x += 1) {
        c.blend(sx + sw * 0.035 + x, sy + sh * 0.07 + y, [64, 96, 140], 0.10 * (1 - t));
      }
    }
    // Base, drawn as a shallow trapezoid.
    const bw = sw * 1.10, bh = H * 0.055;
    for (let y = 0; y < bh; y += 1) {
      const t = y / bh;
      const half = (bw / 2) * (1 - 0.06 * t);
      for (let x = -half; x < half; x += 1) {
        c.set(W / 2 + x, sy + sh + y, [body[0] - 22 * t, body[1] - 22 * t, body[2] - 22 * t]);
      }
    }
    // Trackpad notch.
    c.rect(W / 2 - bw * 0.09, sy + sh + bh * 0.30, bw * 0.18, bh * 0.30, [150, 154, 162]);
  } else if (kind === 'phone') {
    const pw = W * 0.26, ph = H * 0.56;
    const px = (W - pw) / 2, py = H * 0.16;
    c.rect(px, py, pw, ph, dark);
    c.rect(px + pw * 0.06, py + ph * 0.035, pw * 0.88, ph * 0.93, [26, 30, 40]);
    for (let y = 0; y < ph * 0.93; y += 1) {
      const t = y / (ph * 0.93);
      for (let x = 0; x < pw * 0.88; x += 1) {
        c.blend(px + pw * 0.06 + x, py + ph * 0.035 + y, [70, 110, 150], 0.12 * (1 - t));
      }
    }
    fillEllipse(c, W / 2, py + ph * 0.10, pw * 0.045, pw * 0.045, [60, 66, 78], 1.2);
  } else {
    // Headphones: two earcups and a band. Deliberately the most face-like thing
    // in the set - two dark ellipses side by side above a curve.
    const r = Math.min(W, H) * 0.17;
    fillEllipse(c, W * 0.34, H * 0.52, r, r * 1.10, dark, 2);
    fillEllipse(c, W * 0.66, H * 0.52, r, r * 1.10, dark, 2);
    fillEllipse(c, W * 0.34, H * 0.52, r * 0.58, r * 0.66, [58, 62, 72], 2);
    fillEllipse(c, W * 0.66, H * 0.52, r * 0.58, r * 0.66, [58, 62, 72], 2);
    for (let a = Math.PI; a <= Math.PI * 2; a += 0.002) {
      const bx = W * 0.5 + Math.cos(a) * (W * 0.16);
      const by = H * 0.52 + Math.sin(a) * (H * 0.30);
      for (let t = -r * 0.16; t < r * 0.16; t += 1) {
        c.set(bx, by + t, dark);
      }
    }
  }
  return resolve(c, w, h, 2, opts.seed ?? 21);
}

function renderChart(w, h) {
  const W = w * SS, H = h * SS;
  const c = new Surface(W, H);
  c.rect(0, 0, W, H, [250, 250, 251]);
  c.rect(0, 0, W, Math.floor(H * 0.16), [30, 70, 95]);
  const heights = [0.34, 0.58, 0.44, 0.72, 0.52, 0.86, 0.63];
  const pad = W * 0.08;
  const usable = W - pad * 2;
  const bw = usable / (heights.length * 1.55);
  const baseY = H * 0.88;
  heights.forEach((v, i) => {
    const bh = v * (H * 0.6);
    c.rect(Math.floor(pad + i * bw * 1.55), Math.floor(baseY - bh), Math.floor(bw), Math.floor(bh), [52, 122, 158]);
  });
  c.rect(Math.floor(pad), Math.floor(baseY), Math.floor(usable), Math.max(2, Math.floor(H * 0.006)), [60, 60, 70]);
  return resolve(c, w, h, 2, 12);
}

/*
 * An ID card with a DELIBERATELY EMPTY photo slot.
 *
 * A face here would make the result unreadable: the alt text on this one is
 * meant to fire the DOM id-document rule, and nothing else. Flat grey where the
 * photo would be is what keeps the two channels separable.
 */
function renderIdCard(w, h) {
  const W = w * SS, H = h * SS;
  const c = new Surface(W, H);
  c.rect(0, 0, W, H, [232, 236, 240]);
  const cx = Math.floor(W * 0.07), cy = Math.floor(H * 0.12);
  const cw = Math.floor(W * 0.86), ch = Math.floor(H * 0.76);
  c.rect(cx, cy, cw, ch, [252, 252, 250]);
  c.rect(cx, cy, cw, Math.floor(ch * 0.19), [40, 88, 120]);
  c.rect(cx + Math.floor(cw * 0.05), cy + Math.floor(ch * 0.30), Math.floor(cw * 0.26), Math.floor(ch * 0.52), [176, 182, 188]);
  for (let i = 0; i < 5; i += 1) {
    c.rect(
      cx + Math.floor(cw * 0.38),
      cy + Math.floor(ch * (0.31 + i * 0.11)),
      Math.floor(cw * (0.50 - (i % 2) * 0.14)),
      Math.max(2, Math.floor(ch * 0.035)),
      [120, 126, 134],
    );
  }
  return resolve(c, w, h, 2, 13);
}

function renderSignature(w, h) {
  const W = w * SS, H = h * SS;
  const c = new Surface(W, H);
  c.rect(0, 0, W, H, [250, 249, 245]);
  const ink = [28, 42, 96];
  const mid = H * 0.52;
  let px = W * 0.10, py = mid;
  const r = Math.max(1, Math.round(H * 0.018));
  for (let t = 1; t <= 1200; t += 1) {
    const u = t / 1200;
    const x = W * (0.10 + 0.80 * u);
    const y = mid + Math.sin(u * Math.PI * 5.5) * H * 0.20
      + Math.sin(u * Math.PI * 13) * H * 0.06 - u * H * 0.10;
    const steps = Math.ceil(Math.hypot(x - px, y - py));
    for (let s = 0; s <= steps; s += 1) {
      const ix = px + ((x - px) * s) / Math.max(1, steps);
      const iy = py + ((y - py) * s) / Math.max(1, steps);
      for (let oy = -r; oy <= r; oy += 1) {
        for (let ox = -r; ox <= r; ox += 1) {
          if (ox * ox + oy * oy > r * r) continue;
          const bx = Math.round(ix + ox), by = Math.round(iy + oy);
          if (bx >= 0 && by >= 0 && bx < W && by < H) c.set(bx, by, ink);
        }
      }
    }
    px = x; py = y;
  }
  c.rect(Math.floor(W * 0.08), Math.floor(H * 0.80), Math.floor(W * 0.84), Math.max(2, Math.floor(H * 0.012)), [170, 170, 175]);
  return resolve(c, w, h, 2, 14);
}

// ------------------------------------------------------------------------ main

const FACE_SIZE = 360;

/*
 * Three visibly different people, so the section reads as a team page rather
 * than one image repeated, and so detection is not resting on a single set of
 * colours.
 */
const IMAGES = [
  ['portrait-a.png', FACE_SIZE, FACE_SIZE, () => renderFace(FACE_SIZE, FACE_SIZE, { seed: 1 })],
  ['portrait-b.png', FACE_SIZE, FACE_SIZE, () => renderFace(FACE_SIZE, FACE_SIZE, {
    seed: 2, skin: [166, 124, 96], skinShadow: [118, 84, 64],
    hair: [26, 20, 18], shirt: [96, 74, 110], bg: [214, 208, 200], headAspect: 0.78,
  })],
  ['portrait-c.png', FACE_SIZE, FACE_SIZE, () => renderFace(FACE_SIZE, FACE_SIZE, {
    seed: 3, skin: [238, 205, 180], skinShadow: [196, 156, 132],
    hair: [128, 92, 52], shirt: [58, 108, 96], bg: [198, 214, 220], headHeight: 0.62,
  })],
  // Face AND alt text that fires the DOM rule - the "both channels" case.
  ['labelled-portrait.png', FACE_SIZE, FACE_SIZE, () => renderFace(FACE_SIZE, FACE_SIZE, {
    seed: 4, skin: [214, 170, 140], hair: [44, 36, 40], shirt: [110, 84, 70], bg: [222, 218, 210],
  })],
  ['landscape.png', 360, 270, () => renderLandscape(360, 270)],
  /*
   * Product shots for the shop page. Every one is a face-detector CONTROL: a
   * search for "laptop" must surface these and produce zero boxes. The
   * headphones are the adversarial one - two dark ellipses over a curve is the
   * closest thing to a face that a product catalogue contains.
   */
  ['product-laptop.png', 320, 240, () => renderProduct(320, 240, 'laptop', { seed: 31 })],
  ['product-gaming-laptop.png', 320, 240, () => renderProduct(320, 240, 'laptop', {
    seed: 32, body: [92, 96, 108], dark: [24, 26, 32], bg: [232, 234, 240],
  })],
  ['product-phone.png', 320, 240, () => renderProduct(320, 240, 'phone', { seed: 33 })],
  ['product-headphones.png', 320, 240, () => renderProduct(320, 240, 'headphones', { seed: 34 })],
  ['chart.png', 360, 270, () => renderChart(360, 270)],
  ['id-card-scan.png', 360, 270, () => renderIdCard(360, 270)],
  ['signature-sample.png', 360, 170, () => renderSignature(360, 170)],
];

mkdirSync(OUT, { recursive: true });

let total = 0;
for (const [name, w, h, make] of IMAGES) {
  const png = encodePng(make(), w, h);
  writeFileSync(new URL(name, `file://${OUT.replace(/\\/g, '/')}`), png);
  total += png.length;
  process.stdout.write(`${name.padEnd(26)} ${String(w).padStart(3)}x${String(h).padStart(3)}  ${(png.length / 1024).toFixed(1).padStart(7)} KB\n`);
}
process.stdout.write(`${'TOTAL'.padEnd(26)}          ${(total / 1024).toFixed(1).padStart(9)} KB\n`);
process.stdout.write('\nNow verify they are actually detectable:\n  npx tsx test-site/verify-vision.ts\n');
