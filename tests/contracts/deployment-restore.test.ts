import { describe, expect, it } from 'vitest';
import { defaultDeployment, restoreDeployment, type DeploymentConfig } from '@/contracts/index.ts';

/**
 * What a service worker must find when it wakes up.
 *
 * THIS FILE EXISTS BECAUSE THE LOGIC WAS UNTESTABLE AND WRONG. It lived in
 * `background.ts` as an unbraced `if` whose `else` bound to a different `if` two
 * statements below it, so a stored deployment was overwritten with the seed on
 * most rehydrations. `background.ts` is the one file with no test harness -
 * which is exactly why `orchestrator/attach.ts` was extracted before it - and
 * nothing here could see the bug until the decision moved into `contracts`.
 *
 * The failure was quiet and constant: Chrome unloads an MV3 service worker after
 * about thirty seconds idle, so every pause dropped the user's server URL, and
 * the next run planned on-device while the panel still said `local`.
 */

const LOCAL: DeploymentConfig = {
  ...defaultDeployment(),
  backend: 'local',
  local: { endpoint: 'http://localhost:8787', model: '' },
};

const NOTHING = { config: undefined, intent: undefined, bakedOrigin: '', legacyOrigin: undefined };

describe('a stored deployment survives a restart', () => {
  it('KEEPS a stored config when an intent is also stored', () => {
    /*
     * THE REGRESSION, stated as the case that used to fail.
     *
     * `persistDeployment` writes intent alongside config, so every user who
     * picked a backend with the panel's radio buttons had both. That made the
     * intent-adoption condition false, the misbound `else` fired, and this
     * config was replaced by the seed.
     */
    const got = restoreDeployment({ ...NOTHING, config: LOCAL, intent: 'local' });
    expect(got.config).toEqual(LOCAL);
    expect(got.config.local.endpoint).toBe('http://localhost:8787');
    expect(got.intent).toBe('local');
  });

  it('keeps it for every stored intent, including on-device', () => {
    // The old branch fired whenever adoption was skipped, and adoption was
    // skipped for ALL of these. Enumerated rather than argued.
    for (const intent of ['on-device', 'local', 'private', 'cloud'] as const) {
      const got = restoreDeployment({ ...NOTHING, config: LOCAL, intent });
      expect(got.config.local.endpoint).toBe('http://localhost:8787');
      expect(got.intent).toBe(intent);
    }
  });

  it('keeps a stored config that selects on-device but remembers endpoints', () => {
    /*
     * A demotion leaves `backend: 'on-device'` with the endpoints intact, so
     * re-selecting the backend does not mean retyping the URL. The old code
     * wiped those too: `isOffDevice('on-device')` is false, so adoption was
     * skipped and the seed replaced the whole object.
     */
    const demoted: DeploymentConfig = { ...LOCAL, backend: 'on-device' };
    const got = restoreDeployment({ ...NOTHING, config: demoted, intent: undefined });
    expect(got.config.local.endpoint).toBe('http://localhost:8787');
    expect(got.config.backend).toBe('on-device');
    // Nothing to adopt: on-device is not evidence of an off-device choice.
    expect(got.intent).toBeNull();
  });

  it('does not let a baked origin overwrite a stored config', () => {
    // A distribution build seeds its own origin ONLY on a fresh install. A user
    // who has since switched to their own local server must not be moved back
    // to the vendor's cloud every time the worker wakes.
    const got = restoreDeployment({
      ...NOTHING,
      config: LOCAL,
      intent: 'local',
      bakedOrigin: 'https://agent.example',
    });
    expect(got.config.backend).toBe('local');
    expect(got.config.cloud.endpoint).toBe('');
  });
});

