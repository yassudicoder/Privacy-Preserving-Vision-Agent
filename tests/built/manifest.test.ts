import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveOriginPattern } from '@/agent-server/index.ts';

/**
 * Assertions against the BUILT manifests, not the config that generates them.
 *
 * `tests/architecture/manifest.test.ts` calls the `manifest()` function out of
 * wxt.config.ts and asserts the object it returns. That object is not the
 * manifest. WXT merges in `content_scripts`, `background`, `side_panel`,
 * `sidebar_action`, `manifest_version` and `web_accessible_resources` at build
 * time, so every one of those keys is structurally invisible to that file.
 *
 * That blind spot was not theoretical. The config test contains
 *
 *     expect(m['host_permissions']).toBeUndefined();
 *
 * under a name promising the extension ships no host permissions -- and it
 * passed for the whole life of the project while the built manifests carried
 * `content_scripts: [{ matches: ['<all_urls>'] }]`, which is the same
 * page-reading capability under a different key. The assertion checked the key
 * that was empty and could not see the key that was not.
 *
 * So these run against the emitted artifact. They need a build, which is why
 * they are excluded from `npm test` and live behind `npm run test:built`
 * (which builds first). They FAIL LOUDLY when .output/ is missing rather than
 * skipping: a guard that silently passes when it cannot see anything is the
 * exact failure mode this file exists to end.
 */

const BUILDS = [
  { name: 'chrome', dir: '.output/chrome-mv3' },
  { name: 'firefox', dir: '.output/firefox-mv3' },
] as const;

type Manifest = Record<string, unknown>;

function loadManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(
      `No built manifest at ${path}. These tests assert the emitted artifact and cannot ` +
        `run without one. Use \`npm run test:built\`, which builds first.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const MANIFESTS = BUILDS.map((b) => ({ ...b, manifest: loadManifest(b.dir) }));

/**
 * Patterns that amount to "every page". Not an exhaustive match-pattern parser
 * -- a host wildcard is what matters, and anything reaching a bare `*` host
 * grants ambient access however it is spelled.
 */
const AMBIENT = /^(<all_urls>|\*:\/\/\*\/|\*:\/\/\*\/\*|https?:\/\/\*\/\*|file:\/\/\*)$/;

function isAmbient(pattern: string): boolean {
  return AMBIENT.test(pattern.trim());
}

/**
 * Every place a manifest can hand out page access WITHOUT a user gesture.
 *
 * `optional_host_permissions` is deliberately absent from this list: it is the
 * ceiling on what may later be granted, not a grant. It is asserted separately.
 */
function ambientGrants(m: Manifest): string[] {
  const found: string[] = [];

  for (const p of (m['host_permissions'] as string[] | undefined) ?? []) {
    if (isAmbient(p)) found.push(`host_permissions: ${p}`);
  }

  // A host pattern smuggled into `permissions` counts the same in MV2-style
  // manifests and is worth catching if the manifest version ever moves.
  for (const p of (m['permissions'] as string[] | undefined) ?? []) {
    if (p.includes('://') && isAmbient(p)) found.push(`permissions: ${p}`);
  }

  // The one that was actually there. On Chrome these are "scriptable hosts",
  // granted at install; on Firefox MV3 they are user-granted.
  const scripts = (m['content_scripts'] as { matches?: string[] }[] | undefined) ?? [];
  for (const cs of scripts) {
    for (const p of cs.matches ?? []) {
      if (isAmbient(p)) found.push(`content_scripts.matches: ${p}`);
    }
  }

  const war = (m['web_accessible_resources'] as { matches?: string[] }[] | undefined) ?? [];
  for (const entry of war) {
    for (const p of entry.matches ?? []) {
      if (isAmbient(p)) found.push(`web_accessible_resources.matches: ${p}`);
    }
  }

  return found;
}

describe('the built manifest grants no ambient page access', () => {
  it.each(MANIFESTS)('$name declares no all-sites grant', ({ manifest }) => {
    // The headline privacy constraint, asserted where it can actually be seen.
    expect(ambientGrants(manifest)).toEqual([]);
  });

  it.each(MANIFESTS)('$name keeps optional_host_permissions a bounded ceiling', ({ manifest }) => {
    const optional = manifest['optional_host_permissions'] as string[] | undefined;
    expect(optional, 'the runtime-grant flow has nothing to request without this').toBeDefined();
    expect(optional?.length ?? 0).toBeGreaterThan(0);

    // `https://*/*` is permitted here on purpose. Chrome requires that any
    // origin passed to permissions.request() already appear in this list, so a
    // user-supplied server origin forces a broad optional pattern. `<all_urls>`
    // is not permitted: it would additionally cover http, file and ftp.
    expect(optional).not.toContain('<all_urls>');
  });
});

