import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, MODEL_FILES, WASM_FILES } from '../../scripts/vendor-model.mjs';

/**
 * What actually ended up in the shipped package.
 *
 * `manifest.test.ts` reads the emitted manifest for the same reason this file
 * reads the emitted JavaScript: the config that produced them is not the thing
 * users install. This project has already been bitten once by a test that
 * asserted intent while the built artifact said something else - the content
 * script's `<all_urls>` grant survived a test suite that never opened a built
 * manifest.
 *
 * The specific risk here is ONNX Runtime Web. It is ~21 MB of wasm plus ~0.9 MB
 * of JS, it arrives transitively with transformers.js, and a single stray static
 * import puts it somewhere it must never be:
 *
 *  - the Chrome MV3 service worker, which has no DOM, no canvas and no WebGPU,
 *    and where the project's first hard constraint says no model may live
 *  - the content script, which is injected into pages
 *  - the side panel, which is a view
 *
 * None of those would fail to build. They would just quietly cost megabytes -
 * metric 4 is 20% of the score - and, in the service worker's case, break a
 * stated constraint while every unit test still passed.
 */

const OUT = join(process.cwd(), '.output');
const CHROME = join(OUT, 'chrome-mv3');
const FIREFOX = join(OUT, 'firefox-mv3');

/**
 * Strings that only appear if the model runtime was bundled.
 *
 * Chosen to be specific to ORT/transformers rather than generic ML words, so a
 * comment mentioning "onnx" cannot trip the check.
 */
const MODEL_RUNTIME_MARKERS = ['onnxruntime', 'ort-wasm', 'InferenceSession'] as const;

function jsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function carriesModelRuntime(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  return MODEL_RUNTIME_MARKERS.some((m) => src.includes(m));
}

function rel(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

describe.each([
  ['chrome', CHROME],
  ['firefox', FIREFOX],
])('%s bundle', (_browser, root) => {
  it('was built', () => {
    expect(existsSync(root)).toBe(true);
  });

  it('keeps the model runtime out of the content script', () => {
    // This code is injected into pages. Shipping a model runtime into every
    // page the user visits would be indefensible for a privacy extension.
    const injected = jsFiles(root).filter((f) => rel(root, f).startsWith('content-scripts/'));
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.filter(carriesModelRuntime).map((f) => rel(root, f))).toEqual([]);
  });

  it('carries exactly one copy of the model runtime', () => {
    /*
     * Two copies means one of them is dead weight - roughly 0.9 MB of JS before
     * the wasm, charged straight against the resource metric. It happens
     * silently: an entrypoint that one browser cannot use is still built for it
     * unless it is explicitly excluded.
     */
    const carriers = jsFiles(root).filter(carriesModelRuntime).map((f) => rel(root, f));
    expect(carriers).toHaveLength(1);
  });
});

describe('chrome keeps the model out of the service worker', () => {
  it('has a background script with no model runtime in it', () => {
    /*
     * THE HARD CONSTRAINT. Chrome's MV3 background is a service worker: no DOM,
     * no canvas, no WebGPU. The model lives in an offscreen document, and the
     * only thing stopping a static `import * as transformers` in background.ts
     * is that it is written as a dynamic import inside the Firefox-only path.
     *
     * Tree-shaking would not save us: transformers.js has module-level side
     * effects, so a bundler must keep a statically imported namespace even when
     * every function referencing it has been removed.
     */
    const sw = join(CHROME, 'background.js');
    expect(existsSync(sw)).toBe(true);
    const markers = MODEL_RUNTIME_MARKERS.filter((m) => readFileSync(sw, 'utf8').includes(m));
    expect(markers).toEqual([]);
  });

  it('puts the model runtime in the offscreen document instead', () => {
    // The positive half of the assertion above. Without it, deleting the model
    // entirely would make the previous test pass.
    const carriers = jsFiles(CHROME).filter(carriesModelRuntime).map((f) => rel(CHROME, f));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatch(/offscreen/);
  });
});

