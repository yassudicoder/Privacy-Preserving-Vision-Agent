/*
 * Does YuNet actually see the faces on vision.html?
 *
 *   npx tsx test-site/verify-vision.ts
 *   npx tsx test-site/verify-vision.ts path/to/your-photo.jpg   (score one file)
 *
 * This is the FIRST REAL FORWARD PASS through YunetBackend anywhere in the
 * project. Every test under tests/perception/ injects a fake session and feeds
 * it a zero-filled Uint8Array, so nothing else here has ever loaded the actual
 * 232,589 bytes of weights.
 *
 * It uses the SHIPPED code, not a reimplementation: `createYunetBackend`,
 * `letterboxImage`, `undoLetterbox` and `decodeDetections` are the same
 * functions the offscreen worker calls, and the ORT build is the one in
 * public/wasm that goes into the extension package. A number printed here means
 * what the same number would mean in the browser.
 *
 * WHAT IT CANNOT TELL YOU. That the model runs in a BROWSER. This is Node with
 * the browser's wasm, which is the project's standing caveat on every YuNet
 * figure. It rules out "the weights are wrong" and "the images have no
 * detectable face", so that a browser run failing means something about the
 * browser.
 *
 * Not part of `npm test`: tsconfig.json does not include test-site/**, and
 * vitest only collects tests/ ** / *.test.ts.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import {
  DEFAULT_ENGINE_CONFIG,
  type RgbaImage,
  type ViewportInfo,
} from '@/contracts/index.ts';
import {
  createYunetBackend,
  decodeDetections,
  letterboxImage,
  ortApiFrom,
  undoLetterbox,
  type OrtModule,
} from '@/perception/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IMAGES = fileURLToPath(new URL('./images/', import.meta.url));

const require = createRequire(import.meta.url);
// sharp arrives with @huggingface/transformers rather than as a declared
// dependency, so say so plainly if it has been pruned away.
let sharp: (input: string | Buffer) => {
  ensureAlpha: () => { raw: () => { toBuffer: (o: { resolveWithObject: true }) => Promise<{ data: Buffer; info: { width: number; height: number } }> } };
  jpeg: (o: { quality: number }) => { toBuffer: () => Promise<Buffer> };
  resize: (w: number, h: number, o?: unknown) => ReturnType<typeof sharp>;
};
try {
  sharp = require('sharp') as typeof sharp;
} catch {
  process.stderr.write(
    'sharp is not installed. It normally arrives with @huggingface/transformers;\n' +
      'run `npm install` to restore it.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------- the backend

/*
 * `createPackagedYunetFactory` cannot be used here: it calls fetch() on an
 * extension URL, and Node's fetch rejects file:. `createYunetBackend` takes an
 * injected `fetchWeights` for exactly this reason.
 */
async function makeBackend(): Promise<Awaited<ReturnType<typeof createYunetBackend>>> {
  const ortNs = (await import('onnxruntime-web')) as unknown as { default?: OrtModule };
  const ort = (ortNs.default ?? (ortNs as unknown as OrtModule));

  ort.env.wasm.numThreads = 1;
  // MUST be a file:// URL. A bare Windows path fails with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'c:'.
  ort.env.wasm.wasmPaths = pathToFileURL(`${ROOT}public/wasm/`).href;

  return createYunetBackend({
    config: { ...DEFAULT_ENGINE_CONFIG, preferredBackend: 'wasm' },
    api: ortApiFrom(ort),
    fetchWeights: async (modelId) => {
      const path = `${ROOT}public/models/${modelId}/onnx/model.onnx`;
      if (!existsSync(path)) {
        throw new Error(`weights missing at ${path} - run "npm run vendor:model"`);
      }
      return new Uint8Array(await readFile(path));
    },
  });
}

async function rgbaOf(input: string | Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}

interface Scored {
  readonly count: number;
  readonly top: number | null;
  readonly ms: number;
}

async function score(
  backend: Awaited<ReturnType<typeof createYunetBackend>>,
  img: RgbaImage,
): Promise<Scored> {
  const input = letterboxImage(img, backend.inputSize);
  const t0 = performance.now();
  const boxes = await backend.infer(input);
  const ms = performance.now() - t0;

  const viewport: ViewportInfo = {
    cssWidth: img.width,
    cssHeight: img.height,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
  };

  const dets = decodeDetections(
    boxes.map((b) => ({ ...b, rect: undoLetterbox(b.rect, input.pad, input.scale) })),
    {
      viewport,
      scoreThreshold: DEFAULT_ENGINE_CONFIG.scoreThreshold,
      nmsIou: DEFAULT_ENGINE_CONFIG.nmsIou,
      salt: 'verify-vision',
    },
  );

  const top = dets.length === 0 ? null : Math.max(...dets.map((d) => d.confidence));
  return { count: dets.length, top, ms };
}

// ------------------------------------------------------------------- expected

/**
 * What each shipped image is FOR.
 *
 * `faces` is the number YuNet must find. The controls expect 0 - without them a
 * positive result proves nothing, because a detector that fires on everything
 * would also "find" the portraits.
 */
const EXPECTED: readonly { file: string; faces: number; why: string }[] = [
  { file: 'portrait-a.png', faces: 1, why: 'neutral alt text: a face here can only be vision' },
  { file: 'portrait-b.png', faces: 1, why: 'darker skin, different hair' },
  { file: 'portrait-c.png', faces: 1, why: 'smaller head in frame' },
  { file: 'labelled-portrait.png', faces: 1, why: 'face AND alt text that fires the DOM rule' },
  { file: 'landscape.png', faces: 0, why: 'control - any detection is a false positive' },
  { file: 'chart.png', faces: 0, why: 'control - hard edges, no face' },
  { file: 'id-card-scan.png', faces: 0, why: 'photo slot deliberately blank; alt fires the DOM rule' },
  { file: 'signature-sample.png', faces: 0, why: 'control - alt fires the DOM signature rule' },
];

