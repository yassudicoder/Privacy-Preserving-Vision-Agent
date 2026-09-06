// SPIKE. Ugly on purpose. The only question it answers is:
//   how long does a real ViT detector take to load, how long per frame, how much memory,
//   inside an MV3 offscreen document on THIS machine.

import { pipeline, env, RawImage } from './vendor/transformers.min.js';

const MODEL_ID = 'Xenova/yolos-tiny'; // YOLOS = ViT backbone + detection head. Small, real boxes.

// Cold load is network-bound: 116-205 s observed for a 25 MB model on a slow
// link. Give it room, but not forever.
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const FRAME_TIMEOUT_MS = 60 * 1000;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

// ---- network byte tally -------------------------------------------------
// Weights live in a WebAssembly.Memory / GPU buffers, not the JS heap, so
// performance.memory alone under-reports. Count what we actually downloaded.
//
// Two different numbers, and conflating them cost a wrong entry in DECISIONS.md:
//   transferred - every byte that crossed the wire, retries included. What the
//                 user's connection actually pays.
//   unique      - largest response seen per URL. The model's real size.
// A flaky link made these differ by exactly 5x on the first run: one 25 MB file
// fetched five times read as a 125 MB model.
//
// That fix trusted the Content-Length header. transformers.js then warned
//   "Unable to determine content-length from response headers"
// from readResponse(), which is the model-file path. A chunked or streamed
// response carries no Content-Length at all, and every such file was counted as
// ZERO. A tally that silently drops the one file you care about is worse than no
// tally, because it still prints a plausible number.
//
// So: count the bytes as they go past. The response is rewrapped around a
// pull-based counting stream, which buffers nothing. (res.clone() would have
// forced the browser to hold a second copy of a 25 MB file, polluting the memory
// measurement sitting right next to this one.)
//
// What this counts is DECODED bytes -- fetch un-gzips transparently before the
// body is readable -- so it is the file's real size, and it may legitimately
// exceed Content-Length when a response was compressed. That is what "model
// size" should mean here.
let networkBytes = 0;
const uniqueBytes = new Map();
/** url -> how its size was obtained. 'unknown' means the tally is missing it. */
const byteSource = new Map();
const noContentLength = new Set();

const HF_HOST_RE = /huggingface\.co|hf\.co|cdn-lfs/;

function recordBytes(key, bytes, source) {
  if (bytes > 0) {
    networkBytes += bytes;
    uniqueBytes.set(key, Math.max(uniqueBytes.get(key) || 0, bytes));
  }
  byteSource.set(key, source);
}

/** Pass-through stream that counts. Pull-based, so it never runs ahead of the reader. */
function countingBody(body, onDone) {
  const reader = body.getReader();
  let n = 0;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    onDone(n);
  };
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        finish();
        controller.close();
        return;
      }
      n += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

const realFetch = self.fetch.bind(self);
self.fetch = async (...args) => {
  const res = await realFetch(...args);
  let url = '';
  try {
    const first = args[0];
    url = typeof first === 'string' ? first : (first && first.url) || res.url || '';
  } catch {
    /* tally is best-effort */
  }
  if (!HF_HOST_RE.test(url)) return res;

  const key = url.split('?')[0];
  const declared = Number(res.headers.get('content-length') || 0);
  const hasDeclared = Number.isFinite(declared) && declared > 0;
  if (!hasDeclared) noContentLength.add(key);

  // Only 200/206 carry a body worth counting, and new Response() throws if given
  // a body for a null-body status.
  if (!res.body || (res.status !== 200 && res.status !== 206)) {
    recordBytes(key, hasDeclared ? declared : 0, hasDeclared ? 'content-length' : 'unknown');
    return res;
  }

  try {
    const counted = new Response(countingBody(res.body, (n) => recordBytes(key, n, 'stream')), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    // new Response() drops .url. transformers.js does not read it, but a wrapper
    // that quietly changes the object it wraps is how the next bug gets in.
    try {
      Object.defineProperty(counted, 'url', { value: res.url, enumerable: true });
    } catch {
      /* non-configurable in some engines; harmless */
    }
    return counted;
  } catch {
    // Wrapping failed: hand back the untouched response rather than break a load
    // for the sake of a measurement.
    recordBytes(key, hasDeclared ? declared : 0, hasDeclared ? 'content-length' : 'unknown');
    return res;
  }
};

function uniqueBytesTotal() {
  let total = 0;
  for (const v of uniqueBytes.values()) total += v;
  return total;
}

/**
 * Independent cross-check via the Resource Timing API.
 *
 * Sizes are zeroed for cross-origin responses unless the server sends
 * Timing-Allow-Origin, so this corroborates the tally when it is available and
 * says nothing when it is not. It is never the primary number.
 */
function resourceTiming() {
  const files = {};
  let anyNonZero = false;
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (!HF_HOST_RE.test(e.name)) continue;
      const key = e.name.split('?')[0];
      const prev = files[key] || { requests: 0, transferBytes: 0, encodedBytes: 0, decodedBytes: 0 };
      files[key] = {
        requests: prev.requests + 1,
        transferBytes: prev.transferBytes + (e.transferSize || 0),
        encodedBytes: prev.encodedBytes + (e.encodedBodySize || 0),
        decodedBytes: Math.max(prev.decodedBytes, e.decodedBodySize || 0),
      };
      if ((e.transferSize || 0) > 0 || (e.decodedBodySize || 0) > 0) anyNonZero = true;
    }
  } catch {
    /* best-effort */
  }
  return {
    available: anyNonZero,
    reason: anyNonZero ? null : 'sizes zeroed: no Timing-Allow-Origin on these responses',
    files,
  };
}

