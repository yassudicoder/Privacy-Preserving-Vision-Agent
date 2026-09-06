/**
 * The runtime origin grant.
 *
 * This is the mechanism the project's headline constraint rests on: no endpoint
 * is baked in, so the user supplies a server origin and the extension asks for
 * permission to reach it. Until this file existed, `optional_host_permissions`
 * was declared with nothing able to request anything from it.
 *
 * THE ONLY `permissions.request` CALL SITE. Kept that way deliberately, the same
 * way `unsafeUnwrap` call sites are pinned: a second one would be a second place
 * where the extension can widen its own reach, and it would be easy to add
 * without anyone noticing.
 */

export interface OriginGrant {
  /** Scheme + host + port, no trailing slash. */
  readonly origin: string;
  /** The match pattern a permission is actually granted against. */
  readonly pattern: string;
}

export type OriginResult =
  | { readonly ok: true; readonly value: OriginGrant }
  | { readonly ok: false; readonly error: string };

/*
 * `[::1]` is deliberately absent.
 *
 * Match patterns cannot express an IPv6 literal host, so a pattern derived from
 * it could never be declared in `optional_host_permissions` and the browser
 * would refuse the request - the same class of failure that
 * `http://localhost:8787/*` produced, and just as opaque. Refusing it here, by
 * name, is better than deriving something ungrantable and letting Firefox
 * explain it badly.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1']);
const IPV6_LOOPBACK = new Set(['[::1]', '::1']);

/**
 * Turns something a user typed into a single-origin match pattern.
 *
 * Deliberately strict. Everything it rejects is something that would grant more
 * than "one server", and most of it reads as reasonable at a glance - which is
 * exactly why it is checked here rather than trusted.
 */
export function deriveOriginPattern(raw: string): OriginResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'enter a server URL' };

  // Caught before URL parsing: `*://*/*` parses as nothing useful, and
  // `<all_urls>` is not a URL at all, so both would fall out as a vague
  // "invalid URL" rather than naming the real problem.
  if (trimmed === '<all_urls>' || trimmed.includes('*')) {
    return {
      ok: false,
      error: 'wildcard host patterns are not accepted; give one exact server origin',
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: `not a URL: ${trimmed}` };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'remove the credentials from the URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `unsupported scheme "${url.protocol}"; use https` };
  }

  if (IPV6_LOOPBACK.has(url.hostname)) {
    return {
      ok: false,
      error: 'use http://localhost or http://127.0.0.1 - an IPv6 literal cannot be granted',
    };
  }

  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    // Plaintext to a remote host puts the sanitized context on the wire in the
    // clear, which undoes the point of having redacted it.
    return { ok: false, error: 'http is only allowed for localhost; use https' };
  }

  if (url.hostname === '') return { ok: false, error: 'the URL has no host' };

  /*
   * A single-label hostname is not a server anyone can reach.
   *
   * `new URL('https://http')` parses happily - "http" is a syntactically valid
   * host - so a typo in the scheme produced the origin `https://http`, which the
   * panel then displayed as configured and the loop spent a step failing to
   * reach. Observed: "planning via https://http".
   *
   * Loopback is the exception, and it is already in LOOPBACK above.
   */
  if (!url.hostname.includes('.') && !LOOPBACK.has(url.hostname)) {
    return {
      ok: false,
      error: `"${url.hostname}" is not a reachable host - did you mean http://localhost:PORT?`,
    };
  }

  /*
   * `origin` keeps the port; `pattern` MUST NOT.
   *
   * A match pattern's host may not contain a port - that is the platform's rule,
   * not a choice. Emitting `http://localhost:8787/*` produced, on Firefox:
   *
   *   Cannot request origin permission for http://localhost:8787/* since it was
   *   not declared in the manifest
   *
   * which reads as a missing declaration and is not one: the manifest declares
   * `http://localhost/*`, and the requested string simply is not a valid pattern
   * for it to match. Chrome accepts the same request, so this failed on one
   * engine only.
   *
   * The two fields already existed for exactly this split. `origin` is what the
   * client FETCHES (port and all); `pattern` is what the browser is ASKED FOR.
   *
   * The consequence, stated plainly: the grant is per-HOST, not per-port. There
   * is no way to be narrower - the permission model cannot express a port - so
   * granting localhost:8787 also permits localhost:3000. Path, query and
   * fragment are still dropped, and the query routinely carries a token nobody
   * meant to persist.
   */
  return {
    ok: true,
    value: { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` },
  };
}

/** The slice of `browser.permissions` this module uses. */
export interface PermissionsApi {
  request(p: { origins: string[] }): Promise<boolean>;
  contains(p: { origins: string[] }): Promise<boolean>;
  remove(p: { origins: string[] }): Promise<boolean>;
}

/**
 * Asks the user to grant one origin.
 *
 * MUST BE CALLED SYNCHRONOUSLY FROM A USER-GESTURE HANDLER, and this function is
 * written so that it can be: it does no work before `request`, not even a
 * `contains` check. Both engines read gesture status at call time - Chromium
 * scopes it to the synchronous execution of the handler, Gecko does the same
 * through `withHandlingUserInput` - so a single `await` beforehand loses it and
 * the prompt never appears. There is no error when that happens, which is what
 * makes it worth a comment and a test.
 *
 * Resolves false when the user declines. That is a normal outcome, not a fault.
 */
export function requestServerOrigin(api: PermissionsApi, grant: OriginGrant): Promise<boolean> {
  return api.request({ origins: [grant.pattern] });
}

/** Whether an origin is already granted. Safe to await - no gesture needed. */
export function hasServerOrigin(api: PermissionsApi, grant: OriginGrant): Promise<boolean> {
  return api.contains({ origins: [grant.pattern] });
}

/** Gives back an origin. Also no gesture required. */
export function revokeServerOrigin(api: PermissionsApi, grant: OriginGrant): Promise<boolean> {
  return api.remove({ origins: [grant.pattern] });
}