describe('a MISSING config is the only thing that seeds or migrates', () => {
  it('seeds the baked origin on a fresh install', () => {
    const got = restoreDeployment({ ...NOTHING, bakedOrigin: 'https://agent.example' });
    expect(got.config.backend).toBe('cloud');
    expect(got.config.cloud.endpoint).toBe('https://agent.example');
    // A seeded off-device selection is adopted as intent, so a later demotion
    // is visible to the mismatch guard.
    expect(got.intent).toBe('cloud');
  });

  it('defaults to on-device when the build bakes nothing', () => {
    const got = restoreDeployment(NOTHING);
    expect(got.config).toEqual(defaultDeployment());
    expect(got.config.backend).toBe('on-device');
    expect(got.intent).toBeNull();
  });

  it('migrates a legacy loopback origin to `local`', () => {
    const got = restoreDeployment({ ...NOTHING, legacyOrigin: 'http://localhost:8787' });
    expect(got.config.backend).toBe('local');
    expect(got.config.local.endpoint).toBe('http://localhost:8787');
  });

  it('migrates a legacy https origin to `private`, not `cloud`', () => {
    // The conservative reading: it applies the stricter TLS rule and does not
    // assume somebody's own server is a public vendor.
    const got = restoreDeployment({ ...NOTHING, legacyOrigin: 'https://vllm.internal' });
    expect(got.config.backend).toBe('private');
    expect(got.config.private.endpoint).toBe('https://vllm.internal');
  });

  it('prefers the baked origin over a legacy one', () => {
    const got = restoreDeployment({
      ...NOTHING,
      bakedOrigin: 'https://agent.example',
      legacyOrigin: 'http://localhost:8787',
    });
    expect(got.config.backend).toBe('cloud');
  });
});

describe('intent', () => {
  it('honours a stored intent over the restored selection', () => {
    /*
     * The two are DIFFERENT FACTS and the guard exists to compare them. A user
     * who chose `cloud` and whose selection was later demoted to `on-device`
     * must come back with intent `cloud` and selection `on-device`, so
     * `backendMismatchRefusal` can refuse rather than plan on the wrong agent.
     */
    const got = restoreDeployment({
      ...NOTHING,
      config: { ...defaultDeployment(), cloud: { endpoint: 'https://a.example', model: '' } },
      intent: 'cloud',
    });
    expect(got.config.backend).toBe('on-device');
    expect(got.intent).toBe('cloud');
  });

  it('adopts a restored off-device selection when no intent was stored', () => {
    // A persisted off-device backend can only have got there through a
    // deliberate choice in an earlier session; that is the only surviving record
    // of it. Without this the guard compared against null and was inert in the
    // one case it was written for.
    const got = restoreDeployment({ ...NOTHING, config: LOCAL, intent: undefined });
    expect(got.intent).toBe('local');
  });

  it('ignores a stored intent that is not a backend kind', () => {
    for (const junk of ['', 'nonsense', 42, null, {}]) {
      const got = restoreDeployment({ ...NOTHING, config: LOCAL, intent: junk });
      // Falls through to adoption rather than carrying the junk.
      expect(got.intent).toBe('local');
    }
  });
});

describe('a corrupt stored config is treated as absent, not trusted', () => {
  it('rejects anything without a valid backend kind', () => {
    for (const junk of [null, 'local', 42, {}, { backend: 'nope' }, { backend: null }]) {
      const got = restoreDeployment({ ...NOTHING, config: junk });
      expect(got.config).toEqual(defaultDeployment());
    }
  });

  it('fills missing or malformed entries with empty strings rather than throwing', () => {
    const got = restoreDeployment({
      ...NOTHING,
      config: { backend: 'local', local: { endpoint: 'http://localhost:1', model: 7 } },
    });
    expect(got.config.local).toEqual({ endpoint: 'http://localhost:1', model: '' });
    expect(got.config.private).toEqual({ endpoint: '', model: '' });
    expect(got.config.cloud).toEqual({ endpoint: '', model: '' });
  });

  it('is idempotent: restoring its own output changes nothing', () => {
    // Rehydration runs on every wake, so this happens hundreds of times a
    // session. A restore that drifted would drift compoundingly.
    const once = restoreDeployment({ ...NOTHING, config: LOCAL, intent: 'local' });
    const twice = restoreDeployment({ ...NOTHING, config: once.config, intent: once.intent });
    expect(twice).toEqual(once);
  });
});
