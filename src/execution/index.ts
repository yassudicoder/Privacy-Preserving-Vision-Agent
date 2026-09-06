/**
 * Doing what the model asked, on the page.
 *
 * Runs in the content script - the only context that touches the page - but
 * lives in a module because this is where a mistake types a password into the
 * wrong field, and an entrypoint cannot be tested.
 *
 * Imports contracts only. It does not know how a ref maps to an element; that
 * map is built at snapshot time and injected.
 */
export { executeAction } from './actions.ts';
export type { ExecutionEnv, ExecuteOutcome } from './actions.ts';