// ----------------------------------------------------------------------- main

const backend = await makeBackend();

process.stdout.write(
  `backend      ${backend.backend}\n` +
    `modelId      ${backend.modelId}\n` +
    // Not toLocaleString: this machine's locale groups Indian-style, which
    // renders 232,589 as "2,32,589" and reads like a different number.
    `weights      ${String(backend.weightBytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} bytes\n` +
    `input        ${backend.inputSize}x${backend.inputSize} (fixed by the graph)\n` +
    `thresholds   score>=${DEFAULT_ENGINE_CONFIG.scoreThreshold}, nms=${DEFAULT_ENGINE_CONFIG.nmsIou}, ` +
    `redact minConfidence=0.5\n\n`,
);

const oneOff = process.argv[2];
let failures = 0;

if (oneOff !== undefined) {
  // Single-file mode, for a photo you dropped in yourself.
  const img = await rgbaOf(oneOff);
  const s = await score(backend, img);
  process.stdout.write(
    `${oneOff}\n  ${img.width}x${img.height}  faces=${s.count}  ` +
      `top=${s.top === null ? '-' : s.top.toFixed(3)}  ${s.ms.toFixed(1)} ms\n`,
  );
  if (s.top !== null && s.top < 0.5) {
    process.stdout.write('  WARNING: below the 0.5 redaction gate. Detected, but never redacted.\n');
  }
  await backend.dispose();
  process.exit(0);
}

process.stdout.write('=== Each image on its own ===\n');
for (const e of EXPECTED) {
  const path = `${IMAGES}${e.file}`;
  const s = await score(backend, await rgbaOf(path));
  const ok = s.count === e.faces;
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${e.file.padEnd(24)} faces=${s.count} (want ${e.faces})  ` +
      `top=${s.top === null ? '   -  ' : s.top.toFixed(3)}  ${s.ms.toFixed(0).padStart(3)} ms\n` +
      `      ${e.why}\n`,
  );
  // A face that scores under 0.5 is detected, counted, and then dropped by
  // redact()'s minConfidence - present in the stats, absent from the table.
  if (e.faces > 0 && s.top !== null && s.top < 0.5) {
    failures += 1;
    process.stdout.write('      FAIL: under the 0.5 redaction gate - would never reach the panel table\n');
  }
}

// ------------------------------------------- the measurement that actually counts

/*
 * The browser does not hand YuNet a clean PNG. It captures the VIEWPORT as JPEG
 * quality 80 (CAPTURE_DEFAULTS in perception/capture.ts), and the whole frame -
 * not the image - is then letterboxed into 640x640. A 360px portrait inside a
 * 1280px viewport is therefore about 180 model pixels, after a lossy round trip.
 *
 * Note the device pixel ratio cancels: the capture is dpr times larger, and the
 * letterbox scale is 640/(cssWidth*dpr), so a CSS pixel maps to 640/cssWidth
 * model pixels whatever the dpr is.
 */
async function simulateViewport(vw: number, vh: number, tile: number): Promise<Scored> {
  const cols = Math.max(1, Math.floor((vw - 40) / (tile + 20)));
  const page = Buffer.alloc(vw * vh * 3, 244);

  const faces = ['portrait-a.png', 'portrait-b.png', 'portrait-c.png', 'labelled-portrait.png'];
  for (let i = 0; i < faces.length; i += 1) {
    const { data, info } = await sharp(`${IMAGES}${faces[i]}`)
      .resize(tile, tile)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const dx = 20 + (i % cols) * (tile + 20);
    const dy = 120 + Math.floor(i / cols) * (tile + 20);
    for (let y = 0; y < info.height; y += 1) {
      const ty = dy + y;
      if (ty < 0 || ty >= vh) continue;
      for (let x = 0; x < info.width; x += 1) {
        const tx = dx + x;
        if (tx < 0 || tx >= vw) continue;
        const s = (y * info.width + x) * 4;
        const d = (ty * vw + tx) * 3;
        page[d] = data[s] ?? 0;
        page[d + 1] = data[s + 1] ?? 0;
        page[d + 2] = data[s + 2] ?? 0;
      }
    }
  }

  const jpeg = await sharp(page, { raw: { width: vw, height: vh, channels: 3 } } as never)
    .jpeg({ quality: 80 })
    .toBuffer();

  return score(backend, await rgbaOf(jpeg));
}

process.stdout.write('\n=== Simulated capture: 4 portraits in a viewport, JPEG q80 ===\n');
for (const [vw, vh, tile] of [
  [1280, 800, 220],
  [1280, 800, 180],
  [1440, 900, 220],
  [1920, 1080, 220],
] as const) {
  const s = await simulateViewport(vw, vh, tile);
  const modelPx = ((tile * 640) / Math.max(vw, vh)).toFixed(0);
  const ok = s.count === 4;
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${vw}x${vh} @ ${tile}px tiles (~${modelPx}px in model space)  ` +
      `faces=${s.count}/4  top=${s.top === null ? '-' : s.top.toFixed(3)}  ${s.ms.toFixed(0)} ms\n`,
  );
}

await backend.dispose();

process.stdout.write(
  failures === 0
    ? '\nYuNet sees every planted face and none of the controls.\n'
    : `\n${String(failures)} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