/** Per-file provenance, so a surprising total can be attributed rather than guessed at. */
function byteAccounting() {
  const files = {};
  for (const key of byteSource.keys()) {
    const bytes = uniqueBytes.get(key) || 0;
    files[key] = {
      bytes,
      mb: round(bytes / 1048576),
      source: byteSource.get(key),
      contentLengthPresent: !noContentLength.has(key),
    };
  }
  const unaccounted = Object.keys(files).filter((k) => files[k].source === 'unknown');
  return {
    files,
    // If anything reads 'unknown', the totals are a floor, not a figure.
    complete: unaccounted.length === 0,
    unaccounted,
    // The condition that broke the previous tally. Non-empty is not an error --
    // it is the case the old code got wrong.
    missingContentLength: [...noContentLength],
  };
}

// ---- memory -------------------------------------------------------------
const round = (n) => Math.round(n * 100) / 100;

function heapMb() {
  const m = performance.memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
}

function startHeapSampler(intervalMs = 50) {
  let peak = heapMb() || 0;
  const base = peak;
  const id = setInterval(() => {
    const now = heapMb();
    if (now !== null && now > peak) peak = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(id);
      const end = heapMb() || 0;
      if (end > peak) peak = end;
      return {
        baselineMb: round(base),
        peakMb: round(peak),
        endMb: round(end),
        deltaMb: round(peak - base),
      };
    },
  };
}

async function detailedMemory() {
  if (!self.crossOriginIsolated || !performance.measureUserAgentSpecificMemory) {
    return { available: false, reason: 'requires crossOriginIsolated' };
  }
  try {
    const r = await performance.measureUserAgentSpecificMemory();
    return { available: true, bytes: r.bytes, mb: round(r.bytes / 1048576) };
  } catch (e) {
    return { available: false, reason: String(e) };
  }
}