describe('chrome keeps the DOM out of the service worker', () => {
  /*
   * The second hard constraint, and the one that actually bit. `redact()` calls
   * `new DOMParser()` and `buildSanitizedContext()` consumes the Document it
   * returns. Chrome's MV3 background is a service worker with NO DOM, so calling
   * either from there failed every step with "redact: DOMParser is not defined",
   * while Firefox - whose background is an event page WITH a DOM - ran the
   * identical source and completed the whole loop.
   *
   * Asserted against the EMITTED bundle rather than the source, because what
   * matters is what the browser executes. A source-level rule would not have
   * seen a bundler inlining the implementation into the wrong chunk.
   */

  it('never references DOMParser in the service worker', () => {
    const sw = readFileSync(join(CHROME, 'background.js'), 'utf8');
    expect(sw).not.toContain('DOMParser');
  });

  it('does not inline the redaction implementation into the service worker', () => {
    /*
     * The stronger half. `DOMParser` absent could also mean the code was
     * inlined under a minified alias, so this looks for the redaction
     * implementation's own fingerprints - strings it cannot function without.
     */
    const sw = readFileSync(join(CHROME, 'background.js'), 'utf8');
    for (const marker of ['text/html', 'parseFromString']) {
      expect(sw, `service worker must not contain "${marker}"`).not.toContain(marker);
    }
  });

  it('puts the DOM work in the offscreen document instead', () => {
    /*
     * The positive half. Without it, deleting redaction altogether would make
     * both assertions above pass - which is exactly the failure mode this
     * project keeps rediscovering.
     */
    const carriers = jsFiles(CHROME)
      .filter((f) => readFileSync(f, 'utf8').includes('parseFromString'))
      .map((f) => rel(CHROME, f));

    expect(carriers.length).toBeGreaterThan(0);
    for (const c of carriers) {
      expect(c, 'DOM work belongs to the offscreen document').toMatch(/offscreen/);
    }
  });

  it('still ships the DOM work on firefox, where the background HAS a dom', () => {
    // The engines genuinely differ here, and the difference is deliberate.
    // Firefox's background is an event page, so it does this in-process.
    const carriers = jsFiles(FIREFOX).filter((f) =>
      readFileSync(f, 'utf8').includes('parseFromString'),
    );
    expect(carriers.length).toBeGreaterThan(0);
  });
});

describe('firefox has no offscreen document', () => {
  it('does not ship one', () => {
    /*
     * `chrome.offscreen` does not exist on Firefox, so this document can never
     * be created there and everything reachable from it is dead weight. WXT
     * builds every entrypoint for every browser unless told otherwise, so this
     * only holds while the entrypoint is explicitly excluded.
     */
    expect(existsSync(join(FIREFOX, 'offscreen.html'))).toBe(false);
  });

  it('loads the model in the background page, which is where its DOM is', () => {
    const carriers = jsFiles(FIREFOX).filter(carriesModelRuntime).map((f) => rel(FIREFOX, f));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatch(/background/);
  });
});

describe.each([
  ['chrome', CHROME],
  ['firefox', FIREFOX],
])('%s ships the model it refuses to download', (_browser, root) => {
  /*
   * `transformers-env.ts` sets `allowRemoteModels = false`, so these files are
   * not an optimisation - they are the only copy the extension will ever see.
   * A missing one is a dead extension, and it fails at model-load time in a
   * document with no visible UI, which is close to the worst place to find out.
   *
   * The file list is imported from the vendoring script rather than restated,
   * so adding a file there without shipping it fails here.
   */
  it.each([...MODEL_FILES])('has %s', (file: string) => {
    // Derived from DEFAULT_MODEL_ID rather than hardcoded, so a model swap
    // cannot leave this test asserting the presence of the previous model.
    const full = join(root, 'models', ...DEFAULT_MODEL_ID.split('/'), ...file.split('/'));
    expect(existsSync(full), full).toBe(true);
    expect(statSync(full).size).toBeGreaterThan(0);
  });

  it.each([...WASM_FILES])('has wasm/%s', (file: string) => {
    const full = join(root, 'wasm', file);
    expect(existsSync(full), full).toBe(true);
    expect(statSync(full).size).toBeGreaterThan(0);
  });

  it('ships the WebGPU-capable wasm build, not just the fallback', () => {
    /*
     * Without the `.jsep.` build, `device: 'webgpu'` throws, the backend falls
     * back to plain wasm, and everything still works - just far slower. That is
     * the failure mode this project is least able to notice, because nothing
     * breaks. `devicePlan` would report 'wasm' honestly, but only if someone
     * reads it.
     */
    expect(existsSync(join(root, 'wasm', 'ort-wasm-simd-threaded.jsep.wasm'))).toBe(true);
  });

  it('carries exactly one copy of the weights', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.onnx')) found.push(rel(root, full));
      }
    };
    walk(root);
    expect(found).toHaveLength(1);
  });

  it('stays inside the package size ceiling', () => {
    /*
     * Metric 4 (client-side resource utilisation) is 20% of the score, and this
     * package is dominated by two deliberate decisions: 25 MB of weights and
     * ~32 MB of ORT wasm.
     *
     * This ceiling is a TRIPWIRE, not a target. If it fails, the question is
     * what got added - not what the number should be raised to. The project has
     * an explicit rule about not widening a budget to make a figure look
     * better, and it applies here.
     */
    let total = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else total += statSync(full).size;
      }
    };
    walk(root);
    expect(total).toBeLessThan(64 * 1024 * 1024);
  });
});
