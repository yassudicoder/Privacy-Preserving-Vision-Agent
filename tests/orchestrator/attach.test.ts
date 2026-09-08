import { describe, expect, it } from 'vitest';
import {
  decideAttachment,
  resolveTarget,
  type CurrentAttachment,
  type FollowTarget,
} from '@/orchestrator/index.ts';

/**
 * Which tab the agent is connected to, and when it may change its mind.
 *
 * This is the rule that decides when the extension may act on a page, so it is
 * tested as a rule rather than observed as a behaviour. Three properties matter
 * and each has its own section:
 *
 *   1. A READABLE URL IS THE PERMISSION. With no `tabs` permission declared,
 *      `tab.url` is populated only under a host permission or a live `activeTab`
 *      grant - so being able to read it is the same fact as being allowed to
 *      inject. `undefined` is therefore proof of NO access, and must never be
 *      softened into "assume the origin we remember".
 *   2. A RUN OWNS ITS TAB. Re-pointing mid-run would leave the loop driving one
 *      page while the panel named another.
 *   3. THE FOUR OUTCOMES ARE DISTINCT. "no page", "a page I may not read",
 *      "a page I may read but only until it navigates" and "connected" need
 *      four different things from the user, and collapsing any two sends them
 *      looking for a fault that is not there.
 */

const GRANTED: CurrentAttachment = { tabId: 7, origin: 'https://www.amazon.in', durable: true };

function decide(
  target: FollowTarget,
  opts: {
    durable?: boolean;
    current?: CurrentAttachment | null;
    loopRunning?: boolean;
  } = {},
): ReturnType<typeof decideAttachment> {
  return decideAttachment({
    loopRunning: opts.loopRunning ?? false,
    target,
    durable: opts.durable ?? false,
    current: opts.current ?? null,
    reason: 'tab activated',
  });
}

// --- 1. the url is the permission -------------------------------------------

describe('a readable url is what says the agent may act', () => {
  it('treats a present url as a drivable page and reads its origin', () => {
    const t = resolveTarget({ id: 3, windowId: 1, url: 'https://www.amazon.in/s?k=laptop' });
    expect(t).toEqual({ kind: 'page', tabId: 3, windowId: 1, origin: 'https://www.amazon.in' });
  });

  it('treats an absent url as NO ACCESS, never as the origin we remember', () => {
    /*
     * The bug this pins. The navigation handler used to fall back to the
     * PREVIOUS origin when the url came back undefined, then ask whether that
     * old origin was granted - so a tab that had navigated from a granted site
     * to an ungranted one reported "access retained" and stayed attached to a
     * page the extension could not read.
     */
    expect(resolveTarget({ id: 3, windowId: 1 })).toEqual({ kind: 'unreadable', tabId: 3 });
    expect(resolveTarget({ id: 3, windowId: 1, url: '' })).toEqual({ kind: 'unreadable', tabId: 3 });
  });

  it('refuses pages that parse but cannot be driven', () => {
    for (const url of ['about:blank', 'about:newtab']) {
      expect(resolveTarget({ id: 3, windowId: 1, url }).kind, url).toBe('undrivable');
    }
  });

  it('reports no target when there is no tab at all', () => {
    expect(resolveTarget(undefined).kind).toBe('none');
    expect(resolveTarget({ windowId: 1, url: 'https://x.invalid/' }).kind).toBe('none');
  });
});

// --- 2. a run owns its tab ---------------------------------------------------

describe('following is suspended while a task runs', () => {
  it('never re-points mid-run, whatever the browser is doing', () => {
    /*
     * `runTask` destructures `tabId` once and every step reuses it. A re-point
     * here would split the agent from the page it is reporting about, and the
     * only thing that re-reads the attachment live - the capture adapter - would
     * throw on every subsequent step with a message blaming navigation.
     */
    const elsewhere: FollowTarget = {
      kind: 'page',
      tabId: 99,
      windowId: 1,
      origin: 'https://other.invalid',
    };
    expect(decide(elsewhere, { loopRunning: true, current: GRANTED, durable: true }).kind).toBe(
      'suspended',
    );
    // Even a detach is withheld: the run's tab is not the follower's to drop.
    expect(
      decide({ kind: 'unreadable', tabId: 99 }, { loopRunning: true, current: GRANTED }).kind,
    ).toBe('suspended');
  });
});

// --- 3. the outcomes stay distinct -------------------------------------------

describe('the four situations are reported as four different things', () => {
  it('attaches, and records whether the access survives navigation', () => {
    const page: FollowTarget = {
      kind: 'page',
      tabId: 5,
      windowId: 2,
      origin: 'https://www.amazon.in',
    };

    const durable = decide(page, { durable: true });
    expect(durable).toEqual({
      kind: 'attach',
      tabId: 5,
      windowId: 2,
      origin: 'https://www.amazon.in',
      durable: true,
    });

    /*
     * A readable url with NO host permission means a live `activeTab` grant, and
     * that dies at the next navigation - including the agent's own click. It
     * still attaches: the extension may act right now. What changes is that the
     * panel is not entitled to call it connected without a caveat.
     */
    const transient = decide(page, { durable: false });
    expect(transient.kind).toBe('attach');
    expect(transient.kind === 'attach' && transient.durable).toBe(false);
  });

  it('offers to enable when arriving somewhere unreadable with nothing attached', () => {
    const d = decide({ kind: 'unreadable', tabId: 9 }, { current: null });
    expect(d.kind).toBe('no-access');
    expect(d.kind === 'no-access' && d.note).toContain('not enabled yet');
  });

  it('explains the loss when the page we were on becomes unreadable', () => {
    // Same tab, now unreadable: a cross-origin navigation took the access away.
    const d = decide({ kind: 'unreadable', tabId: 7 }, { current: GRANTED });
    expect(d.kind).toBe('detach');
    expect(d.kind === 'detach' && d.reason).toContain('access');
  });

  it('names the switch when the user moves to a site that is not enabled', () => {
    const d = decide({ kind: 'unreadable', tabId: 42 }, { current: GRANTED });
    expect(d.kind).toBe('detach');
    expect(d.kind === 'detach' && d.reason).toContain('not enabled on');
  });

  it('does nothing at all when nothing changed', () => {
    /*
     * `tabs.onActivated` and `windows.onFocusChanged` both fire when a user
     * clicks back to the window they were already in. Re-attaching would
     * re-inject and re-broadcast on every alt-tab.
     */
    const same: FollowTarget = {
      kind: 'page',
      tabId: 7,
      windowId: 1,
      origin: 'https://www.amazon.in',
    };
    expect(decide(same, { durable: true, current: GRANTED }).kind).toBe('keep');
  });

  it('re-attaches when only the DURABILITY changed', () => {
    /*
     * The user granting the site from chrome://extensions changes nothing about
     * which tab is active - only whether the connection will survive the agent's
     * first click. The panel has to be told, so this is not a `keep`.
     */
    const same: FollowTarget = {
      kind: 'page',
      tabId: 7,
      windowId: 1,
      origin: 'https://www.amazon.in',
    };
    const d = decide(same, { durable: true, current: { ...GRANTED, durable: false } });
    expect(d.kind).toBe('attach');
    expect(d.kind === 'attach' && d.durable).toBe(true);
  });
});
