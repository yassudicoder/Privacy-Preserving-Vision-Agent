import { browser } from 'wxt/browser';
import * as ort from 'onnxruntime-web';
import {
  answerOffscreen,
  BrowserFrameCodec,
  LocalWorkerRuntime,
  type OrtModule,
  createPackagedYunetFactory,
  createRuntimeDispatch,
} from '@/perception/index.ts';
import {
  type DomRedactRequest,
  type DomSanitizeRequest,
  DOM_REDACT_CMD,
  DOM_SANITIZE_CMD,
  createBrowserBake,
  createInProcessDomPipeline,
} from '@/redaction/index.ts';
import type { MemoryReading } from '@/contracts/index.ts';

/**
 * Chrome-only. The document that owns the model.
 *
 * Exists solely because an MV3 service worker has no DOM, no canvas and no
 * WebGPU. Created by perception/host/chrome-offscreen.ts with reason WORKERS.
 * On Firefox this file is never loaded: the background event page already has
 * everything it needs, and wires the identical runtime itself.
 *
 * Thin on purpose. The command routing is `createRuntimeDispatch`, which lives
 * in perception because it is testable there and this file is not.
 *
 * THIS IS THE ONE FILE ON CHROME THAT PAYS FOR ONNX RUNTIME WEB. Importing it
 * here pulls ~21 MB of wasm into this document's bundle and nowhere else - the
 * service worker, the content script and the panel stay clear of it, which is
 * the entire reason the backend takes the library as a parameter instead of
 * importing it.
 *
 * ORT DIRECTLY, not transformers.js. YuNet is not one of the seven
 * architectures that library dispatches object-detection to, and ships neither
 * config.json nor preprocessor_config.json, so it cannot load through it at
 * all. The BARE specifier is deliberate: vite already resolves this module id
 * for transformers' own external, so Rollup deduplicates it and WebGPU stays
 * available. The 'onnxruntime-web/wasm' subpath hardcodes the non-jsep glue and
 * would silently forfeit it.
 */

/**
 * Resolves a packaged path for the model loader.
 *
 * The cast is unavoidable and deliberately narrow. WXT generates `PublicPath`
 * from what is in `public/` AT TYPECHECK TIME, and the model and wasm
 * directories are produced by `npm run vendor:model` - a build step, not a
 * committed tree. Typing them would mean committing ~46 MB of binaries to make
 * the compiler happy.
 *
 * `tests/built/bundle.test.ts` checks the emitted package for these files
 * instead, which is the check that would actually catch a wrong path.
 */
function packagedUrl(path: string): string {
  return browser.runtime.getURL(`/${path}` as Parameters<typeof browser.runtime.getURL>[0]);
}

/**
 * The heap of the context the model actually runs in.
 *
 * `performance.memory` is Chrome-only, non-standard, and JS-HEAP ONLY - it
 * excludes the ORT wasm arena and every GPU buffer, so it UNDER-reports what
 * this document really costs. `MemoryReading.jsHeapOnly` exists to say so, and
 * the panel prints the source beside the number rather than presenting it as a
 * total.
 *
 * The alternative, `performance.measureUserAgentSpecificMemory()`, is
 * authoritative and needs `crossOriginIsolated`, which an extension page is not.
 *
 * Reported honestly or not at all: null when the API is absent, which is what
 * every non-Chrome engine will produce, and null reads as "not measured" rather
 * than as zero.
 */
function readHeap(): MemoryReading | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
  const used = perf.memory?.usedJSHeapSize;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return {
    mb: Math.round((used / (1024 * 1024)) * 10) / 10,
    source: 'performance-memory',
    jsHeapOnly: true,
  };
}

const runtime = new LocalWorkerRuntime({
  codec: new BrowserFrameCodec(),
  /*
   * 768 px, matching the background. This is the Chrome path - the offscreen
   * document is where baking happens - and the two must agree or the image the
   * server receives depends on which browser the user is running.
   */
  bake: createBrowserBake(768),
  createBackend: createPackagedYunetFactory(ort as unknown as OrtModule, packagedUrl),
  readHeap,
});

const runtimeDispatch = createRuntimeDispatch(runtime);

/**
 * The DOM half of the work, which on Chrome can only happen here.
 *
 * `redact()` calls `new DOMParser()` and `buildSanitizedContext()` consumes the
 * Document it returns. The service worker has neither, so every Chrome step died
 * with "redact: DOMParser is not defined" while Firefox - an event page WITH a
 * DOM - ran the same code fine.
 *
 * MODULE SCOPE, not per message. The two commands share a retained Document
 * addressed by handle, so they must reach the same instance; a pipeline created
 * inside the listener would hand `sanitize` an empty map every time.
 */
const domPipeline = createInProcessDomPipeline();

/**
 * Routes both command families.
 *
 * Composed here rather than inside `createRuntimeDispatch`, for two reasons:
 * that function throws on any command it does not recognise (which is correct -
 * a silently ignored command looks like a hung pipeline), and `perception` may
 * not import `redaction`. An entrypoint may import both, so this is the one
 * place the two halves can legally meet.
 */
function dispatch(cmd: string, payload: unknown): Promise<unknown> {
  if (cmd === DOM_REDACT_CMD) return domPipeline.redact(payload as DomRedactRequest);
  if (cmd === DOM_SANITIZE_CMD) return domPipeline.sanitize(payload as DomSanitizeRequest);
  return runtimeDispatch(cmd, payload);
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { target?: string; cmd?: string; payload?: unknown } | null;
  if (msg === null || msg.target !== 'offscreen') return undefined;

  /*
   * The envelope is minted by `answerOffscreen`, which lives in perception
   * beside the code that parses it. Keeping the two halves in one module is what
   * lets a test drive them against each other - when this was three lines here,
   * in an entrypoint with no tests, this end wrapped and the other end never
   * unwrapped, and a model that failed to load reported as loaded.
   */
  return answerOffscreen(String(msg.cmd), msg.payload, dispatch);
});
