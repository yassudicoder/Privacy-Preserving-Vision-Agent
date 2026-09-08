import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Module boundaries, enforced by reading the import graph.
 *
 * Five modules were meant to be workable in parallel against stubs. That only
 * holds if the dependency graph stays a DAG and nobody reaches into anybody
 * else's internals. Conventions do not survive a deadline; a failing test does.
 *
 * No new dependency: this walks the tree and reads import specifiers directly.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

type Module =
  | 'contracts'
  | 'perception'
  | 'redaction'
  | 'panel'
  | 'agent-server'
  | 'execution'
  | 'analysis'
  | 'orchestrator'
  | 'harness'
  | 'entrypoints';

/**
 * Who may import whom. contracts is the shared leaf; harness sits on top and
 * may see everything; the four feature modules may only see contracts.
 */
const ALLOWED: Readonly<Record<Module, readonly Module[]>> = {
  contracts: [],
  perception: ['contracts'],
  redaction: ['contracts', 'analysis'],
  panel: ['contracts'],
  'agent-server': ['contracts'],
  /*
   * Deterministic statistics over the ALREADY-REDACTED document. Contracts only,
   * like every other feature module - it reaches no network, touches no host,
   * and its whole job is arithmetic. `redaction` may see it because
   * `buildSanitizedContext` is where an analysis is attached to a context, and
   * that has to stay the one minting site.
   */
  analysis: ['contracts'],
  /*
   * Execution runs in the content script. Contracts only - it is handed an
   * already-validated Action and a resolver, and must not be able to reach the
   * server client or the model from the one context that sees the raw page.
   */
  execution: ['contracts'],
  /*
   * The composition layer. It is the ONE place allowed to see perception,
   * redaction and agent-server together, because running a step means calling
   * all three in order - and that ordering is logic worth testing, which it
   * cannot be if it lives in an entrypoint.
   *
   * Deliberately NOT allowed to import `panel`: the orchestrator emits
   * PanelEvents, which are a contract, and must not know what renders them.
   */
  orchestrator: ['contracts', 'perception', 'redaction', 'agent-server', 'analysis'],
  harness: ['contracts', 'perception', 'redaction', 'panel', 'agent-server', 'execution', 'orchestrator', 'analysis'],
  entrypoints: ['contracts', 'perception', 'redaction', 'panel', 'agent-server', 'execution', 'orchestrator', 'analysis'],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (['.ts', '.tsx'].includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function moduleOf(file: string): Module | null {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  const top = rel.split('/')[0];
  if (top === undefined) return null;
  return (Object.keys(ALLOWED) as Module[]).includes(top as Module) ? (top as Module) : null;
}

/*
 * The negative lookbehind is load-bearing.
 *
 * Without it, a STRING LITERAL containing the word "from" is read as an import:
 * `contracts/ambiguity.ts` has a stopword list including `'from', 'into',` and
 * the scanner matched `from', '` as a specifier of `", "`. That is a false
 * positive in the scanner, not a violation in the code - and a boundary test
 * that fails for the wrong reason gets weakened by whoever hits it next.
 *
 * `from` preceded immediately by a quote is inside a string, never a keyword.
 */
const IMPORT_RE = /(?<!['"])\b(?:from|import)\b\s*\(?\s*['"]([^'"]+)['"]/g;

/**
 * Strip comments before scanning for imports.
 *
 * Without this, ordinary prose trips the scanner: a comment containing
 * `... apart from "the pipeline broke"` parses as an import specifier. The
 * `:` guard leaves `https://` inside string literals alone.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importsOf(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  let m = IMPORT_RE.exec(code);
  while (m !== null) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
    m = IMPORT_RE.exec(code);
  }
  IMPORT_RE.lastIndex = 0;
  return out;
}

/**
 * Where an import specifier actually points, as a path relative to `src/`.
 *
 * Returns null for bare package specifiers, which are not our modules. Both
 * spellings of an intra-repo import normalise to the same answer, which is the
 * whole point: `@/agent-server/server/planner.ts` and `./server/planner.ts`
 * from inside `agent-server/` are the same file and must be judged the same.
 */
function specifierTarget(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2);
  if (!spec.startsWith('.')) return null;
  return relative(SRC, resolve(dirname(fromFile), spec)).replace(/\\/g, '/');
}

const FILES = walk(SRC);

describe('module boundaries', () => {
  it('found source files to check', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('respects the dependency DAG', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const from = moduleOf(file);
      if (from === null) continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of importsOf(source)) {
        if (!spec.startsWith('@/')) continue;
        const to = spec.slice(2).split('/')[0] as Module | undefined;
        if (to === undefined || to === from) continue;
        if (!(ALLOWED[from] as readonly string[]).includes(to)) {
          violations.push(`${relative(ROOT, file)} imports @/${to} (${from} may not)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('lets nothing reach into another module past its index', () => {
    // Deep imports are how a module's internals become someone else's API and
    // parallel work turns into a merge conflict.
    const violations: string[] = [];
    for (const file of FILES) {
      const from = moduleOf(file);
      if (from === null) continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of importsOf(source)) {
        if (!spec.startsWith('@/')) continue;
        const parts = spec.slice(2).split('/');
        const to = parts[0];
        if (to === undefined || to === from) continue;
        // Only `@/x/index.ts` (or `@/x`) is a legitimate cross-module import.
        const isIndex = parts.length === 1 || (parts.length === 2 && parts[1] === 'index.ts');
        if (!isIndex) violations.push(`${relative(ROOT, file)} deep-imports "${spec}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps contracts free of runtime dependencies', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      if (moduleOf(file) !== 'contracts') continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of importsOf(source)) {
        if (spec.startsWith('.')) continue;
        violations.push(`${relative(ROOT, file)} imports "${spec}"`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('the extension bundle stays clean', () => {
  it('never imports the harness', () => {
    // harness/ reads the filesystem. Pulling it in would break the build and
    // ship fixtures to users.
    const violations: string[] = [];
    for (const file of FILES) {
      const mod = moduleOf(file);
      if (mod === 'harness' || mod === null) continue;
      if (importsOf(readFileSync(file, 'utf8')).some((s) => s.startsWith('@/harness'))) {
        violations.push(relative(ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('never imports node built-ins outside the harness', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const mod = moduleOf(file);
      if (mod === 'harness' || mod === null) continue;
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:')) violations.push(`${relative(ROOT, file)} imports "${spec}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never imports the server half into an extension context', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const mod = moduleOf(file);
      if (mod === null || mod === 'harness') continue;
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('agent-server/server/')) continue;
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        /*
         * RESOLVED, not substring-matched.
         *
         * The old check tested `spec.includes('agent-server/server')`, which
         * catches the alias spelling `@/agent-server/server/planner.ts` and
         * misses the relative one. A file at `src/agent-server/local-planner.ts`
         * importing `./server/planner.ts` reaches exactly the same module, and
         * that specifier contains no such substring - so the pin passed while
         * the boundary it names was crossed.
         *
         * This was found by deliberately probing it, not by reading it. Same
         * failure as the manifest test that asserted host_permissions while
         * content_scripts held the capability: a guard that cannot see the
         * thing it guards is not a guard.
         */
        const target = specifierTarget(file, spec);
        if (target !== null && target.startsWith('agent-server/server/')) {
          violations.push(`${relative(ROOT, file)} imports "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('privileged operations stay where they were reviewed', () => {
  it('mints SanitizedContext in exactly one place', () => {
    // The type is nominal, so the only way to produce one is a cast. If a second
    // cast appears, the guarantee that everything outbound went through
    // redaction is gone, and it would be gone silently.
    const casts: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      if (/\bas SanitizedContext\b/.test(source)) casts.push(relative(SRC, file).replace(/\\/g, '/'));
    }
    expect(casts).toEqual(['redaction/sanitize.ts']);
  });

  it('mints BakedScreenshot in exactly one place', () => {
    const casts: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      if (/\bas BakedScreenshot\b/.test(source)) casts.push(relative(SRC, file).replace(/\\/g, '/'));
    }
    expect(casts).toEqual(['redaction/canvas-redact.ts']);
  });

  it('keeps every raw-page-text unwrap greppable and justified', () => {
    // unsafeUnwrap is the only way to look at untrusted text. Every call site is
    // a decision; this test makes the list of them visible in one place.
    const sites: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      const count = (source.match(/unsafeUnwrap\(/g) ?? []).length;
      // The declaration itself lives in contracts/untrusted.ts.
      if (count > 0 && !file.endsWith('untrusted.ts')) {
        sites.push(relative(SRC, file).replace(/\\/g, '/'));
      }
    }
    expect(sites.sort()).toEqual([
      'entrypoints/content.ts',
      'harness/load.ts',
      'harness/pipeline.ts',
      'redaction/redact.ts',
    ]);
  });
});

describe('the egress gate cannot be routed around', () => {
  /*
   * A NEW HTTP CALL IS A NEW WAY OUT.
   *
   * The whole "privacy does not depend on the backend" claim rests on there
   * being exactly ONE place in the extension that performs a network request
   * with the sanitized context, so the gate inside it cannot be true of one
   * deployment and false of another. A second `fetch` - a "cloud client" that
   * seemed to need its own transport, a telemetry ping, a model-list lookup -
   * would be a second exit with no gate on it, and it would be easy to add
   * without anyone noticing.
   *
   * So the list is pinned, exactly the way `unsafeUnwrap` and
   * `permissions.request` are. Adding a call site fails the build until somebody
   * updates this list deliberately.
   */
  it('performs a network request from exactly the files reviewed for it', () => {
    const sites: string[] = [];
    for (const file of FILES) {
      const mod = moduleOf(file);
      // The harness is Node-side tooling and the server half is not in the
      // bundle; neither can be reached from an extension context.
      if (mod === 'harness' || mod === null) continue;
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('agent-server/server/')) continue;

      const code = stripComments(readFileSync(file, 'utf8'));
      /*
       * Matches a CALL, not a mention. `#fetch` as a private field declaration
       * and the word "fetch" in a variable name are not exits; `fetch(` and
       * `this.#fetch(` are.
       */
      if (/(?:^|[^.\w])fetch\s*\(/.test(code) || /#fetch\s*\(/.test(code)) {
        sites.push(rel);
      }
    }
    expect(sites.sort()).toEqual([
      /*
       * The single HTTP exit. `assertOutboundContext` runs as its first
       * statement, before the endpoint is even read.
       */
      'agent-server/client.ts',
      /*
       * The health probe. It sends NO context - a bare GET /health with an
       * optional bearer header - which is why it is a legitimate second site and
       * why it does not need the gate. If this file ever starts sending a
       * payload, that changes.
       */
      'agent-server/backend.ts',
      /*
       * Decodes a data: URL into an ImageBitmap inside the worker. Same-document
       * only; it reaches no network and cannot, because a data: URL has no host.
       */
      'perception/worker/browser-codec.ts',
      /*
       * Reads the PACKAGED model weights out of the extension's own bundle, via
       * a `chrome-extension://` / `moz-extension://` URL from
       * `browser.runtime.getURL`. That is a file read wearing `fetch`'s API - it
       * is why `vendor:model` puts the weights in `public/` and why the bundle
       * test asserts they are in the emitted package.
       *
       * Listed rather than excluded by a URL-shape heuristic, because "it only
       * fetches extension-local URLs" is a claim about a value at runtime and
       * this file can only see the call. Reviewing them by name is the honest
       * version.
       */
      'perception/worker/yunet-backend.ts',
      /*
       * Measures how many bytes a packaged model actually cost, by re-reading it
       * from the same extension-local URL. No context, no page data, no network.
       */
      'perception/worker/transformers-env.ts',
    ].sort());
  });

  it('asserts the outbound context in the file that performs the request', () => {
    // The gate is only a gate where the bytes are. A check in a caller can be
    // bypassed by a new caller; a check in the transport cannot.
    const client = readFileSync(join(SRC, 'agent-server/client.ts'), 'utf8');
    expect(client).toMatch(/assertOutboundContext\(/);
  });

  it('runs BOTH gates in the orchestrator, which is the only layer that sees both', () => {
    /*
     * The shape gate lives in contracts and can run inside the client. The
     * CONTENT gate needs `scanTextPatterns` and therefore lives in redaction,
     * which `agent-server` may not import. The orchestrator is the one layer
     * that sees both, so if it stops calling them there is no other place they
     * could be called from.
     */
    const step = readFileSync(join(SRC, 'orchestrator/step.ts'), 'utf8');
    expect(step).toMatch(/assertOutboundContext\(/);
    expect(step).toMatch(/assertNoLeak\(/);
  });
});

describe('the extension widens its own reach in one place only', () => {
  it('calls permissions.request from exactly one file', () => {
    /*
     * `permissions.request` is how this extension gains access it did not ship
     * with. A second call site would be a second place capable of that, and it
     * would be easy to add without anyone noticing - so the list is pinned, the
     * same way the unsafeUnwrap sites are.
     *
     * agent-server/origin.ts derives a single-origin pattern and refuses
     * wildcards. Code bypassing it could request `<all_urls>` directly, which
     * both browsers would happily grant if the user clicked through.
     */
    const sites: string[] = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      /*
       * Matches the CALL, not a name. The first version of this looked for the
       * literal `permissions.request(` and found nothing, because origin.ts
       * takes the API as a parameter called `api` - a pin that passes because it
       * cannot see its subject is the failure mode this file exists to prevent.
       * So: anything handing an `origins` list to a `request(`.
       */
      if (/\.\s*request\s*\(\s*\{[^}]*origins/.test(code) || /permissions\s*\.\s*request\s*\(/.test(code)) {
        sites.push(relative(SRC, file).replace(/\\/g, '/'));
      }
    }
    expect(sites.sort()).toEqual(['agent-server/origin.ts']);
  });
});


describe('offscreen document API limits', () => {
  it('touches no extension API except runtime', () => {
    /*
     * "The runtime API is the only extensions API supported by offscreen
     * documents." Permissions carry over, but the APIs do not - chrome.storage
     * is simply undefined there.
     *
     * This fails at RUNTIME, not at compile time: the types are perfectly happy
     * with browser.storage.local.set() in an offscreen document. It cost a whole
     * spike run to discover, and the error it produced masked the real one. So
     * it gets a test rather than a comment.
     */
    const offscreenFiles = FILES.filter((f) =>
      relative(SRC, f).replace(/\\/g, '/').startsWith('entrypoints/offscreen/'),
    );
    expect(offscreenFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of offscreenFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/\b(?:chrome|browser)\.([a-zA-Z]+)/g)) {
        const api = m[1];
        if (api !== undefined && api !== 'runtime') {
          violations.push(`${relative(ROOT, file)} uses ${api}, unavailable in an offscreen document`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('no secrets in the repo', () => {
  it('has no hardcoded endpoint or key', () => {
    const suspicious: string[] = [];
    const patterns = [
      /\bsk-[A-Za-z0-9]{16,}/,
      /\bghp_[A-Za-z0-9]{20,}/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /api[_-]?key\s*[:=]\s*['"][^'"]{12,}['"]/i,
    ];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const re of patterns) {
        if (re.test(source)) suspicious.push(`${relative(ROOT, file)} matches ${String(re)}`);
      }
    }
    expect(suspicious).toEqual([]);
  });
});
