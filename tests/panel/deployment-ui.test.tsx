// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackendDescriptor, BackendKind } from '@/contracts/index.ts';
import { App, initialPanelState, type PanelState } from '@/panel/index.ts';

/**
 * The deployment UI, rendered for real.
 *
 * `tests/built/sidepanel-smoke.test.ts` already proves the emitted chunk mounts;
 * this proves the controls in it do what they claim. Both matter and neither
 * substitutes for the other - v0.4.3 shipped a blank side panel that 835
 * component tests were green against, because every one of them rendered
 * components rather than the entrypoint that mounts them.
 *
 * The assertions worth having here are the ones about what must NOT be on
 * screen: a token, a health claim that was never measured, or a fallback that
 * happens without a click.
 */

const HOST: PanelState['host'] = {
  kind: 'chrome-offscreen',
  running: true,
  modelLoaded: true,
  note: '',
  model: null,
};

const CLOUD: BackendDescriptor = {
  kind: 'cloud',
  endpoint: 'https://api.example.com',
  model: 'hosted-vlm',
  offDevice: true,
  authenticated: true,
  encrypted: true,
};

let root: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) {
    render(null, root);
    root.remove();
    root = null;
  }
});

function mount(state: PanelState, props: Record<string, unknown> = {}): HTMLElement {
  root = document.createElement('div');
  document.body.appendChild(root);
  render(
    <App
      state={state}
      onSelectBackend={() => undefined}
      onConfigureBackend={() => undefined}
      onSetBackendToken={() => undefined}
      onCheckBackend={() => undefined}
      {...props}
    />,
    root,
  );
  return root;
}

function base(over: Partial<PanelState> = {}): PanelState {
  return { ...initialPanelState, host: HOST, ...over };
}

