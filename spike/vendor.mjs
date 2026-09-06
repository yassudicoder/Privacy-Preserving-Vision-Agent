// Copies the transformers.js browser bundle + ORT wasm binaries into spike/vendor/.
// MV3 forbids remote CODE, so the library has to be local. Model WEIGHTS are data
// and are still fetched from huggingface.co at runtime (see host_permissions).
import { readdir, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'node_modules', '@huggingface', 'transformers', 'dist');
const out = join(here, 'vendor');

try {
  await stat(dist);
} catch {
  console.error(`[vendor] ${dist} not found. Run "npm install" inside spike/ first.`);
  process.exit(1);
}

await mkdir(out, { recursive: true });
const files = await readdir(dist);
// .node.* builds are for Node/onnxruntime-node and are dead weight in an extension.
const keep = files.filter(
  (f) => /\.(js|mjs|wasm)$/.test(f) && !f.endsWith('.map') && !f.includes('.node.'),
);

for (const f of keep) {
  await copyFile(join(dist, f), join(out, f));
}

const bundle = keep.find((f) => f === 'transformers.min.js') ?? keep.find((f) => f === 'transformers.js');
const wasms = keep.filter((f) => f.endsWith('.wasm'));

console.log(`[vendor] copied ${keep.length} file(s) -> spike/vendor/`);
console.log(`[vendor] bundle: ${bundle ?? 'NOT FOUND - check dist/ layout'}`);
console.log(`[vendor] wasm:   ${wasms.length ? wasms.join(', ') : 'NONE FOUND - wasm backend will fail'}`);
if (!bundle || wasms.length === 0) process.exit(1);
