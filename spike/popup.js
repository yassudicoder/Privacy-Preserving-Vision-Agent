const out = document.getElementById('out');
const say = (v) => {
  out.value = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

function summarise(r) {
  if (!r || !r.ok) return JSON.stringify(r, null, 2);
  const L = [];
  L.push('MODEL      ' + r.model.id + '  device=' + r.model.device + ' dtype=' + r.model.dtype);
  L.push('GPU        ' + (r.gpu.webgpu ? r.gpu.vendor + ' / ' + r.gpu.architecture : 'unavailable: ' + r.gpu.reason));
  L.push('LOAD       ' + r.load.loadMs + ' ms  (cold=' + r.load.coldStart + ')');
  L.push('WEIGHTS    ' + r.memory.modelMbUnique + ' MB model' +
    (r.memory.modelMbTransferred > r.memory.modelMbUnique
      ? '  (' + r.memory.modelMbTransferred + ' MB transferred - retries)'
      : ''));
  const files = Object.entries(r.memory.filesLoaded || {});
  for (const [name, f] of files) {
    if (f.totalMb) L.push('             ' + name.padEnd(34) + f.totalMb + ' MB');
  }
  if (r.perFrame.total) {
    L.push('PER FRAME  p50=' + r.perFrame.total.p50Ms + ' ms  p95=' + r.perFrame.total.p95Ms + ' ms  (n=' + r.perFrame.total.n + ')');
    L.push('  decode   p50=' + r.perFrame.decode.p50Ms + ' ms');
    L.push('  infer    p50=' + r.perFrame.inference.p50Ms + ' ms');
  }
  L.push('JS HEAP    baseline=' + r.memory.jsHeap.baselineMb + ' MB  peak=' + r.memory.jsHeap.peakMb + ' MB  delta=' + r.memory.jsHeap.deltaMb + ' MB');
  L.push('CAPTURE    ' + r.capture.source + (r.capture.error ? ' (' + r.capture.error + ')' : ''));
  if (r.capture.samples && r.capture.samples.length) {
    L.push('  cold     ' + r.capture.coldMs + ' ms');
    L.push('  warm p50 ' + r.capture.warmP50Ms + ' ms   (quota: ' + r.capture.quotaPerSecond + '/sec = 500 ms floor per step)');
    L.push('  samples  ' + r.capture.samples.join(', ') + ' ms');
  }
  L.push('BOXES      ' + r.detections);
  L.push('THREADS    wasm=' + r.machine.wasmThreads + ' cores=' + r.machine.hardwareConcurrency + ' coi=' + r.machine.crossOriginIsolated);
  L.push('');
  L.push(JSON.stringify(r, null, 2));
  return L.join('\n');
}

// The popup can be closed and reopened mid-run, so live status is polled from
// storage rather than pushed. The background also writes the final result there,
// which is what makes closing the popup mid-run harmless.
let pollTimer = null;

function renderProgress(p) {
  if (!p) return;
  const lines = [];
  const elapsed = p.startedAt ? Math.round((Date.now() - p.startedAt) / 1000) : 0;
  lines.push('PHASE   ' + p.phase + (elapsed ? '  (' + elapsed + 's elapsed)' : ''));
  if (p.note) lines.push('STATUS  ' + p.note);
  const files = Object.entries(p.files || {});
  if (files.length) {
    lines.push('');
    lines.push('FILES');
    for (const [name, f] of files) {
      const size = f.totalMb ? f.loadedMb + ' / ' + f.totalMb + ' MB' : '';
      const pct = f.pct === null || f.pct === undefined ? '' : ' ' + f.pct + '%';
      lines.push('  ' + name.padEnd(34) + (f.status || '').padEnd(10) + size + pct);
    }
    const total = files.reduce((acc, [, f]) => acc + (f.totalMb || 0), 0);
    if (total) lines.push('  ' + 'TOTAL'.padEnd(34) + ''.padEnd(10) + Math.round(total) + ' MB');
  }
  lines.push('');
  lines.push('Downloading happens once; the browser cache keeps it.');
  lines.push('Full log: chrome://extensions -> Inspect views: offscreen.html');
  say(lines.join('\n'));
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    chrome.storage.local.get('spikeProgress').then(({ spikeProgress }) => {
      if (spikeProgress && spikeProgress.phase !== 'done') renderProgress(spikeProgress);
    });
  }, 400);
}

function stopPolling() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
}

document.getElementById('run').addEventListener('click', async () => {
  say('starting...');
  const opts = {
    device: document.getElementById('device').value,
    dtype: document.getElementById('dtype').value,
    frames: Number(document.getElementById('frames').value),
    warmup: 2,
  };
  startPolling();
  try {
    const r = await chrome.runtime.sendMessage({ target: 'background', cmd: 'run', opts });
    stopPolling();
    say(summarise(r));
    console.log('[spike]', r);
  } catch (e) {
    stopPolling();
    // Closing the popup mid-run lands here, but the result is still in storage.
    say('popup lost the response: ' + String(e) + '\nReopen the popup - the result is saved.');
  }
});

document.getElementById('reset').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ target: 'background', cmd: 'reset' });
  say(r);
});

document.getElementById('clearcache').addEventListener('click', async () => {
  const names = await caches.keys();
  for (const n of names) await caches.delete(n);
  say('cleared caches: ' + JSON.stringify(names) + '\nAlso tear down offscreen, then Run for a true cold number.');
});

document.getElementById('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(out.value);
});

chrome.storage.local.get('lastResult').then(({ lastResult }) => {
  if (lastResult) say(summarise(lastResult));
});
