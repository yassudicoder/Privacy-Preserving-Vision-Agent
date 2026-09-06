// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';

/**
 * Does the shipped panel actually render?
 *
 * WHY THIS EXISTS. v0.4.3 shipped a panel that was blank. `let budgetTokens` was
 * declared below `draw()` while `draw()` referenced it, so the first render threw
 * a temporal-dead-zone ReferenceError and Preact rendered nothing. `tsc --noEmit`
 * passed - TDZ is a runtime error, there is no linter in this project, and every
 * other test exercises COMPONENTS rather than the entrypoint that mounts them.
 *
 * So the whole suite was green against a build whose main surface did not come
 * up, and the failure was invisible: no error line, no partial UI, just a dark
 * rectangle. That is the worst shape a bug can take here, and it had no guard at
 * all.
 *
 * This one evaluates the ACTUAL emitted chunk against a stubbed extension API,
 * which is as close to "did it boot" as Node can get.
 *
 * Not part of `npm test`: it needs `.output/`, so it runs under `test:built`
 * alongside the manifest and bundle assertions.
 */

const ROOT = join(process.cwd(), '.output', 'chrome-mv3');

/** Records what the panel asked the background, so the calls can be asserted. */
function stubExtensionApi(): { sent: unknown[] } {
  const sent: unknown[] = [];
  const runtime = {
    sendMessage: (msg: unknown) => {
      sent.push(msg);
      // Every command answers "nothing to report" rather than rejecting: a
      // rejection path would exercise error handling instead of first render.
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: () => {}, removeListener: () => {} },
    getURL: (p: string) => `chrome-extension://test/${p}`,
    getManifest: () => ({ version: '0.0.0-test' }),
    id: 'test',
    lastError: undefined,
  };
  const api = {
    runtime,
    storage: {
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    permissions: { request: () => Promise.resolve(false), contains: () => Promise.resolve(false) },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve({}) },
    sidePanel: { open: () => Promise.resolve() },
    action: { onClicked: { addListener: () => {} } },
  };
  (globalThis as Record<string, unknown>)['chrome'] = api;
  (globalThis as Record<string, unknown>)['browser'] = api;
  return { sent };
}

function sidepanelChunk(): string | null {
  const dir = join(ROOT, 'chunks');
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.startsWith('sidepanel-') && f.endsWith('.js'));
  return hit === undefined ? null : join(dir, hit);
}

describe('the built side panel boots', () => {
  beforeEach(() => {
    // The id the shipped sidepanel.html actually uses.
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('has a sidepanel chunk to load', () => {
    expect(sidepanelChunk()).not.toBeNull();
  });

  it('renders without throwing, and puts something in the DOM', async () => {
    /*
     * THE ASSERTION THAT CATCHES THE BLANK PANEL. Verified by reintroducing the
     * bug and rebuilding: this fails with
     *   ReferenceError: Cannot access 'Te' before initialization
     * ('Te' being the minified `budgetTokens`).
     */
    const chunk = sidepanelChunk();
    if (chunk === null) return;
    stubExtensionApi();

    await import(pathToFileURL(chunk).href);
    // Preact renders synchronously on mount; a microtask turn covers any
    // promise-driven redraw the panel does on boot.
    await Promise.resolve();

    const app = document.getElementById('root');
    expect(app).not.toBeNull();
    expect((app?.innerHTML ?? '').length).toBeGreaterThan(0);

    /*
     * THE BACKEND PICKER IS IN THE SHIPPED BUNDLE, not just in a component test.
     *
     * Asserted HERE and not in a second `it`, because ES modules are cached: a
     * re-import of the same chunk would not re-execute it, and the assertion
     * would silently be checking a DOM nobody rendered. The panel's whole
     * deployment story is unreachable if this section does not mount, and the
     * blank-panel failure this file exists for is exactly the kind that takes a
     * whole section out without an error line.
     */
    const html = app?.innerHTML ?? '';
    const radios = [...(app?.querySelectorAll('input[name="backend"]') ?? [])];
    // CLOUD FIRST. A distribution build ships with the cloud endpoint already
    // configured and granted, so the common case is a user who never opens the
    // rest - which lives behind the Advanced disclosure below it.
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([
      'cloud',
      'on-device',
      'local',
      'private',
    ]);
    expect(app?.querySelector('details.advanced-backends')).not.toBeNull();
    // The privacy receipt card, and its "nothing measured yet" state - the panel
    // must not claim a boundary result before a step has produced one.
    expect(html).toContain('Privacy receipt');
    expect(html).toContain('No step has run yet');
  });

  it('ships the styles the backend picker needs', () => {
    /*
     * The markup and the stylesheet are emitted as separate assets, so the
     * picker can render into a bundle whose CSS was never rebuilt and come out
     * as an unreadable stack of inputs. Cheap to check, and it is the half a
     * component test cannot see.
     */
    const dir = join(ROOT, 'assets');
    if (!existsSync(dir)) return;
    const css = readdirSync(dir).find((f) => f.startsWith('sidepanel-') && f.endsWith('.css'));
    expect(css).toBeDefined();
    if (css === undefined) return;
    const text = readFileSync(join(dir, css), 'utf8');
    expect(text).toContain('.backend-option');
    expect(text).toContain('.backend-fields');
  });
});