describe('the built manifest requests exactly the permissions we reviewed', () => {
  // Pinned, not probed. The previous test only ever asked `toContain`, so a
  // manifest that additionally requested `tabs` (whole browsing history),
  // `cookies` or `webRequest` passed every existing assertion.
  const EXPECTED: Record<string, readonly string[]> = {
    chrome: ['activeTab', 'offscreen', 'scripting', 'sidePanel', 'storage'],
    firefox: ['activeTab', 'scripting', 'storage'],
  };

  it.each(MANIFESTS)('$name requests the exact reviewed set', ({ name, manifest }) => {
    const actual = [...((manifest['permissions'] as string[] | undefined) ?? [])].sort();
    expect(actual).toEqual([...(EXPECTED[name] ?? [])].sort());
  });

  it('firefox requests no Chrome-only API', () => {
    const firefox = MANIFESTS.find((m) => m.name === 'firefox')?.manifest ?? {};
    const perms = (firefox['permissions'] as string[] | undefined) ?? [];
    expect(perms).not.toContain('offscreen');
    expect(perms).not.toContain('sidePanel');
  });
});

describe('the toolbar button can actually reach the background', () => {
  /*
   * The reported bug was that clicking the extension in Firefox showed only the
   * permission menu. Neither built manifest declared `action` at all, so there
   * was no button and no click event -- the panel, which is the entire UI, was
   * unreachable.
   *
   * Both assertions below guard a SILENT failure. Nothing else in the suite,
   * and no typecheck, notices either one.
   */
  it.each(MANIFESTS)('$name declares an action', ({ manifest }) => {
    // Without this key browser.action is undefined and background.ts cannot
    // register the listener that opens the panel.
    expect(manifest['action']).toBeDefined();
  });

  it.each(MANIFESTS)('$name action declares no popup', ({ manifest }) => {
    /*
     * Chrome: "The action.onClicked event won't be sent if the extension action
     * has specified a popup". MDN: "This event will not fire if the browser
     * action has a popup."
     *
     * A default_popup would therefore restore the dead-click symptom with no
     * error, no warning and no other failing test -- and would add the second
     * UI surface this project deliberately does not have.
     */
    const action = manifest['action'] as Record<string, unknown> | undefined;
    expect(action?.['default_popup']).toBeUndefined();
  });

  it('each browser exposes exactly one panel key', () => {
    // side_panel is Chrome-only, sidebar_action is Firefox-only. A stray
    // sidebar_action in a Chrome build is dead weight the platform ignores.
    const firefox = MANIFESTS.find((m) => m.name === 'firefox')?.manifest ?? {};
    const chrome = MANIFESTS.find((m) => m.name === 'chrome')?.manifest ?? {};

    expect(chrome['side_panel']).toBeDefined();
    expect(chrome['sidebar_action']).toBeUndefined();
    expect(firefox['sidebar_action']).toBeDefined();
    expect(firefox['side_panel']).toBeUndefined();
  });
});

describe('the built manifest is MV3 on both browsers', () => {
  it.each(MANIFESTS)('$name is manifest_version 3', ({ manifest }) => {
    // WXT defaults Firefox to MV2. If the --mv3 flag is ever dropped from a
    // script this is where it surfaces, in the artifact rather than the config.
    expect(manifest['manifest_version']).toBe(3);
  });

  it('firefox uses an event page and chrome uses a service worker', () => {
    const firefox = MANIFESTS.find((m) => m.name === 'firefox')?.manifest ?? {};
    const chrome = MANIFESTS.find((m) => m.name === 'chrome')?.manifest ?? {};
    const fxBg = firefox['background'] as Record<string, unknown> | undefined;
    const crBg = chrome['background'] as Record<string, unknown> | undefined;

    // background.service_worker is unsupported in Firefox (bugzil.la/1573659).
    expect(fxBg?.['scripts']).toBeDefined();
    expect(fxBg?.['service_worker']).toBeUndefined();
    expect(crBg?.['service_worker']).toBeDefined();
  });
});

describe('the built CSP stays restrictive', () => {
  // The old check was `toContain("'wasm-unsafe-eval'")`, a substring test that
  // a policy adding 'unsafe-eval' or a CDN origin passes unchanged. This CSP
  // governs the offscreen document, which holds the decoded pre-redaction
  // frame, so a permissive script-src there is a direct PII exposure.
  const ALLOWED_SCRIPT_SRC = new Set(["'self'", "'wasm-unsafe-eval'"]);

  it.each(MANIFESTS)('$name allows no script source beyond self + wasm', ({ manifest }) => {
    const csp = manifest['content_security_policy'] as { extension_pages?: string } | undefined;
    const policy = csp?.extension_pages;
    expect(policy, 'ONNX Runtime Web cannot instantiate without an explicit CSP').toBeDefined();

    const scriptSrc =
      policy
        ?.split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('script-src')) ?? '';
    const tokens = scriptSrc.split(/\s+/).slice(1).filter(Boolean);

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("'wasm-unsafe-eval'");
    for (const t of tokens) {
      expect(ALLOWED_SCRIPT_SRC.has(t), `disallowed script-src token: ${t}`).toBe(true);
    }
  });
});

