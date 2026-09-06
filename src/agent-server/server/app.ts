import { ANY_PLACEHOLDER_RE } from '@/contracts/index.ts';
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, type PlanOutcome, type PlanRequest } from '../protocol.ts';
import type { Planner } from './planner.ts';

/**
 * Server request handling, as a pure function over a parsed body.
 *
 * No HTTP framework, no listener, no model. The brief puts the server out of
 * scope this session; what is here is the shape of the handler and the checks
 * that must exist before a model is ever wired in, so they get written while
 * they are still cheap.
 */

export interface HandleOptions {
  readonly planner: Planner;
  /** Reject a context whose placeholders do not carry its own declared nonce. */
  readonly strictNonce?: boolean;
}

function fail(error: string, retryable = false): PlanOutcome {
  return { ok: false, error: { protocolVersion: PROTOCOL_VERSION, error, retryable } };
}

/**
 * Validate a request before planning on it.
 *
 * The server is the second place a forged placeholder could do damage: if a page
 * planted `[[PII:EMAIL:1:deadbeef]]` and the client somehow passed it through,
 * the server would report a redaction that never happened. Both ends check.
 */
export function validateRequest(body: unknown, opts: HandleOptions): PlanOutcome | null {
  if (typeof body !== 'object' || body === null) return fail('body must be an object');
  const req = body as Partial<PlanRequest>;

  if (req.protocolVersion !== PROTOCOL_VERSION) {
    return fail(`unsupported protocolVersion ${String(req.protocolVersion)}`);
  }
  const ctx = req.context;
  if (typeof ctx !== 'object' || ctx === null) return fail('missing context');
  if (ctx.schemaVersion !== 1) return fail(`unsupported schemaVersion ${String(ctx.schemaVersion)}`);
  if (!Array.isArray(ctx.elements)) return fail('context.elements must be an array');

  /*
   * Checked here because `renderPrompt` dereferences it unconditionally.
   *
   * Without this, a context missing `redactionSummary` reached the planner and
   * died inside prompt rendering with "Cannot read properties of undefined
   * (reading 'byKind')" - which the catch below then reported as RETRYABLE. A
   * client obeying that would retry a malformed request forever, and the message
   * named a field of a field rather than the missing one.
   *
   * Found by POSTing a hand-rolled context at the running server, not by a test:
   * every test built its context with the real pipeline, so this shape never
   * occurred.
   */
  if (typeof ctx.redactionSummary !== 'object' || ctx.redactionSummary === null) {
    return fail('context.redactionSummary is required');
  }
  if (typeof ctx.title !== 'object' || ctx.title === null) {
    return fail('context.title is required');
  }

  const size = new TextEncoder().encode(JSON.stringify(body)).length;
  if (size > MAX_REQUEST_BYTES) return fail(`request too large: ${String(size)} bytes`);

  if (opts.strictNonce !== false) {
    const nonce = String(ctx.nonce);
    const blob = JSON.stringify(ctx.elements) + JSON.stringify(ctx.title);
    const found = blob.match(ANY_PLACEHOLDER_RE) ?? [];
    const foreign = found.filter((token) => !token.includes(`:${nonce}]]`));
    if (foreign.length > 0) {
      return fail(
        `context contains ${String(foreign.length)} placeholder(s) with a foreign nonce - rejecting as forged`,
      );
    }
  }

  return null;
}

export async function handlePlanRequest(body: unknown, opts: HandleOptions): Promise<PlanOutcome> {
  const invalid = validateRequest(body, opts);
  if (invalid !== null) return invalid;

  const req = body as PlanRequest;
  try {
    /*
     * `correction` is client-supplied and describes a reply this server just
     * had REFUSED. It carries only a ref, a role and an action type - all of
     * which the client derived from what we sent it - so there is nothing here
     * the page could have authored.
     */
    const { raw, serverMs } = await opts.planner.plan(req.context, req.correction);
    return {
      ok: true,
      response: { protocolVersion: PROTOCOL_VERSION, raw, modelId: opts.planner.id, serverMs },
    };
  } catch (err) {
    /*
     * RETRYABILITY COMES FROM THE UPSTREAM STATUS, not from a blanket `true`.
     *
     * Everything used to be retryable, which told the extension to try an
     * invalid API key again - and it would, once per step, until the loop hit
     * its ceiling. A 401 or a 400 from the model endpoint is a configuration
     * fault: the same request will fail the same way, and the fix is in the
     * server's environment.
     *
     * The MESSAGE has already been through `maskCredentials` at the transport,
     * because it is forwarded to the extension and rendered there.
     */
    const retryable =
      err instanceof Error && 'retryable' in err && typeof err.retryable === 'boolean'
        ? err.retryable
        : true;
    return fail(err instanceof Error ? err.message : String(err), retryable);
  }
}
