import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { executeAction } from '@/execution/index.ts';
import { accessibleName, elementRole, resolveDomPath, stampGeometry } from '@/redaction/index.ts';
import {
  type Action,
  type DomPath,
  type PrivacyLensRegion,
  type RectProvider,
  markUntrusted,
  neutralize,
  rect,
  unsafeUnwrap,
} from '@/contracts/index.ts';

/**
 * The only code that touches the page.
 *
 * Everything read here is `Untrusted<string>` from the moment it is read. The
 * content script never talks to the server and never makes a decision - it
 * reports what is on the page and executes an action that has already been
 * validated upstream.
 */

/** Real layout. The jsdom counterpart reads data-test-rect instead. */
const liveRects: RectProvider = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return rect('css-viewport', r.x, r.y, r.width, r.height);
};

/*
 * The Privacy Lens is deliberately a VIEW, not a mutation of the page. It lets
 * a judge watch local detection become local masking in real time; the actual
 * artifact sent to a server is still the separately baked screenshot. Keeping
 * this isolated also means that hiding the lens restores the exact page the
 * user was looking at.
 */
let lensHost: HTMLDivElement | null = null;

function clearPrivacyLens(): void {
  lensHost?.remove();
  lensHost = null;
}

function lensLabel(kind: string): string {
  return kind
    .split('-')
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ');
}

