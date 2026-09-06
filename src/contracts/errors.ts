export type AgentErrorScope =
  | 'capture'
  | 'perception'
  | 'redaction'
  | 'bake'
  | 'sanitize'
  | 'transport'
  | 'parse'
  | 'validate'
  | 'execute';

/**
 * Errors carry a scope so the panel can attribute a failure to a stage and the
 * harness can tell "the model was wrong" apart from "the pipeline broke".
 */
export class AgentError extends Error {
  readonly scope: AgentErrorScope;
  readonly recoverable: boolean;

  constructor(scope: AgentErrorScope, message: string, recoverable = false) {
    super(message);
    this.name = 'AgentError';
    this.scope = scope;
    this.recoverable = recoverable;
  }
}

/** Thrown by every stub in this scaffold. Catching it means "not built yet". */
export class NotImplementedError extends AgentError {
  constructor(what: string) {
    super('perception', `${what} is not implemented in the scaffold`, false);
    this.name = 'NotImplementedError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
