// SPIKE service worker. No DOM, no canvas here -- it only orchestrates:
//   popup -> background (capture visible tab) -> offscreen document (model) -> back.
// This is the exact topology the real extension will use on Chrome.

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen() {
  // chrome.offscreen.hasDocument() is Chrome 150+. getContexts() is Chrome 116+.
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  return false;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Runs an ONNX vision model; needs a DOM/WebGPU context that the service worker does not have.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Capture the visible tab, repeatedly.
 *
 * The first spike run measured 721.7 ms for a single capture - four times the
 * model forward pass. Whether that is a one-off setup cost or what every step of
 * the agent loop pays is the difference between "tune the model" and "the
 * capture path is the whole problem", so measure more than one.
 *
 * chrome.tabs.captureVisibleTab is quota'd at
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2, so calls are spaced. Only the
 * call itself is timed; the spacing is excluded.
 */
async function captureFrames(samples = 5) {
  const timings = [];
  let dataUrl = null;
  let error = null;

  for (let i = 0; i < samples; i++) {
    if (i > 0) await sleep(600); // stay inside the 2/sec quota
    const t0 = performance.now();
    try {
      dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
      timings.push(performance.now() - t0);
    } catch (err) {
      error = String(err);
      break;
    }
  }

  if (dataUrl === null) {
    // activeTab not granted, chrome:// page, etc. Fall back to a synthetic frame
    // so the model numbers are still obtainable.
    return { dataUrl: null, captureMs: 0, timings, source: 'synthetic', error };
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const round = (n) => Math.round(n * 10) / 10;
  return {
    dataUrl,
    source: 'captureVisibleTab',
    captureMs: round(timings[0] ?? 0),
    error,
    // The pair that answers the question: if coldMs >> warmP50Ms it is setup
    // cost paid once. If they are close, every agent step pays it.
    coldMs: round(timings[0] ?? 0),
    warmP50Ms: round(sorted.length > 1 ? sorted[Math.floor(sorted.length / 2)] : (sorted[0] ?? 0)),
    warmMinMs: round(sorted.length > 1 ? (sorted[1] ?? 0) : (sorted[0] ?? 0)),
    samples: timings.map(round),
    quotaPerSecond: 2,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;

  (async () => {
    try {
      if (msg.cmd === 'run') {
        await ensureOffscreen();
        const frame = await captureFrames(Number((msg.opts && msg.opts.captureSamples) || 5));
        const res = await chrome.runtime.sendMessage({
          target: 'offscreen',
          cmd: 'bench',
          frame,
          opts: msg.opts,
        });
        await chrome.storage.local.set({ lastResult: res });
        sendResponse(res);
        return;
      }
      if (msg.cmd === 'progress') {
        // Offscreen documents cannot touch chrome.storage - runtime messaging is
        // the only extensions API they get - so the relay lands here.
        await chrome.storage.local.set({ spikeProgress: msg.progress });
        sendResponse({ ok: true });
        return;
      }
      if (msg.cmd === 'reset') {
        if (await hasOffscreen()) await chrome.offscreen.closeDocument();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: `unknown cmd ${msg.cmd}` });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.stack ? err.stack : err) });
    }
  })();

  return true; // async response
});
