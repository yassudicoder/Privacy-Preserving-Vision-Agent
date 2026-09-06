import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG } from '@/contracts/index.ts';
import { DEFAULT_MODEL_ID } from '../../scripts/vendor-model.mjs';

/**
 * The default model id must name weights that actually ship.
 *
 * THE MISSING GUARD. `DEFAULT_ENGINE_CONFIG.modelId` was `'stub'` - a
 * placeholder from before there was a real backend. Once
 * `transformers-env.ts` set `allowRemoteModels = false` and
 * `localModelPath = <extension>/models/`, that string stopped being a label and
 * became a PATH SEGMENT: the loader resolves `models/<modelId>/config.json`.
 *
 * So the panel's Load model button, which sends no config and falls back to this
 * default, asked for `models/stub/config.json`, got a 404, and reported
 * "could not load stub after 37 ms - webgpu: The operation was aborted.;
 * wasm: The operation was aborted."
 *
 * Every layer behaved correctly. The device fallback tried both paths, the error
 * named the model, and the panel showed it. Nothing was broken except that no
 * test tied the contract's default to the bytes in `public/`. This is that test.
 */

describe('the default model id names the vendored weights', () => {
  it('matches the id the vendoring script fetches', () => {
    // Imported from the script rather than restated. A second copy of the
    // string here would drift exactly the way the original did.
    expect(DEFAULT_ENGINE_CONFIG.modelId).toBe(DEFAULT_MODEL_ID);
  });

  it('is not a placeholder', () => {
    // 'stub' is a Backend value, not a model. The two live in different unions
    // and reading like one another is what let this sit unnoticed.
    expect(DEFAULT_ENGINE_CONFIG.modelId).not.toBe('stub');
    expect(DEFAULT_ENGINE_CONFIG.modelId).toMatch(/\//);
  });

  it('resolves to weights on disk once vendored', () => {
    /*
     * Skipped rather than failed when `public/models/` is absent: the weights
     * are a build step (`npm run vendor:model`), not committed bytes, so a
     * fresh clone legitimately has none. When they ARE present this is the
     * assertion that matters - it walks the exact path the loader will walk.
     */
    const root = join(process.cwd(), 'public', 'models');
    if (!existsSync(root)) return;

    /*
     * The WEIGHTS, not config.json.
     *
     * It checked `config.json` while the model was a transformers.js one, which
     * required it. YuNet ships neither config.json nor
     * preprocessor_config.json - it is not a transformers.js model and is driven
     * through an ONNX session directly - so the file the loader actually walks
     * to is the .onnx itself.
     */
    const weights = join(
      root,
      ...DEFAULT_ENGINE_CONFIG.modelId.split('/'),
      'onnx',
      'model.onnx',
    );
    expect(existsSync(weights), `loader will resolve ${weights}`).toBe(true);
    expect(statSync(weights).size).toBeGreaterThan(0);
  });

  it('agrees with what the vendoring run actually recorded', () => {
    const manifest = join(process.cwd(), 'public', 'models', 'vendored.json');
    if (!existsSync(manifest)) return;

    const recorded = JSON.parse(readFileSync(manifest, 'utf8')) as { modelId?: string };
    // vendored.json is written by the script at fetch time, so this compares the
    // contract against a record of what was really downloaded.
    expect(recorded.modelId).toBe(DEFAULT_ENGINE_CONFIG.modelId);
  });
});
