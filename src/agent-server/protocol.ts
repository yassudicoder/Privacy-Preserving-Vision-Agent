import type { SanitizedContext } from '@/contracts/index.ts';

/**
 * The wire contract. Imported by both halves, so a change here breaks the
 * compile on both sides rather than at runtime in a demo.
 */

export const PROTOCOL_VERSION = 1 as const;

export interface PlanRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  /** The ONLY payload permitted to leave the client. */
  readonly context: SanitizedContext;
  readonly clientVersion: string;
  /**
   * A correction for a reply this client just REFUSED.
   *
   * Measured, not assumed. With the marker rendered and rule 6 rewritten, a 3B
   * model at temperature 0 still returned
   * `{"type":"type","ref":"e14","text":"Add Laptop Pro to cart"}` at a BUTTON -
   * the right element, the wrong verb, deterministically. The same model given
   * the same prompt plus a short CORRECTION block returned
   * `{"type":"click","ref":"e14"}` on the first try.
   *
   * So the fix is not more rules. It is telling the model what it just got
   * wrong, at the moment it got it wrong, instead of hoping it reads a history
   * line next turn.
   *
   * Generated from OUR validation error and OUR element roles - never from page
   * text - so it carries nothing untrusted.
   */
  readonly correction?: string;
}

export interface PlanResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  /** Raw model output. Deliberately unparsed - the client is what validates it. */
  readonly raw: string;
  readonly modelId: string;
  readonly serverMs: number;
}

/**
 * What went wrong, at a granularity the caller can act on.
 *
 *  - `transport` - the server was not reached, or answered 5xx. THIS IS THE ONE
 *    THAT MATTERS: it is the only failure class where "the backend is down" is
 *    the right reading, and therefore the only one that should surface the
 *    "private server unavailable / retry / switch" choice. Inferring it from the
 *    message text was the alternative, and a string match deciding whether to
 *    offer someone a switch to a cloud provider is not a defensible way to make
 *    that decision.
 *  - `protocol` - reached, answered, and the answer was not usable.
 *  - `refused` - WE refused, before sending. The egress gate blocked the
 *    payload. Distinct from every server-side failure because the fix is here,
 *    the request never left, and retrying is pointless.
 */
export type PlanErrorKind = 'transport' | 'protocol' | 'refused';

export interface PlanError {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly error: string;
  readonly retryable: boolean;
  /** Absent from older producers; treat an absent value as `protocol`. */
  readonly kind?: PlanErrorKind;
}

export type PlanOutcome =
  | { readonly ok: true; readonly response: PlanResponse }
  | { readonly ok: false; readonly error: PlanError };

/** Guard rail: a context this large means something upstream went wrong. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export function encodeRequest(req: PlanRequest): string {
  return JSON.stringify(req);
}

export function requestBytes(req: PlanRequest): number {
  return new TextEncoder().encode(encodeRequest(req)).length;
}

export interface AgentClient {
  plan(req: PlanRequest, signal: AbortSignal): Promise<PlanOutcome>;
}
