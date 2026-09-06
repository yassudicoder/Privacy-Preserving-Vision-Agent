/**
 * WHERE the model runs. Not WHAT reaches it.
 *
 * The privacy boundary in this project is a property of the CLIENT pipeline:
 * capture -> detect -> redact -> bake -> sanitize, and the only value that may
 * leave the machine is a `SanitizedContext`. That is enforced by the type system
 * (`SanitizedContext` is nominal and `redaction/sanitize.ts` is the sole minting
 * site) and by `contracts/egress.ts` at runtime.
 *
 * Nothing in this file can weaken that. A `BackendKind` selects a destination
 * for an already-sanitized payload; it does not select a pipeline. There is
 * deliberately no field here that could turn redaction off, skip a stage, or
 * send a different shape - because the failure this project most needs to avoid
 * is the one where a deployment switch quietly becomes a privacy switch.
 *
 * The four kinds are a DEPLOYMENT axis, not a vendor list. Ollama, vLLM,
 * llama.cpp, Together and Groq all speak the same OpenAI-compatible shape and
 * all sit behind the same `/plan` server, so the extension does not know or care
 * which one answered.
 */

/**
 * Where a step is planned.
 *
 *  - `on-device` - `LocalPlannerClient`. No network, no server, no endpoint.
 *    This is the project's headline capability and the only mode in which
 *    NOTHING at all leaves the machine, not even redacted text. It is kept as a
 *    first-class choice rather than as a fallback, because a fallback is
 *    something that happens to you and this is something you pick.
 *  - `local` - an agent server on loopback, typically Ollama behind
 *    `npm run server`. The sanitized context crosses a socket but not the
 *    network interface.
 *  - `private` - an organisation-controlled server over HTTPS.
 *  - `cloud` - a hosted agent server over HTTPS.
 *
 * `local`, `private` and `cloud` run byte-for-byte the same client code against
 * the same `/plan` protocol. They differ in the endpoint, in what TLS is
 * required, and in whether a bearer token is attached. `tests/agent-server/
 * backend.test.ts` asserts the request bodies are identical across all three.
 */
export type BackendKind = 'on-device' | 'local' | 'private' | 'cloud';

export const BACKEND_KINDS: readonly BackendKind[] = ['on-device', 'local', 'private', 'cloud'];

/** The three kinds that put bytes on a socket. `on-device` is not one of them. */
export const OFF_DEVICE_KINDS: readonly BackendKind[] = ['local', 'private', 'cloud'];

export function isBackendKind(value: unknown): value is BackendKind {
  return typeof value === 'string' && (BACKEND_KINDS as readonly string[]).includes(value);
}

export function isOffDevice(kind: BackendKind): boolean {
  return kind !== 'on-device';
}

/**
 * What the user configured for one backend.
 *
 * `endpoint` is an ORIGIN - scheme, host and port, no path, no query, no
 * credentials. `deriveOriginPattern` in `agent-server/origin.ts` is what
 * produces it, and it refuses wildcards, embedded credentials, and plaintext to
 * anything but loopback. The `/plan` path is appended by the client, so a user
 * cannot point this at an arbitrary path on a host they were granted.
 *
 * `model` is INFORMATIONAL. The extension does not choose the model; the server
 * does, from its own environment. This field exists so the panel can say what
 * the operator believes is deployed, and `PlanResponse.modelId` is what says
 * what actually answered. When they disagree, the response wins and the panel
 * shows both - a settings field that silently overrides a measurement would be
 * exactly the kind of confident wrong report this project keeps removing.
 *
 * THERE IS NO TOKEN FIELD HERE, and that is deliberate. See
 * `BackendDescriptor.authenticated`: this object is persisted, broadcast to the
 * panel and rendered in the privacy receipt, so a secret in it would end up in
 * all three. Tokens live in session storage, are read at request time, and go
 * into an `authorization` header and nowhere else.
 */
