/**
 * Verifies the byte tally in offscreen.js against the case that broke it.
 *
 * `node spike/verify-tally.mjs`
 *
 * The previous tally read Content-Length and skipped anything without it, so a
 * chunked response counted as zero bytes and vanished from the total silently.
 * Re-running the spike to find out whether the fix works costs minutes and a
 * 25 MB download; this costs nothing, so it happens first.
 *
 * It pulls the function source out of offscreen.js rather than re-implementing
 * it, so this cannot drift into testing a copy of the code that no longer
 * matches what actually runs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'offscreen.js'), 'utf8');

/** Lift a top-level `function name(...) { ... }` out of the source by brace matching. */
function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in offscreen.js`);
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < SOURCE.length; i++) {
    const ch = SOURCE[i];
    if (ch === '{') {
      depth++;
      seenBrace = true;
    } else if (ch === '}') {
      depth--;
      if (seenBrace && depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const countingBody = eval(`(${extractFunction('countingBody')})`);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  expected ${expected}, got ${actual}`}`);
}

function bodyOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) controller.close();
      else controller.enqueue(chunks[i++]);
    },
  });
}

// A 25 MB-ish file delivered in chunks, exactly like a response with no
// Content-Length: the shape the old tally scored as 0.
const CHUNK = 64 * 1024;
const COUNT = 400;
const EXPECTED = CHUNK * COUNT;
const chunks = Array.from({ length: COUNT }, () => new Uint8Array(CHUNK));

// --- 1. bytes are counted, and the payload survives the wrapper untouched ---
{
  let counted = -1;
  const res = new Response(bodyOf(chunks), {
    status: 200,
    headers: new Headers({ 'content-type': 'application/octet-stream' }), // no content-length
  });
  check('response really has no Content-Length', res.headers.get('content-length'), null);

  const wrapped = new Response(
    countingBody(res.body, (n) => {
      counted = n;
    }),
    { status: res.status, statusText: res.statusText, headers: res.headers },
  );

  const received = new Uint8Array(await wrapped.arrayBuffer());
  check('body passes through byte-for-byte', received.byteLength, EXPECTED);
  check('counted the bytes off the stream', counted, EXPECTED);
}

// --- 2. peak memory: the stream must not buffer the whole file -------------
// res.clone() would hold a second full copy. The point of the pull-based stream
// is that it does not, and this measurement sits next to a memory measurement.
{
  let counted = 0;
  const res = new Response(bodyOf(chunks), { status: 200 });
  const stream = countingBody(res.body, (n) => {
    counted = n;
  });
  const reader = stream.getReader();
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    const now = process.memoryUsage().heapUsed;
    if (now > peak) peak = now;
  }
  const grewMb = (peak - before) / 1048576;
  check('drained the whole body', read, EXPECTED);
  check('counted while draining', counted, EXPECTED);
  const bounded = grewMb < EXPECTED / 1048576 / 2;
  if (!bounded) failures++;
  console.log(
    `${bounded ? 'PASS' : 'FAIL'}  heap growth stayed well under one full copy ` +
      `(${grewMb.toFixed(1)} MB vs ${(EXPECTED / 1048576).toFixed(1)} MB payload)`,
  );
}

// --- 3. a cancelled download still reports what it got ---------------------
// A load that fails partway is exactly when you want to know how far it got.
{
  let counted = -1;
  const res = new Response(bodyOf(chunks), { status: 200 });
  const reader = countingBody(res.body, (n) => {
    counted = n;
  }).getReader();
  await reader.read();
  await reader.read();
  await reader.cancel('aborted');
  check('partial read reports bytes received', counted, CHUNK * 2);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
