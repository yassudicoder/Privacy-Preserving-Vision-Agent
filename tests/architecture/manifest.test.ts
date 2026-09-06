import { describe, expect, it, vi } from 'vitest';
import config from '../../wxt.config.ts';

/**
 * The Chrome/Firefox manifest split, asserted without running a build.
 *
 * This is the constraint most likely to break silently: everything still
 * compiles and both bundles still emit, but Firefox quietly ships MV2, or
 * requests an `offscreen` permission that does not exist there, or loses the
 * `wasm-unsafe-eval` that ONNX Runtime Web needs to instantiate at all.
 */

type Env = Parameters<Extract<typeof config.manifest, (env: never) => unknown>>[0];

function manifestFor(browser: 'chrome' | 'firefox'): Record<string, unknown> {
  const fn = config.manifest;
  if (typeof fn !== 'function') throw new Error('manifest should be a function of the build env');
  const env = { browser, manifestVersion: 3, mode: 'production', command: 'build' } as unknown as Env;
  return fn(env) as unknown as Record<string, unknown>;
}

const chrome = manifestFor('chrome');
const firefox = manifestFor('firefox');

/**
 * The manifest a build would emit under the CURRENT `process.env`.
 *
 * `wxt.config.ts` reads `AGENT_ORIGIN` at MODULE SCOPE, so mutating the
 * variable after the top-level import above changes nothing - the value is
 * already captured. `resetModules()` plus a fresh dynamic import is what makes
 * the variable actually take effect, and without it the two tests below would
 * pass by asserting against the default build, which is the failure mode this
 * whole file keeps rediscovering.
 */
async function manifestWithEnv(
  browser: 'chrome' | 'firefox',
): Promise<Record<string, unknown>> {
  vi.resetModules();
  const fresh = (await import('../../wxt.config.ts')).default;
  const fn = fresh.manifest;
  if (typeof fn !== 'function') throw new Error('manifest should be a function of the build env');
  const env = { browser, manifestVersion: 3, mode: 'production', command: 'build' } as unknown as Env;
  return fn(env) as unknown as Record<string, unknown>;
}