export interface BackendEndpointConfig {
  /** Origin only. Empty string means "not configured yet". */
  readonly endpoint: string;
  /** What the operator says runs there. Never authoritative. */
  readonly model: string;
}

/**
 * The whole deployment setting, as stored.
 *
 * All four entries are held at once rather than only the selected one, so
 * switching backends does not discard the configuration of the others - the SIH
 * demonstration is three runs of the same task against three deployments, and
 * retyping an endpoint between them is how a demo goes wrong on stage.
 */
export interface DeploymentConfig {
  readonly backend: BackendKind;
  readonly local: BackendEndpointConfig;
  readonly private: BackendEndpointConfig;
  readonly cloud: BackendEndpointConfig;
}

const EMPTY: BackendEndpointConfig = { endpoint: '', model: '' };

/**
 * The starting point: plan on-device, nothing configured.
 *
 * `on-device` rather than `local`, because a default that reaches a network
 * address the user has not chosen is the thing this project's constraints
 * forbid, and because a fresh install has no granted origin so `local` would
 * fail on its first step for a reason that reads like a bug.
 */
export function defaultDeployment(): DeploymentConfig {
  return { backend: 'on-device', local: EMPTY, private: EMPTY, cloud: EMPTY };
}

/** The entry for one kind. `on-device` has no endpoint by construction. */
export function configFor(config: DeploymentConfig, kind: BackendKind): BackendEndpointConfig {
  switch (kind) {
    case 'local':
      return config.local;
    case 'private':
      return config.private;
    case 'cloud':
      return config.cloud;
    case 'on-device':
      return EMPTY;
  }
}

/** The entry for the currently selected kind. */
export function selectedConfig(config: DeploymentConfig): BackendEndpointConfig {
  return configFor(config, config.backend);
}

/**
 * A backend named in terms that are safe to display, log and persist.
 *
 * Everything here is either a fixed enum or something the user typed as a
 * location. `authenticated` is a BOOLEAN on purpose: the panel, the timeline,
 * the privacy receipt and `storage.local` all see this object, and a token in it
 * would be in all four. `tests/agent-server/backend.test.ts` asserts that no
 * descriptor ever carries a secret-shaped string.
 */
export interface BackendDescriptor {
  readonly kind: BackendKind;
  /** Origin, or null for `on-device`. Never a path, query or credential. */
  readonly endpoint: string | null;
  /** What the operator configured. Null when unset. Never authoritative. */
  readonly model: string | null;
  /** True when planning this step puts bytes on a socket. */
  readonly offDevice: boolean;
  /** Whether a bearer token will be attached. NEVER the token. */
  readonly authenticated: boolean;
  /** Whether the transport is TLS. False for loopback http and for on-device. */
  readonly encrypted: boolean;
}

/** The human label for a kind. Used by the panel and the receipt. */
export function backendLabel(kind: BackendKind): string {
  switch (kind) {
    case 'on-device':
      return 'On-device (no network)';
    case 'local':
      return 'Local AI';
    case 'private':
      return 'Private Organization Server';
    case 'cloud':
      return 'Cloud AI';
  }
}

/**
 * Builds the descriptor from the stored config plus one runtime fact.
 *
 * `hasToken` is passed rather than read, because the token lives in session
 * storage in the background and this function must stay pure and importable
 * from the panel - which is precisely the context that should never be able to
 * reach a token in the first place.
 */
export function describeBackend(
  config: DeploymentConfig,
  hasToken: boolean,
): BackendDescriptor {
  const kind = config.backend;
  const entry = selectedConfig(config);
  const endpoint = entry.endpoint === '' ? null : entry.endpoint;
  return {
    kind,
    endpoint: kind === 'on-device' ? null : endpoint,
    model: entry.model === '' ? null : entry.model,
    offDevice: isOffDevice(kind),
    // A token is only ever attached off-device. Nothing sends one to a planner
    // that does not perform a request.
    authenticated: isOffDevice(kind) && hasToken,
    encrypted: endpoint !== null && isOffDevice(kind) && endpoint.startsWith('https://'),
  };
}

