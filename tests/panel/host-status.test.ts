import { describe, expect, it } from 'vitest';
import { elementRef } from '@/contracts/index.ts';
import { initialPanelState, reducePanel } from '@/panel/index.ts';

/**
 * The panel's view of what the runtime can actually do.
 *
 * The brief for the temporary UI is explicit: where something is not
 * implemented, show its real state rather than pretending. So the panel needs a
 * slice describing the host - which backend, whether it is running, whether a
 * model is loaded - and it has to distinguish "idle" from "cannot work at all".
 */

describe('host/status', () => {
  it('starts with no host known, which is not the same as a stopped host', () => {
    // null means "never reported". Rendering that as "stopped" would claim
    // knowledge the panel does not have.
    expect(initialPanelState.host).toBeNull();
  });

  it('records the backend that reported in', () => {
    const s = reducePanel(initialPanelState, {
      type: 'host/status',
      kind: 'firefox-background-page',
      running: false,
      modelLoaded: false,
      note: 'no model weights are bundled yet',
    });
    expect(s.host?.kind).toBe('firefox-background-page');
    expect(s.host?.running).toBe(false);
    expect(s.host?.modelLoaded).toBe(false);
    expect(s.host?.note).toMatch(/no model/);
  });

  it('keeps the note, because it is the only place the missing model is visible', () => {
    const s = reducePanel(initialPanelState, {
      type: 'host/status',
      kind: 'chrome-offscreen',
      running: true,
      modelLoaded: false,
      note: 'InferenceBackend not implemented',
    });
    // Running but no model: the exact state today, and the one a panel that
    // only showed a green dot would misreport as healthy.
    expect(s.host?.running).toBe(true);
    expect(s.host?.modelLoaded).toBe(false);
  });

  it('replaces rather than accumulates', () => {
    let s = reducePanel(initialPanelState, {
      type: 'host/status',
      kind: 'chrome-offscreen',
      running: false,
      modelLoaded: false,
      note: 'a',
    });
    s = reducePanel(s, {
      type: 'host/status',
      kind: 'chrome-offscreen',
      running: true,
      modelLoaded: false,
      note: 'b',
    });
    expect(s.host?.running).toBe(true);
    expect(s.host?.note).toBe('b');
  });
});

describe('the panel tracks what the agent last did', () => {
  it('has no action before anything runs', () => {
    expect(initialPanelState.lastAction).toBeNull();
    expect(initialPanelState.lastExecution).toBeNull();
  });

  it('records the action and whether executing it worked', () => {
    const s = reducePanel(initialPanelState, {
      type: 'action/executed',
      action: { type: 'click', ref: elementRef('e3') },
      ok: true,
      ms: 12,
    });
    expect(s.lastAction).toEqual({ type: 'click', ref: 'e3' });
    expect(s.lastExecution).toEqual({ ok: true, ms: 12 });
  });

  it('records a failed execution as a failure, not as an absence', () => {
    // ok:false is a page-level miss - a stale ref, a vanished button. The panel
    // must show that it was attempted and missed, not show nothing.
    const s = reducePanel(initialPanelState, {
      type: 'action/executed',
      action: { type: 'click', ref: elementRef('e9') },
      ok: false,
      ms: 3,
    });
    expect(s.lastExecution).toEqual({ ok: false, ms: 3 });
    expect(s.lastAction).not.toBeNull();
  });
});

describe('the panel knows how much of the page it described', () => {
  it('counts the elements actually sent', () => {
    // Metric 1 is 25% of the score and this is its only visible proxy.
    const s = reducePanel(initialPanelState, {
      type: 'context/sent',
      bytes: 4096,
      imageBytes: 0,
      elementCount: 17,
      elementsAvailable: 17,
      estimatedTokens: 900,
      tokenBudget: 3400,
      dropped: [],
      namesTruncated: 0,
      geometryOmitted: false,
      duplicatesCollapsed: 0,
    });
    expect(s.elementCount).toBe(17);
  });
});