describe('the built manifest points only at files that exist', () => {
  /** Every string in the manifest that looks like a bundled path. */
  function referencedPaths(m: Manifest): string[] {
    const out: string[] = [];
    const visit = (v: unknown): void => {
      if (typeof v === 'string') {
        if (/\.(js|html|css|png|svg|json)$/.test(v) && !v.startsWith('http')) out.push(v);
      } else if (Array.isArray(v)) {
        v.forEach(visit);
      } else if (v !== null && typeof v === 'object') {
        Object.values(v).forEach(visit);
      }
    };
    visit(m);
    return out;
  }

  it.each(MANIFESTS)('$name references no missing file', ({ dir, manifest }) => {
    const missing = referencedPaths(manifest).filter((p) => !existsSync(join(dir, p)));
    expect(missing).toEqual([]);
  });
});

describe('the shipped bytes carry no secret and no local path', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (['.js', '.html', '.json', '.css'].includes(extname(full))) out.push(full);
    }
    return out;
  }

  // boundaries.test.ts greps src/. This greps what actually ships, which is the
  // only place a leak can reach a user.
  it.each(MANIFESTS)('$name ships nothing sensitive', ({ dir }) => {
    const offenders: string[] = [];
    const patterns: readonly [RegExp, string][] = [
      [/\bsk-[A-Za-z0-9]{16,}/, 'openai-style key'],
      [/\bghp_[A-Za-z0-9]{20,}/, 'github token'],
      [/\bAKIA[0-9A-Z]{16}\b/, 'aws key id'],
      [/[A-Za-z]:[\\/]Users[\\/]/, 'absolute local path'],
    ];
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      for (const [re, label] of patterns) {
        if (re.test(text)) offenders.push(`${file}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the manifest version is the package version', () => {
  it('does not drift from package.json', () => {
    /*
     * It had drifted: wxt.config.ts hardcoded '0.1.0' while package.json moved
     * to 0.2.0, so the INSTALLED extension reported a version the repo no longer
     * claimed. The manifest is what the browser and the store read, so that is
     * the copy that matters and the one that was wrong.
     */
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    for (const b of MANIFESTS) {
      expect(b.manifest.version, `${b.name} manifest version`).toBe(pkg.version);
    }
  });
});

describe('every origin the client can derive is one the manifest can grant', () => {
  /*
   * THE GUARD THAT WAS MISSING. `deriveOriginPattern` built the request pattern
   * and `optional_host_permissions` declared what may be requested, and nothing
   * checked that one could satisfy the other. They disagreed:
   *
   *   requested:  http://localhost:8787/*      (from url.origin, port included)
   *   declared:   http://localhost/*
   *
   * Firefox refused with "Cannot request origin permission for
   * http://localhost:8787/* since it was not declared in the manifest", which
   * reads as a missing declaration and was not one - a match pattern's host may
   * not contain a port, so the requested string was not a pattern that could
   * match anything. Chrome accepted it, so this failed on one engine only.
   */

  /** Does `declared` cover `requested`? Match-pattern semantics, narrowly. */
  function covers(declared: string, requested: string): boolean {
    if (declared === requested) return true;
    const [dScheme = '', dRest = ''] = declared.split('://');
    const [rScheme = '', rRest = ''] = requested.split('://');
    if (dScheme !== rScheme) return false;
    const dHost = dRest.split('/')[0] ?? '';
    const rHost = rRest.split('/')[0] ?? '';
    if (dHost === rHost) return true;
    // `*.example.com` covers any subdomain; `*` covers any host.
    if (dHost === '*') return true;
    return dHost.startsWith('*.') && rHost.endsWith(dHost.slice(1));
  }

  const SERVERS = [
    'http://localhost:8787',
    'http://localhost:11434/v1/chat/completions',
    'http://127.0.0.1:8787',
    'https://agent.example.com',
    'https://agent.example.com:8443/plan',
    // Refused by deriveOriginPattern, so it never reaches permissions.request.
    'http://[::1]:8787',
  ];

  for (const b of MANIFESTS) {
    it(`${b.name} declares a pattern for every acceptable server URL`, () => {
      const declared = (b.manifest['optional_host_permissions'] ?? []) as string[];
      expect(declared.length).toBeGreaterThan(0);

      for (const raw of SERVERS) {
        const derived = deriveOriginPattern(raw);
        // Anything the client accepts must be requestable. If it is refused
        // outright that is fine - it never reaches permissions.request.
        if (!derived.ok) continue;

        const pattern = derived.value.pattern;
        // A pattern containing a port is invalid and can never be granted.
        expect(pattern, `${raw} -> pattern`).not.toMatch(/:\d+\/\*$/);
        expect(
          declared.some((d) => covers(d, pattern)),
          `${raw} derives ${pattern}, which ${b.name} does not declare (${declared.join(', ')})`,
        ).toBe(true);
      }
    });
  }
});