/** What a health probe found. Deliberately carries no server internals. */
export interface BackendHealth {
  readonly kind: BackendKind;
  readonly reachable: boolean;
  /** The planner id the server reports, e.g. `qwen2.5vl:3b`. Null when down. */
  readonly plannerId: string | null;
  /**
   * The server's own one-line description of what it is running.
   *
   * `server/main.ts` composes this and is explicit that the API KEY is never
   * included, only whether one is in use. It is still SERVER-AUTHORED text
   * rendered in our UI, so the panel neutralises and caps it exactly as it does
   * an `ask_user` question.
   */
  readonly description: string | null;
  /** Present only when unreachable. A transport message, never a payload. */
  readonly error: string | null;
  /**
   * Unreachable because it did not ANSWER IN TIME, as opposed to refusing.
   *
   * The distinction exists for free hosting tiers, which sleep after a period of
   * inactivity and take tens of seconds to wake. Both cases produce a failed
   * probe, and reporting them identically would tell a user their server is down
   * at the exact moment it is coming up - so the first request of the day looks
   * like a broken deployment.
   *
   * A REFUSED connection is a different fact: nothing is listening. That one is
   * `waking: false`, and is worth reporting as a problem.
   *
   * It is a hint, not a diagnosis. A genuinely dead host behind a load balancer
   * that swallows connections also times out. The panel wording reflects that:
   * "connecting", not "waking up".
   */
  readonly waking: boolean;
  /**
   * Whether the server said it REQUIRES a bearer token.
   *
   * From `/health`'s `auth` field, which reports whether `AGENT_AUTH_TOKEN` is
   * set on the server - never the token. `null` means the server did not say,
   * which is what an older server or a non-reachable one gives.
   *
   * It exists so a missing token can be caught BEFORE a step runs. Without it
   * the only way to discover one is a 401 at the plan stage - after a capture,
   * a DOM scan, a redaction pass, a pixel bake and two egress gates have all
   * done their work for a request that was never going to be accepted.
   */
  readonly authRequired: boolean | null;
  readonly checkedAtMs: number;
}

/**
 * Why a step could not be planned off-device, and what the user may do next.
 *
 * THIS TYPE IS THE "NO SILENT FALLBACK" RULE, made explicit.
 *
 * When a private server is unreachable, the tempting behaviour is to try the
 * cloud - the task continues, the demo keeps moving, and the sanitized context
 * of an organisation that chose a private deployment has just been sent to a
 * third party. The failure is invisible: every downstream event still says
 * "sanitized context delivered", because it was.
 *
 * So a failure produces one of these instead of a retry. It carries the
 * alternatives the user MAY pick, and nothing acts on them; switching requires
 * a click that changes `DeploymentConfig.backend`, which is broadcast, shown in
 * the panel and stamped on the next receipt.
 */
export interface BackendUnavailable {
  readonly kind: BackendKind;
  readonly endpoint: string | null;
  readonly error: string;
  /** Kinds the user could switch to. Offered, never taken automatically. */
  readonly alternatives: readonly BackendKind[];
}

/**
 * What else is configured, for the panel to offer after a failure.
 *
 * `on-device` is always offered because it needs no configuration and is always
 * available; the others only when an endpoint exists, since offering a switch to
 * an unconfigured backend is offering a second failure.
 */
export function alternativesTo(config: DeploymentConfig, failed: BackendKind): BackendKind[] {
  const out: BackendKind[] = [];
  for (const kind of BACKEND_KINDS) {
    if (kind === failed) continue;
    if (kind === 'on-device') {
      out.push(kind);
      continue;
    }
    if (configFor(config, kind).endpoint !== '') out.push(kind);
  }
  return out;
}
