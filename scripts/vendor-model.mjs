// @ts-check
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Puts the model and the wasm runtime into `public/` so the extension can load
 * them off disk.
 *
 * WHY THIS IS A BUILD STEP AND NOT COMMITTED BYTES. It is ~46 MB - 25 MB of
 * weights and ~21 MB of ORT wasm. Committing that would make every clone,
 * every branch and every diff carry binaries that npm can reproduce exactly.
 * `public/models/` and `public/wasm/` are gitignored; this script is the record
 * of what belongs there.
 *
 * WHY THE EXTENSION LOADS LOCALLY AT ALL. `spike/` measured a cold load of
 * 116-202 s against the HuggingFace hub for a 25 MB file. That is network
 * latency, not compute. Serving the same bytes from the extension package turns
 * a multi-minute first run into a local read, and `allowRemoteModels = false` in
 * transformers-env.ts means a missing file fails loudly instead of silently
 * reaching across the network from a privacy extension.
 *
 *   node scripts/vendor-model.mjs [--model Xenova/yolos-tiny]
 */

const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');

/**
 * The model this project ships.
 *
 * Exported so the contract default and the vendored weights cannot drift apart
 * - that drift is exactly what shipped a `modelId` of 'stub' against a package
 * containing Xenova/yolos-tiny.
 */
export const DEFAULT_MODEL_ID = 'opencv/face_detection_yunet';

const args = process.argv.slice(2);
const modelId = args.includes('--model')
  ? (args[args.indexOf('--model') + 1] ?? DEFAULT_MODEL_ID)
  : DEFAULT_MODEL_ID;

/**
 * What to fetch, and where it lands.
 *
 * YuNet ships a single .onnx and NEITHER `config.json` nor
 * `preprocessor_config.json` - it is not a transformers.js model and cannot be
 * loaded by that library at all (it dispatches object-detection to seven
 * architectures and YuNet is none of them). `YunetBackend` drives the ONNX
 * session directly instead.
 *
 * The weights land at `onnx/model.onnx` rather than under their upstream
 * filename so the single-.onnx assertions in `tests/built/bundle.test.ts` and
 * the two-path probe in `measurePackagedWeights` keep working unchanged.
 */
const REMOTE_TO_LOCAL = Object.freeze({
  'face_detection_yunet_2023mar.onnx': 'onnx/model.onnx',
});

/** Local paths, which is what the bundle test asserts are present. */
const MODEL_FILES = Object.values(REMOTE_TO_LOCAL);

/**
 * ORT's wasm binaries.
 *
 * `.jsep.` is the WebGPU-capable build - without it `device: 'webgpu'` throws
 * and the backend silently falls back to wasm, which the spike measured as the
 * difference between ~230 ms and several seconds per frame. The plain build is
 * the fallback path, so both ship.
 */
const WASM_FILES = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

function human(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Downloads one file, counting the bytes that actually arrive.
 *
 * NOT from `Content-Length`. Run 3 of the spike caught `config.json` coming back
 * without that header, which the original header-based tally scored as zero
 * bytes and dropped from the total silently. Counting the stream is the only
 * figure that cannot be wrong in that direction.
 */
async function download(url, dest, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  await mkdir(dirname(dest), { recursive: true });

  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    if (res.body === null) throw new Error('empty body');
  } catch (err) {
    // The hub redirects large files to a CDN, and the connection drops often
    // enough on a 25 MB body that one attempt is not a real download step.
    // Retrying from scratch rather than resuming: a partial file that looks
    // complete is worse than a slow retry, and the byte check below only
    // catches truncation when the whole file went through one counter.
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.stdout.write(`retry ${attempt} ... `);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return download(url, dest, attempt + 1);
  }

  let bytes = 0;
  const counted = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(
      // @ts-expect-error - Node's Readable.fromWeb accepts a web ReadableStream
      Readable.fromWeb(res.body.pipeThrough(counted)),
      createWriteStream(dest),
    );
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(
        `${url} died after ${bytes} bytes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.stdout.write(`retry ${attempt} (died at ${human(bytes)}) ... `);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return download(url, dest, attempt + 1);
  }

  // Cross-check against what actually landed on disk. Two independent numbers,
  // the same standard the spike settled on after the byte tally was wrong twice.
  const onDisk = (await stat(dest)).size;
  if (onDisk !== bytes) {
    throw new Error(`${dest}: counted ${bytes} bytes but wrote ${onDisk}`);
  }
  return bytes;
}

async function main() {
  const modelDir = join(PUBLIC, 'models', ...modelId.split('/'));
  const wasmDir = join(PUBLIC, 'wasm');

  console.log(`vendoring ${modelId}`);
  await rm(modelDir, { recursive: true, force: true });
  await mkdir(wasmDir, { recursive: true });

  const manifest = { modelId, files: {}, totalBytes: 0 };

  for (const [remote, local] of Object.entries(REMOTE_TO_LOCAL)) {
    const url = `https://huggingface.co/${modelId}/resolve/main/${remote}`;
    const dest = join(modelDir, ...local.split('/'));
    process.stdout.write(`  ${remote} -> ${local} ... `);
    const bytes = await download(url, dest);
    manifest.files[local] = bytes;
    manifest.totalBytes += bytes;
    console.log(human(bytes));
  }

  const ortDist = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  for (const file of WASM_FILES) {
    const src = join(ortDist, file);
    try {
      await copyFile(src, join(wasmDir, file));
      const bytes = (await stat(join(wasmDir, file))).size;
      manifest.files[`wasm/${file}`] = bytes;
      manifest.totalBytes += bytes;
      console.log(`  wasm/${file} ... ${human(bytes)}`);
    } catch {
      // Named, not swallowed. A missing jsep build means no WebGPU, which shows
      // up much later as an unexplained order-of-magnitude latency regression.
      console.warn(`  wasm/${file} ... MISSING (${src})`);
    }
  }

  await writeFile(
    join(PUBLIC, 'models', 'vendored.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  console.log(`\ntotal ${human(manifest.totalBytes)} into public/`);
  console.log('recorded in public/models/vendored.json');
}

/*
 * Only when run directly. `tests/built/bundle.test.ts` imports MODEL_FILES and
 * WASM_FILES from here so there is ONE list of what the package must contain -
 * a second copy in the test would drift, and the drift would look like a
 * passing test right up until the extension could not find its weights.
 */
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { MODEL_FILES, REMOTE_TO_LOCAL, WASM_FILES };
