/**
 * Types for the vendoring script, so tests can import its file lists.
 *
 * The script itself stays plain JS - it runs under bare `node` as part of the
 * build and has no compile step. This file exists so `tests/built/bundle.test.ts`
 * can assert against ONE list of what the package must contain rather than
 * keeping a second copy that drifts.
 */

/** Model files fetched from the hub, in the layout transformers.js expects. */
export declare const MODEL_FILES: readonly string[];

/** ORT wasm binaries copied out of node_modules. */
export declare const WASM_FILES: readonly string[];

/** The model id the script fetches, and the one the contract default must name. */
export declare const DEFAULT_MODEL_ID: string;