describe('shared manifest guarantees', () => {
  it('declares wasm-unsafe-eval on both browsers', () => {
    // Without it the wasm backend cannot instantiate, and there is no fallback
    // from WebGPU on machines that lack it.
    for (const [name, m] of [['chrome', chrome], ['firefox', firefox]] as const) {
      const csp = m['content_security_policy'] as { extension_pages?: string } | undefined;
      expect(csp?.extension_pages, name).toContain("'wasm-unsafe-eval'");
    }
  });

  it('ships no host permissions by default', () => {
    /*
     * A wildcard host permission would let this extension read every page it is
     * installed alongside. The user grants an origin at runtime instead.
     *
     * This runs with `AGENT_ORIGIN` unset, which is the default and what CI
     * builds, so the key must be absent entirely. The test below covers the
     * distribution build, where it is present and constrained.
     */
    for (const [name, m] of [['chrome', chrome], ['firefox', firefox]] as const) {
      expect(m['host_permissions'], name).toBeUndefined();
      expect(m['optional_host_permissions'], name).toBeDefined();
    }
  });

  it('grants at most ONE exact origin when a build bakes one in', async () => {
    /*
     * WHAT THIS TEST IS ACTUALLY PROTECTING, since it now permits a key that
     * used to be forbidden outright.
     *
     * The old assertion was `toBeUndefined()`, and its stated intent was "a
     * wildcard would let this extension read every page". A distribution build
     * needs to reach its own agent server without asking, and a host permission
     * for one named https host does not read any page: page access is still
     * `activeTab` plus a per-site grant the user makes deliberately. So the
     * rule that matters is not "no host permissions" but "no wildcard, and
     * exactly one".
     *
     * Built by re-invoking the config with the variable set, rather than by
     * trusting the default build - a guard that cannot see its subject is not a
     * guard, and this file has been bitten by that before.
     */
    const previous = process.env['AGENT_ORIGIN'];
    process.env['AGENT_ORIGIN'] = 'https://agent.example.com:8443/plan';
    try {
      // A fresh module instance: the config reads the variable at import time.
      const built = await manifestWithEnv('chrome');
      const hosts = built['host_permissions'] as string[] | undefined;

      expect(hosts).toBeDefined();
      expect(hosts).toHaveLength(1);
      const only = hosts?.[0] ?? '';

      // The exact origin, host-only. A match pattern's host may not carry a
      // port, and the path is dropped: the grant is a HOST, not a URL.
      expect(only).toBe('https://agent.example.com/*');
      expect(only).not.toContain('*.');
      expect(only).not.toContain('8443');
      expect(only).not.toBe('<all_urls>');
      expect(only.startsWith('https://')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['AGENT_ORIGIN'];
      else process.env['AGENT_ORIGIN'] = previous;
    }
  });

  it('refuses to bake in anything that is not one exact https host', async () => {
    /*
     * The values a mistake or a hostile build script would supply. Each must
     * produce NO host permission at all rather than a broad one - failing
     * closed, so a bad `AGENT_ORIGIN` yields a build that cannot auto-connect
     * instead of a build that can reach everything.
     */
    const previous = process.env['AGENT_ORIGIN'];
    const refused = [
      'https://*.example.com',
      '<all_urls>',
      'http://agent.example.com',
      'http://localhost:8787',
      'https://localhost:8787',
      'not a url',
      '',
    ];
    try {
      for (const value of refused) {
        process.env['AGENT_ORIGIN'] = value;
        const built = await manifestWithEnv('chrome');
        expect(built['host_permissions'], value).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env['AGENT_ORIGIN'];
      else process.env['AGENT_ORIGIN'] = previous;
    }
  });

  it('contains no baked-in endpoint or key', () => {
    for (const m of [chrome, firefox]) {
      const text = JSON.stringify(m);
      expect(text).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
      expect(text).not.toMatch(/api[_-]?key/i);
    }
  });
});

describe('chrome manifest', () => {
  it('requests the offscreen permission', () => {
    // The model cannot live in a service worker; the offscreen document is the
    // only place on Chrome with a DOM, canvas and WebGPU.
    expect(chrome['permissions']).toContain('offscreen');
  });

  it('requests sidePanel', () => {
    expect(chrome['permissions']).toContain('sidePanel');
  });

  it('sets a minimum version that has runtime.getContexts', () => {
    // getContexts() is the portable way to check for an existing offscreen
    // document; hasDocument() is Chrome 150+.
    expect(Number(chrome['minimum_chrome_version'])).toBeGreaterThanOrEqual(116);
  });
});

describe('firefox manifest', () => {
  it('does NOT request offscreen, which does not exist there', () => {
    expect(firefox['permissions']).not.toContain('offscreen');
  });

  it('does NOT request sidePanel, which is a Chrome API', () => {
    expect(firefox['permissions']).not.toContain('sidePanel');
  });

  it('pins a minimum version that supports MV3 event pages', () => {
    const bss = firefox['browser_specific_settings'] as
      | { gecko?: { strict_min_version?: string; id?: string } }
      | undefined;
    expect(bss?.gecko?.id).toBeTruthy();
    expect(Number.parseFloat(bss?.gecko?.strict_min_version ?? '0')).toBeGreaterThanOrEqual(128);
  });

  it('declares data collection honestly', () => {
    // Redacted page structure is still website content leaving the machine.
    // Declaring 'none' would be a lie, and would be the exact dishonesty this
    // project exists to avoid.
    const bss = firefox['browser_specific_settings'] as
      | { gecko?: { data_collection_permissions?: { required?: string[] } } }
      | undefined;
    const required = bss?.gecko?.data_collection_permissions?.required ?? [];
    expect(required).toContain('websiteContent');
    expect(required).not.toContain('none');
  });
});

describe('build scripts', () => {
  it('passes --mv3 on every firefox command', async () => {
    // WXT defaults Firefox to MV2. Left implicit, we ship MV2 without noticing.
    const pkg = (await import('../../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    const firefoxScripts = Object.entries(pkg.scripts).filter(([, cmd]) =>
      cmd.includes('-b firefox'),
    );
    expect(firefoxScripts.length).toBeGreaterThan(0);
    for (const [name, cmd] of firefoxScripts) {
      expect(cmd, `script "${name}" is missing --mv3`).toContain('--mv3');
    }
  });

  it('declares manifestVersion 3 in the config', () => {
    expect(config.manifestVersion).toBe(3);
  });
});
