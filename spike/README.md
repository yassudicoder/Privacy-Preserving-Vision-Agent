# SPIKE — offscreen model probe (throwaway)

Not part of the main tree. No TypeScript, no build step, no tests. It exists to
answer one question before we commit to an architecture:

> On **this machine**, how long does a real ViT detector take to load, how long
> does it take per frame, and how much memory does it hold — inside an MV3
> offscreen document?

Delete this whole folder once the number is recorded in `../DECISIONS.md`.

## Run it

```bash
npm run spike:setup
```

Then:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this `spike/` folder
4. Open any normal page (not `chrome://`, extensions can't capture those)
5. Click the extension's toolbar icon
6. Leave backend on `auto`, click **Run**

First run downloads the weights (cold). Click **Run** again for the warm number.
Both matter: cold is what a new user pays, warm is what the agent loop pays.

For a true cold measurement: **Clear model cache** → **Tear down offscreen** → **Run**.

## What it measures

| Field | Meaning |
|---|---|
| `load.loadMs` | `pipeline()` construction: fetch + parse + session init |
| `perFrame.decode` | dataURL → `RawImage` (this is JPEG decode, it is not free) |
| `perFrame.inference` | preprocess + forward pass + postprocess |
| `memory.jsHeap` | `performance.memory` sampled at 50 ms during the run |
| `memory.modelMbDownloaded` | bytes actually pulled from huggingface.co |
| `gpu` | whether WebGPU adapter exists, and which one |

## Numbers already known without running it

Measured while vendoring, so they are real regardless of the browser result:

| Asset | Size |
|---|---|
| `ort-wasm-simd-threaded.jsep.wasm` | **21 MB** |
| `transformers.min.js` | **868 KB** |

That ~22 MB is the ONNX Runtime Web floor, paid before a single model weight is
loaded. It ships inside the extension package. This is a direct hit on
*client-side resource utilization* (20% of the SIH score) and is the main reason
the model benchmark in `src/perception/bench.ts` treats runtime size as a
first-class axis, not an afterthought.

## Caveats on the numbers

- `performance.memory` reports the **JS heap only**. ONNX weights live in a
  `WebAssembly.Memory` and in GPU buffers, neither of which appear there. Read
  `modelMbDownloaded` alongside it. `measureUserAgentSpecificMemory()` would be
  authoritative but needs `crossOriginIsolated`, which an offscreen document is
  not — the probe reports why it skipped it.
- wasm threads are forced to 1 unless the context is cross-origin isolated, so
  the wasm number is a **floor**, not the achievable best.
- `Xenova/yolos-tiny` is a stand-in: a ViT backbone with a detection head, small
  enough to load fast. It detects COCO objects, **not** UI elements — it is a
  proxy for cost, not for accuracy. Accuracy is the benchmark harness's job.

## Why this could not be run here

Getting these numbers requires a real GPU-backed browser session with the
extension loaded unpacked. Headless Chrome would report a WebGPU-less,
single-threaded wasm path — a misleading number, worse than none. So the probe
is built and verified up to the browser boundary (vendoring runs, file layout
confirmed) and the measurement itself is yours to trigger.
