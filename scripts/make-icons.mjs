/**
 * Generates public/icon-{16,32,48,128}.png.
 *
 * Committed rather than run at build time: WXT copies public/ verbatim and
 * discovers the top-level `icons` manifest key from the filenames, so the PNGs
 * have to exist on disk before `wxt build` runs. Run this only when the mark
 * changes; commit the four files it emits.
 *
 * WHERE THE FILES GO. `public/` at the REPO ROOT, a sibling of src/ -- NOT
 * src/public/, despite srcDir: 'src'. WXT resolves publicDir relative to root
 * (`path.resolve(root, publicDir ?? 'public')`) while entrypointsDir resolves
 * relative to srcDir. Files under src/public/ are silently ignored: not copied,
 * not warned about, and the `icons` key simply never appears.
 *
 * PNG only. Chrome: "WebP and SVG files are not supported." Firefox accepts SVG
 * but the point is one source for both.
 *
 * Zero dependencies -- a minimal 8-bit RGBA encoder over node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x1e, 0x40, 0x6f];
const FG = [0xe8, 0xf0, 0xfb];
const PUPIL = [0x1e, 0x40, 0x6f];

/** An eye behind a redaction bar: what the extension does, in one mark. */
function sample(u, v) {
  // rounded square
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];

  // the eye: intersection of two circles, the classic lens shape
  const inLens =
    Math.hypot(u - 0.5, v - 0.16) < 0.52 && Math.hypot(u - 0.5, v - 0.84) < 0.52;
  const inBar = Math.abs(v - 0.5) < 0.085 && u > 0.13 && u < 0.87;

  if (inBar) return [...FG, 255];
  if (inLens) {
    if (Math.hypot(u - 0.5, v - 0.5) < 0.14) return [...PUPIL, 255];
    return [...FG, 255];
  }
  return [...BG, 255];
}

const SS = 4; // supersampling factor, for antialiased edges

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = sample(
            (x + (sx + 0.5) / SS) / size,
            (y + (sy + 0.5) / SS) / size,
          );
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a === 0 ? 0 : Math.round(r / a);
      out[o + 1] = a === 0 ? 0 : Math.round(g / a);
      out[o + 2] = a === 0 ? 0 : Math.round(b / a);
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });
let total = 0;
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size));
  writeFileSync(resolve(OUT, `icon-${size}.png`), png);
  total += png.length;
  console.log(`public/icon-${size}.png  ${png.length} B`);
}
console.log(`total ${total} B`);
