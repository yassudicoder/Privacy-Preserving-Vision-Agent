import { describe, expect, it } from 'vitest';
import {
  type PermissionsApi,
  deriveOriginPattern,
  requestServerOrigin,
} from '@/agent-server/index.ts';

/**
 * Granting the extension permission to talk to a server.
 *
 * This is the whole runtime-grant mechanism the headline constraint depends on:
 * "no baked-in endpoints - the user supplies a server origin at runtime". Until
 * now it did not exist, and `activeTab` plus `optional_host_permissions` were
 * declared with nothing able to request them.
 *
 * Two things are easy to get wrong here and neither fails loudly:
 *   - accepting an origin that grants more than the user meant
 *   - awaiting anything before permissions.request, which silently forfeits
 *     user-gesture status and makes the prompt never appear
 */

describe('deriveOriginPattern accepts only what it should', () => {
  it('reduces a full URL to an origin pattern', () => {
    const r = deriveOriginPattern('https://agent.example.com/v1/plan?key=abc#frag');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe('https://agent.example.com');
    // Path, query and fragment are dropped: a permission is per-origin, and the
    // query routinely carries a token nobody meant to store.
    expect(r.value.pattern).toBe('https://agent.example.com/*');
  });

  it('keeps the port in the origin but NOT in the match pattern', () => {
    /*
     * This test previously asserted the pattern was
     * `https://agent.example.com:8443/*`, and that pinned something the platform
     * cannot grant: a match pattern's host may not contain a port.
     *
     * On Firefox the consequence was
     *   "Cannot request origin permission for http://localhost:8787/* since it
     *    was not declared in the manifest"
     * which reads as a missing declaration and is not one - the manifest does
     * declare `http://localhost/*`. Chrome accepted the same request, so it
     * failed on one engine only.
     *
     * The port still belongs in `origin`, which is what gets fetched.
     */
    const r = deriveOriginPattern('https://agent.example.com:8443/plan');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe('https://agent.example.com:8443');
    expect(r.value.pattern).toBe('https://agent.example.com/*');
  });

  it('produces a pattern the manifest actually declares, for the local server', () => {
    // The exact case that failed. `http://localhost/*` is in
    // optional_host_permissions; `http://localhost:8787/*` is not a pattern at
    // all, so it could never match it.
    const r = deriveOriginPattern('http://localhost:8787');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe('http://localhost:8787');
    expect(r.value.pattern).toBe('http://localhost/*');
  });

  it('never emits a pattern containing a port', () => {
    // The general rule, so a future change cannot reintroduce the bug for some
    // other URL shape.
    for (const raw of [
      'https://a.example.com:8443/x',
      'http://localhost:3000',
      'http://127.0.0.1:9999/plan?token=secret',
      'https://b.example.com',
    ]) {
      const r = deriveOriginPattern(raw);
      if (!r.ok) continue;
      expect(r.value.pattern, raw).not.toMatch(/:\d+\/\*$/);
    }
  });

  it('allows http only for loopback', () => {
    // Plaintext to a remote host would put the sanitized context on the wire in
    // the clear, which defeats the point of having redacted it.
    for (const host of ['localhost', '127.0.0.1']) {
      const r = deriveOriginPattern(`http://${host}:8000`);
      expect(r.ok, host).toBe(true);
    }
    const remote = deriveOriginPattern('http://agent.example.com');
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.error).toMatch(/https/i);
  });

  it('refuses a wildcard host', () => {
    // The one that matters. "https://*.example.com" or "https://*" would grant
    // far more than a server origin, and reads as reasonable at a glance.
    for (const bad of ['https://*', 'https://*.example.com', 'https://*/*']) {
      const r = deriveOriginPattern(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/wildcard|host/i);
    }
  });

  it('refuses <all_urls> however it is spelled', () => {
    for (const bad of ['<all_urls>', '*://*/*']) {
      expect(deriveOriginPattern(bad).ok, bad).toBe(false);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    const r = deriveOriginPattern('https://user:pass@agent.example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/credential/i);
  });

  it('refuses a non-http scheme', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://x.example.com', 'javascript:alert(1)']) {
      expect(deriveOriginPattern(bad).ok, bad).toBe(false);
    }
  });

  it('refuses input that is not a URL at all', () => {
    for (const bad of ['', '   ', 'not a url', 'agent.example.com']) {
      const r = deriveOriginPattern(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('trims surrounding whitespace rather than rejecting a pasted value', () => {
    const r = deriveOriginPattern('  https://agent.example.com/plan  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pattern).toBe('https://agent.example.com/*');
  });
});

describe('requestServerOrigin preserves user-gesture status', () => {
  function api(): { impl: PermissionsApi; calls: string[][]; resolved: boolean[] } {
    const calls: string[][] = [];
    const resolved: boolean[] = [];
    return {
      calls,
      resolved,
      impl: {
        request: (p) => {
          calls.push([...p.origins]);
          resolved.push(true);
          return Promise.resolve(true);
        },
        contains: () => Promise.resolve(false),
        remove: () => Promise.resolve(true),
      },
    };
  }

  it('calls permissions.request SYNCHRONOUSLY, before any await', () => {
    /*
     * The rule that makes or breaks this feature. Both engines read gesture
     * status at call time: Chromium scopes it to the synchronous execution of
     * the handler, Gecko does the same via withHandlingUserInput. Awaiting
     * anything first - even a permissions.contains() check - loses it, and the
     * prompt simply never appears. There is no error to notice.
     *
     * Asserting the call happened before the microtask queue drained is what
     * pins that.
     */
    const a = api();
    const derived = deriveOriginPattern('https://agent.example.com');
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    void requestServerOrigin(a.impl, derived.value);

    // No await between the call above and this assertion.
    expect(a.calls).toEqual([['https://agent.example.com/*']]);
  });

  it('resolves to whether the user granted it', async () => {
    const a = api();
    const derived = deriveOriginPattern('https://agent.example.com');
    if (!derived.ok) throw new Error('unreachable');
    await expect(requestServerOrigin(a.impl, derived.value)).resolves.toBe(true);
  });

  it('reports a refusal as false rather than throwing', async () => {
    // Declining a permission prompt is a normal outcome, not an error.
    const impl: PermissionsApi = {
      request: () => Promise.resolve(false),
      contains: () => Promise.resolve(false),
      remove: () => Promise.resolve(true),
    };
    const derived = deriveOriginPattern('https://agent.example.com');
    if (!derived.ok) throw new Error('unreachable');
    await expect(requestServerOrigin(impl, derived.value)).resolves.toBe(false);
  });

  it('surfaces an API failure instead of reporting a grant', async () => {
    const impl: PermissionsApi = {
      request: () => Promise.reject(new Error('not allowed in this context')),
      contains: () => Promise.resolve(false),
      remove: () => Promise.resolve(true),
    };
    const derived = deriveOriginPattern('https://agent.example.com');
    if (!derived.ok) throw new Error('unreachable');
    await expect(requestServerOrigin(impl, derived.value)).rejects.toThrow(/not allowed/);
  });
});

describe('loopback hosts the manifest can actually grant', () => {
  it('accepts 127.0.0.1 over http, like localhost', () => {
    const r = deriveOriginPattern('http://127.0.0.1:8787');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pattern).toBe('http://127.0.0.1/*');
  });

  it('refuses an IPv6 literal with advice rather than deriving something ungrantable', () => {
    /*
     * A match pattern cannot express an IPv6 literal host, so the derived
     * pattern could never appear in optional_host_permissions and the browser
     * would refuse it - the same opaque "not declared in the manifest" failure
     * that a port produced. Refusing it here names the fix instead.
     */
    const r = deriveOriginPattern('http://[::1]:8787');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/127\.0\.0\.1/);
  });
});

describe('hosts that are not hosts', () => {
  it('refuses a single-label hostname, which a scheme typo produces', () => {
    /*
     * `new URL('https://http')` parses happily - "http" is a syntactically valid
     * host - so a typo produced the origin `https://http`, the panel showed it as
     * configured, and the loop spent a step failing to reach it. Observed in a
     * real run as "planning via https://http".
     */
    const r = deriveOriginPattern('https://http');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not a reachable host/);
  });

  it('still accepts loopback, which legitimately has no dot', () => {
    expect(deriveOriginPattern('http://localhost:8787').ok).toBe(true);
    expect(deriveOriginPattern('http://127.0.0.1:8787').ok).toBe(true);
  });

  it('accepts an ordinary dotted host', () => {
    expect(deriveOriginPattern('https://agent.example.com').ok).toBe(true);
  });
});

