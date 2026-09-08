/**
 * Deciding which tab the agent is connected to.
 *
 * WHY THIS IS A MODULE AND NOT A BLOCK INSIDE `background.ts`. The rule it
 * encodes is a security rule - when the extension may act on a page - and the
 * entrypoint is the one place in this codebase that cannot be unit tested.
 * `background.ts` keeps the browser plumbing (listeners, `tabs.query`,
 * `permissions.contains`, injection); everything that decides is here.
 *
 * THE BROWSER CEILING, established from the Chrome and MDN references rather
 * than assumed, because the feature is only honest if this is right:
 *
 *   - `tabs.onActivated` and `windows.onFocusChanged` fire with NO permission.
 *     They carry ids only, which is enough to know something changed.
 *   - `scripting.executeScript` works on a tab covered by an optional host
 *     permission granted EARLIER - no gesture, no `activeTab` - and that grant
 *     survives navigation and browser restart. This is the only mechanism that
 *     can carry a multi-step task.
 *   - `permissions.request` requires a user gesture, and the gesture is lost at
 *     the first `await`. So the once-per-site approval cannot be automated.
 *
 * There is therefore NO way to reach a site the user has never approved. What is
 * achievable is that approval happens once per site, and after that every tab on
 * that site connects silently, forever.
 *
 * THE URL IS THE PERMISSION TEST. `tab.url` is populated only under the `tabs`
 * permission (not declared here - it would expose every tab's address), a
 * matching host permission, or a live `activeTab` grant. With no `tabs`
 * permission, being able to READ a tab's url is the same fact as being allowed
 * to INJECT into it. So the decision below never needs to ask "may I?" as a
 * separate question - it already knows.
 */

/** What prompted a re-evaluation. Carried into the message the user reads. */
export type FollowReason =
  | 'tab activated'
  | 'window focused'
  | 'page navigated'
  | 'permission changed'
  | 'startup';

/** The active tab as the browser described it. `url` absent means no access. */
export interface ActiveTabInfo {
  readonly id?: number | undefined;
  readonly windowId?: number | undefined;
  readonly url?: string | undefined;
}

/** What the extension is attached to right now. */
export interface CurrentAttachment {
  readonly tabId: number;
  readonly origin: string | null;
  readonly durable: boolean;
}

/** Step one: what, if anything, is on screen that could be driven. */
export type FollowTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly tabId: number }
  | { readonly kind: 'undrivable'; readonly tabId: number }
  | {
      readonly kind: 'page';
      readonly tabId: number;
      readonly windowId: number;
      readonly origin: string;
    };

/**
 * Classify the active tab. PURE, and deliberately does not consult permissions:
 * the url has already answered that question by existing or not.
 */
export function resolveTarget(active: ActiveTabInfo | undefined): FollowTarget {
  const tabId = active?.id;
  if (active === undefined || tabId === undefined) return { kind: 'none' };

  const url = active.url;
  /*
   * UNDEFINED IS PROOF OF NO ACCESS, and reading it as anything softer is what
   * the navigation handler used to do: on a cross-origin hop it fell back to the
   * origin it remembered, asked whether THAT was granted, and reported "access
   * retained" for a page it could no longer read.
   */
  if (url === undefined || url === '') return { kind: 'unreadable', tabId };

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { kind: 'undrivable', tabId };
  }
  // `about:blank` and friends parse but have no drivable origin.
  if (origin === 'null' || origin === '') return { kind: 'undrivable', tabId };

  return { kind: 'page', tabId, windowId: active.windowId ?? 0, origin };
}

export type AttachDecision =
  | { readonly kind: 'suspended' }
  | { readonly kind: 'keep' }
  | { readonly kind: 'detach'; readonly reason: string }
  | { readonly kind: 'no-access'; readonly note: string }
  | {
      readonly kind: 'attach';
      readonly tabId: number;
      readonly windowId: number;
      readonly origin: string;
      readonly durable: boolean;
    };

export interface DecideInput {
  readonly loopRunning: boolean;
  readonly target: FollowTarget;
  /** Whether a host permission covers the target origin. Irrelevant unless `page`. */
  readonly durable: boolean;
  readonly current: CurrentAttachment | null;
  readonly reason: FollowReason;
}

/**
 * Step two: what to do about it.
 *
 * `durable` does not gate attachment - a readable url already established that
 * the extension may act. It changes only what the panel is entitled to say: an
 * `activeTab` grant dies at the next navigation, including the agent's own
 * click, and a multi-step task on one of those will stop partway. Reporting the
 * two identically is what made "it worked once and then stopped" the most common
 * way this agent failed.
 */
export function decideAttachment(input: DecideInput): AttachDecision {
  /*
   * A RUN OWNS THE TAB IT STARTED ON. `runTask` reads `tabId` once and every
   * step reuses it, so re-pointing mid-run would leave the loop driving the old
   * page while the panel named a new one - and the capture adapter, the only
   * thing that re-reads the attachment live, would throw on every step with a
   * message blaming navigation. Same rule the deployment controls already
   * follow: finish or stop first.
   */
  if (input.loopRunning) return { kind: 'suspended' };

  const { target, current } = input;

  if (target.kind === 'none') {
    return current === null
      ? { kind: 'no-access', note: 'no page open that the agent can drive' }
      : { kind: 'detach', reason: 'the page is gone' };
  }

  if (target.kind === 'undrivable') {
    return current === null
      ? { kind: 'no-access', note: 'this page cannot be driven' }
      : { kind: 'detach', reason: 'this page cannot be driven' };
  }

  if (target.kind === 'unreadable') {
    /*
     * Two different situations, and they need different remedies. Losing a page
     * you had is a failure to explain; arriving at a page you never had is an
     * offer to make. Collapsing them sends the user hunting for a fault that is
     * not there.
     */
    if (current !== null && current.tabId === target.tabId) {
      return { kind: 'detach', reason: 'this page is not one the agent has access to' };
    }
    if (current !== null) {
      return { kind: 'detach', reason: `switched to a site the agent is not enabled on (${input.reason})` };
    }
    return {
      kind: 'no-access',
      note: 'this site is not enabled yet - click the toolbar button on it to connect',
    };
  }

  const unchanged =
    current !== null &&
    current.tabId === target.tabId &&
    current.origin === target.origin &&
    current.durable === input.durable;
  if (unchanged) return { kind: 'keep' };

  return {
    kind: 'attach',
    tabId: target.tabId,
    windowId: target.windowId,
    origin: target.origin,
    durable: input.durable,
  };
}