function showPrivacyLens(regions: readonly PrivacyLensRegion[]): void {
  clearPrivacyLens();
  if (regions.length === 0) return;

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;';

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .mask {
      position: fixed;
      display: flex;
      align-items: flex-start;
      justify-content: flex-end;
      box-sizing: border-box;
      overflow: hidden;
      border: 2px solid #ffb020;
      border-radius: 5px;
      background: rgba(9, 19, 34, .91);
      box-shadow: 0 0 0 1px rgba(255,255,255,.25), 0 8px 20px rgba(0,0,0,.25);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      animation: privacy-lens-in 180ms ease-out both;
    }
    .mask > span {
      margin: 3px;
      padding: 2px 5px;
      border-radius: 999px;
      background: #ffb020;
      color: #152238;
      font: 700 10px/1.2 system-ui, sans-serif;
      letter-spacing: .03em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge {
      position: fixed;
      right: 16px;
      bottom: 16px;
      padding: 8px 11px;
      border: 1px solid rgba(255,255,255,.24);
      border-radius: 999px;
      background: #102a43;
      color: #fff;
      box-shadow: 0 8px 24px rgba(0,0,0,.28);
      font: 650 12px/1 system-ui, sans-serif;
    }
    @keyframes privacy-lens-in {
      from { opacity: 0; transform: scale(.96); }
      to { opacity: 1; transform: scale(1); }
    }
  `;
  shadow.append(style);

  for (const region of regions) {
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.style.left = `${String(Math.max(0, region.rect.x))}px`;
    mask.style.top = `${String(Math.max(0, region.rect.y))}px`;
    mask.style.width = `${String(Math.max(1, region.rect.width))}px`;
    mask.style.height = `${String(Math.max(1, region.rect.height))}px`;
    const label = document.createElement('span');
    // Category from our local detector, never page text.
    label.textContent = lensLabel(region.kind);
    mask.append(label);
    shadow.append(mask);
  }

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = `Privacy Lens · ${String(regions.length)} masked locally`;
  shadow.append(badge);

  document.documentElement.append(host);
  lensHost = host;
}

/* A viewport-relative mask must not survive a scroll or resize and drift. */
window.addEventListener('scroll', clearPrivacyLens, { capture: true, passive: true });
window.addEventListener('resize', clearPrivacyLens, { passive: true });

function copyLiveControlState(source: Document, clone: HTMLElement): void {
  const live = Array.from(source.querySelectorAll('input,textarea,select'));
  const copied = Array.from(clone.querySelectorAll('input,textarea,select'));
  for (let i = 0; i < live.length; i += 1) {
    const sourceControl = live[i];
    const cloneControl = copied[i];
    if (sourceControl === undefined || cloneControl === undefined) continue;
    if (sourceControl instanceof HTMLTextAreaElement && cloneControl instanceof HTMLTextAreaElement) {
      cloneControl.textContent = sourceControl.value;
    } else if (sourceControl instanceof HTMLSelectElement && cloneControl instanceof HTMLSelectElement) {
      cloneControl.setAttribute('value', sourceControl.value);
    } else if (sourceControl instanceof HTMLInputElement && cloneControl instanceof HTMLInputElement) {
      cloneControl.setAttribute('value', sourceControl.value);
      if (sourceControl.checked) cloneControl.setAttribute('checked', '');
      else cloneControl.removeAttribute('checked');
    }
  }
}

function snapshot(): {
  html: string;
  viewport: {
    cssWidth: number;
    cssHeight: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
} {
  // Never capture our own evidence overlay on a later agent step.
  clearPrivacyLens();
  /*
   * GEOMETRY IS STAMPED HERE, AND ONLY HERE.
   *
   * Redaction runs on HTML parsed from this string - in Chrome's offscreen
   * document, in Firefox's event page - and a parsed document has NO LAYOUT.
   * `getBoundingClientRect()` there returns zeros, so `attributeRectProvider`
   * falls back to `data-test-rect`, which only fixtures carry. On a real page
   * every DOM detection therefore had a null rect.
   *
   * That was invisible until a screenshot was sent, and then it was serious: a
   * detection with no rect produces no pixel op, so `bake` reported
   * `0 pixel op(s)` and the image went to the model with the email, card number
   * and password still legible - while the text beside it read
   * `[[PII:CREDIT_CARD:1:...]]`.
   *
   * The live document is the only place these numbers exist. A CLONE is stamped
   * rather than the page itself: writing attributes into someone's DOM to take a
   * measurement is a side effect the user did not ask for, and one that a
   * MutationObserver on the page would see.
   */
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  copyLiveControlState(document, clone);
  stampGeometry(document.documentElement, clone, liveRects);

  // markUntrusted is the boundary. From here on the type system will not let
  // this string be treated as anything but data.
  const html = markUntrusted(clone.outerHTML);
  return {
    // Runtime messaging is JSON-serialised, so the wrapper cannot survive the
    // hop. The background side re-marks it the moment it arrives; this is the
    // one place the boundary is held by convention rather than by the compiler.
    html: unsafeUnwrap(html, 'ipc-transfer'),
    viewport: {
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    },
  };
}

/**
 * Performs an already-validated action.
 *
 * `domPath` comes from the background, which derived it from the same walk that
 * assigned the ref - it is NOT a selector supplied by the model, and it never
 * travelled to the server. The model only ever names a ref like `e7`; turning
 * that into an element happens entirely on this side.
 *
 * The DOM work itself is `execution/actions.ts`, where jsdom can test it. This
 * function is only the environment: how to resolve, scroll and navigate here.
 */
/**
 * Does the live accessible name agree with the one that was sent?
 *
 * THIS COMPARISON WAS `liveName !== target.name`, AND IT REFUSED REAL WORK.
 *
 * The sent name is a `DataAtom`: `neutralize()` has collapsed its whitespace,
 * dropped invisible characters and defanged fence tokens; a redaction may have
 * put `[[PII:...]]` inside it; and the atom cap may have cut it and appended
 * `...`. The live name has been through none of that - `accessibleName` only
 * trims. So on a product link whose name comes from text content across several
 * child nodes, the two read:
 *
 *     sent:  "Laptop Pro Rs 49,999"
 *     live:  "Laptop Pro
        Rs 49,999"
 *
 * which is one element, spelled two ways, and the guard called it a stale
 * target and killed the action. Measured on the local test site; the same shape
 * covers essentially every anchor on a real shopping page, because
 * `accessibleName` only reaches the single-line `aria-label` path when the site
 * happens to author one.
 *
 * WHAT THE GUARD IS FOR, and what it therefore has to keep doing: catching the
 * case where the DOM path now resolves to a DIFFERENT element than the one the
 * model was shown. Whitespace is not that. A redacted or truncated name simply
 * cannot be compared at all, and refusing on a comparison that could not be made
 * is the failure mode being removed - so those fall back to the role check,
 * which is not text-derived and is exactly as strong as it ever was.
 */
function namesAgree(live: string | null, target: TargetHint): boolean {
  if (target.name === null) return true;
  const sent = target.name;
  const normalised = neutralize(live ?? '');

  if (target.nameRedacted) {
    /*
     * A placeholder stands where real text was, so only the literal part before
     * the first one can be checked. If a name is nothing BUT a placeholder there
     * is no evidence either way and the role check carries it.
     */
    const head = sent.split('[[PII:')[0]?.trim() ?? '';
    return head === '' ? true : normalised.startsWith(head);
  }

  if (target.nameTruncated) {
    // `toDataAtom` cuts at the cap and appends '...'; compare the kept prefix.
    const head = sent.endsWith('...') ? sent.slice(0, -3) : sent;
    return head === '' ? true : normalised.startsWith(head);
  }

  return normalised === sent;
}

interface TargetHint {
  readonly role: string;
  readonly name: string | null;
  readonly nameRedacted?: boolean;
  readonly nameTruncated?: boolean;
}

function execute(
  action: Action,
  domPath: string | null,
  target: TargetHint | null,
): { ok: boolean; note: string } {
  void liveRects;
  if (domPath !== null && target !== null) {
    const element = resolveDomPath(document, domPath as unknown as DomPath);
    if (element === null) return { ok: false, note: 'target disappeared before execution' };
    if (elementRole(element) !== target.role) {
      return {
        ok: false,
        note: `target changed before execution; refusing stale action (role is now ${elementRole(element)}, expected ${target.role})`,
      };
    }
    if (
      !namesAgree(accessibleName(element), {
        role: target.role,
        name: target.name,
        nameRedacted: target.nameRedacted === true,
        nameTruncated: target.nameTruncated === true,
      })
    ) {
      return { ok: false, note: 'target changed before execution; refusing stale action' };
    }
  }
  return executeAction(action, {
    resolve: () =>
      domPath === null ? null : resolveDomPath(document, domPath as unknown as DomPath),
    scrollBy: (x, y) => {
      window.scrollBy(x, y);
    },
    navigate: (url) => {
      // validateAction has already checked this origin against the allow-list.
      window.location.assign(url);
    },
  });
}

export default defineContentScript({
  /*
   * NOT registered in the manifest.
   *
   * `matches: ['<all_urls>']` used to be declared here, which WXT emitted into
   * both built manifests as a content_scripts entry. On Chrome those match
   * patterns are "scriptable hosts" GRANTED AT INSTALL, so the extension read
   * every page from the moment it was installed -- exactly the wildcard
   * wxt.config.ts says it refuses to ship. On Firefox MV3 the same key is
   * user-granted, so the two builds had different privacy postures from one
   * source. The test that was supposed to catch this asserted
   * `host_permissions === undefined`, a different key, and passed throughout.
   *
   * `registration: 'runtime'` keeps this file compiled and bundled but out of
   * the manifest, so neither browser grants page access at install. The script
   * is injected on demand under `activeTab` after a user gesture -- which is
   * what the already-declared `scripting` permission is for.
   *
   * `matches` is deliberately ABSENT, and that part is not optional. WXT hoists
   * the matches of a runtime-registered script straight into `host_permissions`
   * (core/utils/manifest.mjs:196-200), so keeping `<all_urls>` here just traded
   * a scriptable-host grant for an explicit install-time host permission --
   * strictly worse. The built-manifest test caught that on the first rebuild.
   * With no `matches`, nothing is hoisted: injection happens through
   * `scripting.executeScript({ target: { tabId } })` under `activeTab`, which
   * needs no declared host pattern because the gesture is the grant.
   *
   * Consequence, recorded in CLAUDE.md Known gaps: nothing injects it yet, so
   * this script does not currently run in a page. It costs nothing today (the
   * loop is unbuilt and `execute()` is a stub) and it removes a real capability
   * leak. See tests/built/manifest.test.ts, which now fails if the ambient
   * grant ever comes back under any key.
   */
  registration: 'runtime',
  runAt: 'document_idle',

  main() {
    browser.runtime.onMessage.addListener((message: unknown) => {
      const msg = message as { target?: string; cmd?: string; payload?: unknown } | null;
      if (msg === null || msg.target !== 'content') return undefined;

      if (msg.cmd === 'ping') {
        // Lets the background tell "already injected" from "not injected"
        // without injecting again. Re-running the script would register a
        // second listener and every message would be answered twice.
        return Promise.resolve({ ok: true, pong: true });
      }
      if (msg.cmd === 'fingerprint') {
        /*
         * A cheap "did anything change" signal for the loop's stall detector.
         *
         * Deliberately NOT the page text: this crosses to the background on
         * every step and page text is the thing the whole project exists to keep
         * out of places it does not belong. A URL, an element count and a text
         * LENGTH change when the page changes and carry nothing readable.
         */
        return Promise.resolve({
          ok: true,
          fingerprint: [
            location.href,
            String(document.querySelectorAll('*').length),
            String(document.body?.innerText.length ?? 0),
          ].join('|'),
        });
      }
      if (msg.cmd === 'snapshot') {
        return Promise.resolve({ ok: true, ...snapshot() });
      }
      if (msg.cmd === 'execute') {
        const payload = msg.payload as {
          action: Action;
          domPath?: string | null;
          target?: TargetHint | null;
        };
        return Promise.resolve({
          ok: true,
          result: execute(payload.action, payload.domPath ?? null, payload.target ?? null),
        });
      }
      if (msg.cmd === 'privacy/lens') {
        const payload = msg.payload as
          | { enabled?: unknown; regions?: readonly PrivacyLensRegion[] }
          | undefined;
        if (payload?.enabled !== true) {
          clearPrivacyLens();
          return Promise.resolve({ ok: true });
        }
        const regions = Array.isArray(payload.regions)
          ? payload.regions.filter(
              (region): region is PrivacyLensRegion =>
                region !== null &&
                typeof region === 'object' &&
                typeof region.kind === 'string' &&
                Number.isFinite(region.rect?.x) &&
                Number.isFinite(region.rect?.y) &&
                Number.isFinite(region.rect?.width) &&
                Number.isFinite(region.rect?.height),
            )
          : [];
        showPrivacyLens(regions);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, error: `unknown cmd ${String(msg.cmd)}` });
    });
  },
});