describe('the backend picker', () => {
  it('renders one option per deployment kind, cloud first', () => {
    /*
     * ORDER IS THE POINT, not an incidental. A distribution build ships with the
     * cloud endpoint already configured and granted, so the common case is a
     * user who never opens the rest. Cloud sits at the top level; the other
     * three are behind Advanced.
     */
    const el = mount(base({ deployment: CLOUD }));
    const radios = [...el.querySelectorAll('input[name="backend"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['cloud', 'on-device', 'local', 'private']);
  });

  it('keeps cloud out of the Advanced section and the rest inside it', () => {
    const el = mount(base({ deployment: CLOUD }));
    const advanced = el.querySelector('details.advanced-backends');
    expect(advanced).not.toBeNull();

    // Collapsed by default: `open` is absent unless someone expands it.
    expect((advanced as HTMLDetailsElement).open).toBe(false);

    expect(advanced?.querySelector('input[value="cloud"]')).toBeNull();
    for (const kind of ['on-device', 'local', 'private']) {
      expect(advanced?.querySelector(`input[value="${kind}"]`), kind).not.toBeNull();
    }
  });

  it('still offers the other three deployments, rather than deleting them', () => {
    /*
     * The project's contribution is "intelligence anywhere, privacy always
     * local", and a claim with one deployment left is not demonstrable. Hidden
     * is fine; gone is not.
     */
    const el = mount(base({ deployment: CLOUD }));
    expect(el.textContent ?? '').toContain('On-device');
    expect(el.textContent ?? '').toContain('Private Organization Server');
  });

  it('marks exactly one as selected, and it is the one the background reported', () => {
    const el = mount(base({ deployment: CLOUD }));
    const checked = [...el.querySelectorAll('input[name="backend"]')].filter(
      (r) => (r as HTMLInputElement).checked,
    );
    expect(checked).toHaveLength(1);
    expect((checked[0] as HTMLInputElement).value).toBe('cloud');
  });

  it('disables an off-device kind with no endpoint, rather than hiding it', () => {
    /*
     * A missing option reads as "not supported". A disabled one with its fields
     * beneath it reads as "fill this in first", which is what is actually true.
     */
    const el = mount(base({ deployment: CLOUD }), {
      backendConfig: { local: { endpoint: '', model: '' } },
    });
    const local = el.querySelector('input[value="local"]') as HTMLInputElement | null;
    expect(local?.disabled).toBe(true);
    const onDevice = el.querySelector('input[value="on-device"]') as HTMLInputElement | null;
    // on-device needs no configuration and is therefore always available.
    expect(onDevice?.disabled).toBe(false);
  });

  it('calls onSelectBackend when a kind is chosen, and nothing else', () => {
    const picked: BackendKind[] = [];
    const el = mount(base({ deployment: CLOUD }), {
      onSelectBackend: (k: BackendKind) => picked.push(k),
      backendConfig: { local: { endpoint: 'http://localhost:8787', model: '' } },
    });
    const local = el.querySelector('input[value="local"]') as HTMLInputElement;
    local.checked = true;
    local.dispatchEvent(new Event('change', { bubbles: true }));
    expect(picked).toEqual(['local']);
  });

  it('shows the stored endpoint and model, not a placeholder', () => {
    // A field that falls back to a placeholder while a different value is in
    // force is worse than no field: the only way to reach the real value is to
    // retype it. The same reasoning as the context-budget input.
    const el = mount(base({ deployment: CLOUD }), {
      backendConfig: { cloud: { endpoint: 'https://api.example.com', model: 'hosted-vlm' } },
    });
    const values = [...el.querySelectorAll('input[name="endpoint"], input[name="model"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(values).toContain('https://api.example.com');
    expect(values).toContain('hosted-vlm');
  });

  it('offers no endpoint field for on-device, because it reaches nothing', () => {
    const el = mount(base({ deployment: CLOUD }));
    const onDeviceCard = [...el.querySelectorAll('.backend-option')].find((c) =>
      c.querySelector('input[value="on-device"]'),
    );
    expect(onDeviceCard).toBeDefined();
    expect(onDeviceCard?.querySelector('input[name="endpoint"]')).toBeNull();
    expect(onDeviceCard?.querySelector('input[name="token"]')).toBeNull();
  });
});

describe('the token field', () => {
  it('is a password input and is cleared after submit', () => {
    const handed: { kind: BackendKind; token: string }[] = [];
    const el = mount(base({ deployment: CLOUD }), {
      onSetBackendToken: (kind: BackendKind, token: string) => handed.push({ kind, token }),
      backendConfig: { cloud: { endpoint: 'https://api.example.com', model: '' } },
    });

    const cloudCard = [...el.querySelectorAll('.backend-option')].find((c) =>
      c.querySelector('input[value="cloud"]'),
    );
    const input = cloudCard?.querySelector('input[name="token"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');

    input.value = 'sk-not-a-real-key';
    (input.closest('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(handed).toEqual([{ kind: 'cloud', token: 'sk-not-a-real-key' }]);
    /*
     * CLEARED FROM THE DOM. This field is the only place in the UI a credential
     * ever exists, and it has no reason to persist there after being handed over
     * - a rendered page is screenshotted, screen-shared and inspected.
     */
    expect(input.value).toBe('');
  });

  it('says whether a token is set without being able to show it', () => {
    const el = mount(base({ deployment: CLOUD }), {
      tokenSet: { cloud: true },
      backendConfig: { cloud: { endpoint: 'https://api.example.com', model: '' } },
    });
    const cloudCard = [...el.querySelectorAll('.backend-option')].find((c) =>
      c.querySelector('input[value="cloud"]'),
    );
    const input = cloudCard?.querySelector('input[name="token"]') as HTMLInputElement;
    expect(input.placeholder).toContain('token set');
    // The placeholder is the ONLY signal. There is no prop carrying a value.
    expect(input.value).toBe('');
    expect(el.textContent ?? '').toContain('never in the payload');
  });
});

describe('backend health', () => {
  it('says "not checked" rather than implying a state it never measured', () => {
    const el = mount(base({ deployment: CLOUD }), {
      backendConfig: { cloud: { endpoint: 'https://api.example.com', model: '' } },
    });
    expect(el.textContent ?? '').toContain('not checked');
    expect(el.textContent ?? '').not.toContain('Connected');
  });

  it('shows the planner the server named once probed', () => {
    const el = mount(
      base({
        deployment: CLOUD,
        backendHealth: {
          kind: 'cloud',
          reachable: true,
          plannerId: 'qwen2.5vl:3b',
          description: null,
          error: null,
          checkedAtMs: 1,
        },
      }),
      { backendConfig: { cloud: { endpoint: 'https://api.example.com', model: '' } } },
    );
    expect(el.textContent ?? '').toContain('Connected');
    expect(el.textContent ?? '').toContain('qwen2.5vl:3b');
  });

  it('reports unavailable with the reason', () => {
    const el = mount(
      base({
        deployment: CLOUD,
        backendHealth: {
          kind: 'cloud',
          reachable: false,
          plannerId: null,
          description: null,
          error: 'could not reach https://api.example.com',
          checkedAtMs: 1,
        },
      }),
      { backendConfig: { cloud: { endpoint: 'https://api.example.com', model: '' } } },
    );
    expect(el.textContent ?? '').toContain('Unavailable');
    expect(el.textContent ?? '').toContain('could not reach');
  });
});

describe('the unavailable-backend prompt', () => {
  const state = base({
    deployment: CLOUD,
    backendUnavailable: {
      kind: 'private',
      endpoint: 'https://ai.example.com',
      error: 'could not reach https://ai.example.com',
      alternatives: ['on-device', 'local'],
    },
  });

  it('states that nothing was sent and nothing was tried', () => {
    const el = mount(state);
    const text = el.textContent ?? '';
    expect(text).toContain('Nothing was sent anywhere');
    expect(text).toContain('No other backend was tried');
  });

  it('renders one button per alternative, plus a retry', () => {
    const el = mount(state);
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels).toContain('Retry');
    expect(labels.some((l) => l.includes('On-device'))).toBe(true);
    expect(labels.some((l) => l.includes('Local AI'))).toBe(true);
    // Cloud is NOT offered: it has no endpoint in this config, and offering a
    // switch to an unconfigured backend offers a second failure.
    expect(labels.some((l) => l.includes('Use Cloud AI'))).toBe(false);
  });

  it('switches only when a button is actually clicked', () => {
    const picked: BackendKind[] = [];
    const el = mount(state, { onSelectBackend: (k: BackendKind) => picked.push(k) });

    // Rendering alone must change nothing. This is the whole guarantee.
    expect(picked).toEqual([]);

    const button = [...el.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Local AI'),
    );
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picked).toEqual(['local']);
  });
});

describe('the privacy receipt card', () => {
  it('says nothing has been measured before a step runs', () => {
    const el = mount(base({ deployment: CLOUD }));
    expect(el.textContent ?? '').toContain('No step has run yet');
  });

  it('renders NOT CHECKED for a step that never reached the gate', () => {
    /*
     * The assertion this card exists for. "NOT SENT" printed unconditionally
     * would be true here and worthless - it is equally true of a step that did
     * nothing at all.
     */
    const el = mount(
      base({
        deployment: CLOUD,
        receipt: { ...initialPanelState.receipt, step: 3, e2eMs: 40 },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('NOT CHECKED');
    expect(text).toContain('the step did not reach the gate');
  });

  it('shows the number of fields checked when the gate did run', () => {
    const el = mount(
      base({
        deployment: CLOUD,
        receipt: {
          ...initialPanelState.receipt,
          step: 3,
          e2eMs: 40,
          network: {
            ...initialPanelState.receipt.network,
            rawPii: { state: 'verified-absent', checkedFields: 42 },
          },
        },
      }),
    );
    expect(el.textContent ?? '').toContain('42 field(s) checked');
  });
});