describe('origin/status', () => {
  it('starts null: never asked is not the same as declined', () => {
    expect(initialPanelState.serverOrigin).toBeNull();
  });

  it('records a granted origin', () => {
    const s = reducePanel(initialPanelState, {
      type: 'origin/status',
      origin: 'https://agent.example.com',
      granted: true,
      error: null,
    });
    expect(s.serverOrigin).toEqual({
      origin: 'https://agent.example.com',
      granted: true,
      error: null,
    });
  });

  it('records a refusal as a refusal, keeping the origin that was asked for', () => {
    // The user declining the prompt is a normal outcome. Dropping the origin
    // would make the panel look like nothing was ever attempted.
    const s = reducePanel(initialPanelState, {
      type: 'origin/status',
      origin: 'https://agent.example.com',
      granted: false,
      error: null,
    });
    expect(s.serverOrigin?.granted).toBe(false);
    expect(s.serverOrigin?.origin).toBe('https://agent.example.com');
  });

  it('records a rejected URL with its reason and no origin', () => {
    const s = reducePanel(initialPanelState, {
      type: 'origin/status',
      origin: null,
      granted: false,
      error: 'wildcard host patterns are not accepted',
    });
    expect(s.serverOrigin?.error).toMatch(/wildcard/);
    expect(s.serverOrigin?.origin).toBeNull();
  });
});

describe('the model figures the panel shows', () => {
  const base = {
    type: 'host/status',
    kind: 'chrome-offscreen',
    running: true,
  } as const;

  it('records what init actually measured', () => {
    const s = reducePanel(initialPanelState, {
      ...base,
      modelLoaded: true,
      note: 'webgpu, 25.01 MB in 1840 ms',
      model: { backend: 'webgpu', loadMs: 1840, weightBytes: 26_227_993 },
    });
    expect(s.host?.model).toEqual({
      backend: 'webgpu',
      loadMs: 1840,
      weightBytes: 26_227_993,
    });
  });

  it('leaves the figures NULL rather than zero when no model has loaded', () => {
    /*
     * The distinction the panel depends on. Zeroes would render as "0.00 MB" on
     * backend "" - a loaded model that failed to measure - when the truth is
     * that nothing was ever asked to load. `exactOptionalPropertyTypes` makes
     * the absent case expressible; this test is what keeps it meaningful.
     */
    const s = reducePanel(initialPanelState, {
      ...base,
      modelLoaded: false,
      note: 'host running; model not loaded yet - send host/init to load it',
    });
    expect(s.host?.model).toBeNull();
    expect(s.host?.modelLoaded).toBe(false);
  });

  it('reports the backend that loaded, even when it is not the one wanted', () => {
    // preferredBackend is webgpu everywhere in this project. A panel that showed
    // the request rather than the result would hide an order-of-magnitude
    // slowdown behind a healthy-looking line.
    const s = reducePanel(initialPanelState, {
      ...base,
      modelLoaded: true,
      note: 'wasm, 25.01 MB in 9200 ms',
      model: { backend: 'wasm', loadMs: 9200, weightBytes: 26_227_993 },
    });
    expect(s.host?.model?.backend).toBe('wasm');
  });

  it('keeps a failed load visible as not-loaded with the reason in the note', () => {
    const s = reducePanel(initialPanelState, {
      ...base,
      modelLoaded: false,
      note: 'model failed to load: could not load Xenova/yolos-tiny after 30012 ms - webgpu: no adapter; wasm: fetch failed',
    });
    expect(s.host?.modelLoaded).toBe(false);
    expect(s.host?.model).toBeNull();
    expect(s.host?.note).toMatch(/no adapter/);
  });

  it('clears stale figures when a later status arrives without them', () => {
    // Restarting the host resets the model. Carrying the old numbers forward
    // would leave the panel asserting a model that is no longer resident.
    const loaded = reducePanel(initialPanelState, {
      ...base,
      modelLoaded: true,
      note: 'webgpu',
      model: { backend: 'webgpu', loadMs: 1840, weightBytes: 26_227_993 },
    });
    const restarted = reducePanel(loaded, {
      ...base,
      running: false,
      modelLoaded: false,
      note: 'host not started',
    });
    expect(restarted.host?.model).toBeNull();
  });
});

