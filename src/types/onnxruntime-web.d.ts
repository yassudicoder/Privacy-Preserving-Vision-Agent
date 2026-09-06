/**
 * onnxruntime-web ships types, and TypeScript cannot reach them.
 *
 * The package has `types.d.ts` at its root but no `types` entry in the
 * `exports` map, so module resolution under `"moduleResolution": "bundler"`
 * finds `dist/ort.bundle.min.mjs` and reports it as implicitly `any`. That is a
 * defect in the package, not in this project, and there is no tsconfig setting
 * that fixes it without abandoning `exports`-aware resolution everywhere else.
 *
 * Declared as `unknown` rather than `any` deliberately. `any` would silently
 * disable checking at every use site; `unknown` forces the one cast that already
 * exists - `ort as unknown as OrtModule` - to stay explicit and greppable, and
 * keeps the real contract in `OrtModule`, which is hand-written, narrow, and
 * faked by the backend tests.
 */
declare module 'onnxruntime-web' {
  const ort: unknown;
  export = ort;
}