// ---- helpers ------------------------------------------------------------
function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    minMs: round(s[0]),
    p50Ms: round(at(50)),
    p95Ms: round(at(95)),
    maxMs: round(s[s.length - 1]),
    meanMs: round(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

function syntheticFrame() {
  const c = document.getElementById('synthetic');
  const g = c.getContext('2d');
  g.fillStyle = '#f4f5f7';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  g.fillRect(340, 120, 600, 560);
  g.strokeStyle = '#c9ced6';
  g.fillStyle = '#111111';
  g.font = '28px sans-serif';
  g.fillText('Sign in to your account', 380, 190);
  g.font = '16px sans-serif';
  const rows = ['Email', 'Password', 'Card number', 'CVV'];
  rows.forEach((label, i) => {
    const y = 240 + i * 90;
    g.fillStyle = '#444444';
    g.fillText(label, 380, y);
    g.fillStyle = '#ffffff';
    g.fillRect(380, y + 12, 520, 44);
    g.strokeRect(380, y + 12, 520, 44);
  });
  g.fillStyle = '#2b6cb0';
  g.fillRect(380, 610, 160, 48);
  g.fillStyle = '#ffffff';
  g.fillText('Submit', 440, 640);
  return c.toDataURL('image/jpeg', 0.8);
}

// ---- progress reporting -------------------------------------------------
// Without this, "downloading 25 MB slowly" and "hung" look identical from the popup.
// Progress is relayed to the service worker (which persists it to storage, so it
// survives the popup closing) and logged to the console, which is where you look
// when the popup itself is the thing misbehaving.

let progressState = { phase: 'idle', files: {}, note: '', startedAt: 0, updatedAt: 0 };
let lastPublishAt = 0;

/**
 * Report progress WITHOUT touching chrome.storage.
 *
 * "The runtime API is the only extensions API supported by offscreen documents."
 * chrome.storage does not exist here, permissions notwithstanding. So progress
 * is relayed to the service worker, which does have storage, and it writes it.
 *
 * Every path is swallowed. Telemetry that can throw is worse than no telemetry:
 * the first version of this masked a load failure with its own TypeError and
 * cost a whole run.
 */
function publishProgress(patch, force) {
  try {
    progressState = Object.assign({}, progressState, patch, { updatedAt: Date.now() });

    // transformers.js fires progress per chunk; throttle so the relay does not
    // become the expensive part of the measurement.
    const now = Date.now();
    if (!force && now - lastPublishAt < 250) return;
    lastPublishAt = now;

    const sent = chrome.runtime.sendMessage({
      target: 'background',
      cmd: 'progress',
      progress: progressState,
    });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    /* progress reporting must never be able to fail the run */
  }
}

function onModelProgress(device, dtype, p) {
  if (!p || typeof p !== 'object') return;
  const files = Object.assign({}, progressState.files);
  if (p.file) {
    files[p.file] = {
      status: p.status,
      loadedMb: typeof p.loaded === 'number' ? round(p.loaded / 1048576) : null,
      totalMb: typeof p.total === 'number' ? round(p.total / 1048576) : null,
      pct: typeof p.progress === 'number' ? Math.round(p.progress) : null,
    };
  }
  publishProgress({ phase: 'loading ' + device + '/' + dtype, files, note: p.status || '' });
  console.log(
    '[spike] progress',
    p.status || '',
    p.file || '',
    typeof p.progress === 'number' ? Math.round(p.progress) + '%' : '',
  );
}

/** Reject rather than hang forever if a load or a forward pass wedges. */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timed out after ' + ms + ' ms during: ' + label));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// ---- the actual probe ---------------------------------------------------
let cached = { key: null, detector: null, loadMs: 0 };

async function gpuInfo() {
  if (!('gpu' in navigator)) return { webgpu: false, reason: 'navigator.gpu missing' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { webgpu: false, reason: 'requestAdapter() returned null' };
    const info = adapter.info || {};
    return {
      webgpu: true,
      vendor: info.vendor || 'unknown',
      architecture: info.architecture || 'unknown',
      maxBufferSize: (adapter.limits && adapter.limits.maxBufferSize) || null,
    };
  } catch (e) {
    return { webgpu: false, reason: String(e) };
  }
}

async function loadDetector(device, dtype) {
  const key = device + ':' + dtype;
  if (cached.key === key && cached.detector) {
    return { detector: cached.detector, loadMs: cached.loadMs, reused: true };
  }
  const t0 = performance.now();
  publishProgress({ phase: 'loading ' + device + '/' + dtype, files: {}, startedAt: Date.now() }, true);
  const detector = await withTimeout(
    pipeline('object-detection', MODEL_ID, {
      device,
      dtype,
      progress_callback: (p) => onModelProgress(device, dtype, p),
    }),
    LOAD_TIMEOUT_MS,
    'pipeline() load',
  );
  const loadMs = performance.now() - t0;
  cached = { key, detector, loadMs };
  return { detector, loadMs, reused: false };
}

async function bench(msg) {
  const frame = msg.frame;
  const opts = msg.opts || {};
  const frames = Math.max(1, Number(opts.frames || 10));
  const warmup = Math.max(0, Number(opts.warmup === undefined ? 2 : opts.warmup));
  const requested = opts.device || 'auto';
  const dtype = opts.dtype || 'fp32';

  const gpu = await gpuInfo();
  const order = requested === 'auto' ? (gpu.webgpu ? ['webgpu', 'wasm'] : ['wasm']) : [requested];

  const dataUrl = (frame && frame.dataUrl) || syntheticFrame();
  const sampler = startHeapSampler();
  const bytesBefore = networkBytes;

  let lastError = null;
  for (const device of order) {
    try {
      const { detector, loadMs, reused } = await loadDetector(device, dtype);

      const decode = [];
      const infer = [];
      let lastBoxes = 0;

      for (let i = 0; i < warmup + frames; i++) {
        const d0 = performance.now();
        const img = await RawImage.fromURL(dataUrl);
        const d1 = performance.now();
        const out = await withTimeout(detector(img, { threshold: 0.5 }), FRAME_TIMEOUT_MS, 'forward pass');
        const d2 = performance.now();
        publishProgress({
          phase: i < warmup ? 'warmup' : 'measuring',
          note: 'frame ' + (i + 1) + '/' + (warmup + frames),
        });
        if (i >= warmup) {
          decode.push(d1 - d0);
          infer.push(d2 - d1);
        }
        lastBoxes = Array.isArray(out) ? out.length : 0;
      }

      const mem = sampler.stop();
      const accounting = byteAccounting();
      publishProgress({ phase: 'done', note: '' }, true);
      return {
        ok: true,
        machine: {
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency || null,
          deviceMemoryGb: navigator.deviceMemory || null,
          crossOriginIsolated: self.crossOriginIsolated,
          wasmThreads: env.backends.onnx.wasm.numThreads,
        },
        model: { id: MODEL_ID, device, dtype, reusedFromCache: reused },
        gpu,
        load: { loadMs: round(loadMs), coldStart: !reused },
        perFrame: {
          decode: stats(decode),
          inference: stats(infer),
          total: stats(decode.map((d, i) => d + infer[i])),
        },
        // Pass the capture block straight through. The previous version picked
        // three fields by hand and silently dropped the repeated-sample data
        // that background.js had gone to the trouble of collecting.
        capture: Object.assign({ source: 'synthetic', captureMs: 0, error: null }, frame || {}, {
          dataUrl: undefined,
        }),
        memory: {
          jsHeap: mem,
          // Per-file breakdown from the loader's own progress events.
          filesLoaded: progressState.files,
          // Bytes that crossed the wire, retries included.
          modelBytesTransferred: networkBytes - bytesBefore,
          modelMbTransferred: round((networkBytes - bytesBefore) / 1048576),
          // Largest response per URL: the model's actual size.
          modelBytesUnique: uniqueBytesTotal(),
          modelMbUnique: round(uniqueBytesTotal() / 1048576),
          // Where each of those bytes came from, and whether any file is missing
          // from the tally. Read this before quoting the totals.
          byteAccounting: accounting,
          resourceTiming: resourceTiming(),
          detailed: await detailedMemory(),
          warnings: accounting.complete
            ? []
            : [
                'byte tally incomplete for: ' +
                  accounting.unaccounted.join(', ') +
                  ' - totals are a FLOOR, not a measurement',
              ],
          note:
            'jsHeap excludes WebAssembly.Memory and GPU buffers. modelMbUnique is the model size, counted as decoded ' +
            'bytes off the response body rather than read from Content-Length (absent on chunked responses). ' +
            'modelMbTransferred includes retries. A warm run served from the Cache API never calls fetch, so both read 0.',
        },
        detections: lastBoxes,
      };
    } catch (err) {
      lastError = { device, error: String(err && err.stack ? err.stack : err) };
    }
  }

  sampler.stop();
  publishProgress({ phase: 'failed', note: lastError ? lastError.error : 'unknown' }, true);
  return { ok: false, error: 'all backends failed', lastError, gpu };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.cmd !== 'bench') return false;
  bench(msg)
    .then((r) => {
      console.log('[spike] result', r);
      sendResponse(r);
    })
    .catch((e) => sendResponse({ ok: false, error: String(e && e.stack ? e.stack : e) }));
  return true;
});

console.log('[spike] offscreen ready; wasmPaths =', env.backends.onnx.wasm.wasmPaths);