describe('which tab the extension may drive', () => {
  it('records the tab pinned at grant time', () => {
    /*
     * An event WITHOUT the newer fields still reduces cleanly, and to the
     * cautious values: no origin known, and access assumed non-durable. A
     * missing `durable` must not read as `true` - that would put the panel one
     * step from claiming a multi-step task will survive when nothing said so.
     */
    const s = reducePanel(initialPanelState, {
      type: 'tab/attached',
      tabId: 42,
      note: 'attached to tab 42',
    });
    expect(s.attachedTab).toEqual({
      tabId: 42,
      note: 'attached to tab 42',
      origin: null,
      durable: false,
    });
  });

  it('carries the site and its durability when the background reports them', () => {
    const s = reducePanel(initialPanelState, {
      type: 'tab/attached',
      tabId: 7,
      note: 'connected to https://www.amazon.in',
      origin: 'https://www.amazon.in',
      durable: true,
    });
    expect(s.attachedTab?.origin).toBe('https://www.amazon.in');
    expect(s.attachedTab?.durable).toBe(true);
  });

  it('distinguishes "no tab" from "a tab this agent may not read"', () => {
    /*
     * Both arrive as `tabId: null`, and they need different remedies: one is
     * "open a page", the other is "this page needs one click to enable". The
     * note is what carries that, so it must not be collapsed into a constant.
     */
    const noTab = reducePanel(initialPanelState, {
      type: 'tab/attached',
      tabId: null,
      note: 'no tab attached - click the toolbar button on the page you want to drive',
    });
    const noAccess = reducePanel(initialPanelState, {
      type: 'tab/attached',
      tabId: null,
      origin: null,
      durable: false,
      note: 'this site is not enabled yet - click the toolbar button on it to connect',
    });
    expect(noTab.attachedTab?.note).not.toBe(noAccess.attachedTab?.note);
    expect(noAccess.attachedTab?.note).toContain('not enabled yet');
  });

  it('starts unknown rather than pretending to be detached', () => {
    /*
     * Null means "the background has not said yet". That is different from
     * tabId: null, which means "asked, and there is no access". The panel
     * renders them differently because the remedy differs: wait, versus click
     * the toolbar button.
     */
    expect(initialPanelState.attachedTab).toBeNull();
  });

  it('shows detachment with the reason, not as a bare failure', () => {
    const attached = reducePanel(initialPanelState, {
      type: 'tab/attached',
      tabId: 42,
      note: 'attached to tab 42',
    });
    const lost = reducePanel(attached, {
      type: 'tab/attached',
      tabId: null,
      note: 'page access lost: the page navigated, which revokes activeTab',
    });
    // A step failing after a navigation is indistinguishable from a broken
    // agent unless the panel says which happened.
    expect(lost.attachedTab?.tabId).toBeNull();
    expect(lost.attachedTab?.note).toMatch(/navigated/);
  });

  it('replaces the attachment when the user attaches a different tab', () => {
    const first = reducePanel(initialPanelState, {
      type: 'tab/attached',
      tabId: 7,
      note: 'attached to tab 7',
    });
    const second = reducePanel(first, {
      type: 'tab/attached',
      tabId: 9,
      note: 'attached to tab 9',
    });
    // Only one tab is ever attached. Accumulating them would let a step run
    // against a tab whose grant is long gone.
    expect(second.attachedTab?.tabId).toBe(9);
  });
});
