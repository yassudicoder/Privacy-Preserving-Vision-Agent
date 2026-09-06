import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

/*
 * ONE source of truth for the version.
 *
 * This was hardcoded here as '0.1.0' while package.json moved on, so the
 * installed extension reported a version that no longer matched the repo - and
 * the manifest is what the browser and the store both read. Two places holding
 * the same fact is how they disagree; `tests/built/manifest.test.ts` now asserts
 * they cannot.
 */
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * One source, two browsers.
 *
 * WXT defaults Firefox to MV2. The brief requires MV3 everywhere, so every
 * Firefox script in package.json passes --mv3 explicitly. Do not drop that flag.
 *
 * The two platforms differ in exactly one structural way that matters here:
 *
 *   Chrome  - background is a service worker. No DOM, no canvas, no WebGPU.
 *             The model therefore lives in an offscreen document.
 *   Firefox - background.service_worker is not supported (bugzil.la/1573659).
 *             MV3 Firefox uses background.scripts, an event page that DOES have
 *             a DOM. chrome.offscreen does not exist there at all.
 *
 * WXT emits the right background key from one defineBackground() call. The
 * split in where the model runs is handled by perception/host/, selected at
 * build time via import.meta.env.FIREFOX so the unused backend is tree-shaken.
 */
/**
 * The agent server this build ships pointing at, or '' for none.
 *
 * A BUILD INPUT, never a committed constant. `AGENT_ORIGIN=https://... npm run
 * build` bakes it in; an unset build behaves exactly as before, with nothing
 * configured and the user supplying an origin at runtime. That keeps one repo
 * able to produce both a zero-config distribution build and the
 * bring-your-own-server build the project's constraints describe.
 *
 * IT IS AN ORIGIN, NOT A KEY. The model provider's credential lives in the
 * SERVER's environment (`VLM_API_KEY`); a key here would ship to every user and
 * be extractable from the bundle in seconds. `boundaries.test.ts` greps for
 * `sk-` shapes, and `manifest.test.ts` asserts the emitted manifest carries no
 * key-shaped field.
 */
const AGENT_ORIGIN = (process.env['AGENT_ORIGIN'] ?? '').trim();

/**
 * The match pattern for the baked origin, or null.
 *
 * Deliberately strict and deliberately DUPLICATED from `deriveOriginPattern`
 * rather than imported: this file is Node config evaluated before the bundle
 * exists, and importing extension source into it would drag the whole module
 * graph in. The rules are the ones that matter here - https only, no wildcard,
 * a real hostname - and `tests/architecture/manifest.test.ts` asserts the
 * emitted key against them independently.
 *
 * The port is dropped because a match pattern's host may not carry one; that is
 * the platform's rule, and emitting `https://host:8443/*` produces a pattern
 * Firefox refuses.
 */
function agentHostPattern(raw: string): string | null {
  if (raw === '' || raw.includes('*')) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

const AGENT_PATTERN = agentHostPattern(AGENT_ORIGIN);

export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  manifestVersion: 3,

  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';

    return {
      name: 'SIH26171 Privacy-Preserving Vision Agent',
      description:
        'Local vision model reads the screen, PII is redacted on-device, only sanitized context reaches the server.',
      version: pkg.version,

      /*
       * The toolbar button. It is the ONLY way in: this extension ships no
       * popup, and the panel (side_panel on Chrome, sidebar_action on Firefox)
       * is the only UI surface. Without this key there is no button at all,
       * which is exactly the reported symptom -- clicking the extension in
       * Firefox fell through to the generic permission menu.
       *
       * Three separate facts, deliberately not conflated:
       *
       *  1. The key EXISTING is the prerequisite for the API. Chrome: "To use
       *     the chrome.action API, specify a "manifest_version" of 3 and
       *     include the "action" key in your manifest file."
       *     Firefox supports `action` under MV3 from 109 (BCD); we pin 128.0.
       *     src/entrypoints/background.ts listens on browser.action.onClicked;
       *     without this key that object is undefined.
       *
       *  2. default_popup is ABSENT on purpose, and must stay absent. It is
       *     what preserves the click as a dispatched event AND as a user
       *     gesture. Chrome: "The action.onClicked event won't be sent if the
       *     extension action has specified a popup". MDN: "This event will not
       *     fire if the browser action has a popup." A popup would also be the
       *     second UI surface this project explicitly does not want.
       *
       *  3. default_icon is artwork only. It has no effect on the event.
       *
       * WXT only synthesises an `action` key from a POPUP entrypoint
       * (wxt/dist/core/utils/manifest.mjs). There is no popup here, so WXT
       * never touches this key and the value below survives the defu merge
       * unchanged. Verified against both built manifests.
       *
       * `icons` is deliberately NOT declared: WXT discovers it from public/
       * and the merge is a deep merge, so a hand-written copy could only add
       * or shadow a size, never replace the discovered set. Two sources would
       * silently drift.
       */
      action: {
        default_icon: {
          '16': 'icon-16.png',
          '32': 'icon-32.png',
          '48': 'icon-48.png',
          '128': 'icon-128.png',
        },
        default_title: isFirefox
          ? 'Open the Vision Agent sidebar'
          : 'Open the Vision Agent side panel',
        // Firefox-only, and unsupported on Chrome (BCD: chrome false). Puts the
        // button on the toolbar instead of burying it in the puzzle-piece
        // overflow panel, where a first-run user will not find it.
        ...(isFirefox ? { default_area: 'navbar' } : {}),
      },

      permissions: [
        'activeTab',
        'storage',
        'scripting',
        // Chrome-only. Firefox has no offscreen API and does not need one.
        ...(isFirefox ? [] : ['offscreen']),
        ...(isFirefox ? [] : ['sidePanel']),
      ],

      /*
       * The ONE origin this build ships able to reach, when it ships with one.
       *
       * Absent unless `AGENT_ORIGIN` was set at build time, so the default build
       * still declares no host permissions at all.
       *
       * WHAT THIS DOES AND DOES NOT GRANT, because the distinction is the whole
       * justification: a host permission for `https://agent.example/*` lets the
       * extension FETCH that one host. It grants no access to any page the user
       * visits - page access is still `activeTab` plus a per-site grant the user
       * makes deliberately. So this widens the network reach by exactly one
       * named server and widens page reading by nothing.
       *
       * It is declared rather than requested so the extension can plan on first
       * open with no configuration step, which is the point of a distribution
       * build. `tests/architecture/manifest.test.ts` asserts it is at most one
       * entry and never a wildcard.
       */
      ...(AGENT_PATTERN === null ? {} : { host_permissions: [AGENT_PATTERN] }),

      // Nothing else by default. The agent server origin is otherwise added by
      // the user at runtime via optional_host_permissions - shipping a wildcard
      // would let this extension read every page it is installed alongside.
      /*
       * `127.0.0.1` alongside `localhost`, because `deriveOriginPattern` accepts
       * BOTH as loopback and a pattern that is never declared can never be
       * granted. Found by the source-to-manifest test rather than by a user:
       * typing http://127.0.0.1:8787 would have produced the same
       * "not declared in the manifest" failure that localhost just did.
       *
       * Both are http-only and loopback-only. Nothing here widens what a remote
       * host may be reached over plaintext.
       */
      optional_host_permissions: [
        'http://localhost/*',
        'http://127.0.0.1/*',
        'https://*/*',
      ],

      // wasm-unsafe-eval is required by ONNX Runtime Web. Without it the wasm
      // backend fails to instantiate and there is no fallback from WebGPU.
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      },

      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'sih26171@example.invalid',
                // MV3 + background.scripts event pages are only sane from 128.
                strict_min_version: '128.0',
                /*
                 * Required for new Firefox extensions since November 2025.
                 *
                 * We declare `websiteContent` even though the whole point of
                 * this extension is to redact before transmitting. Redacted
                 * page structure IS still website content leaving the machine,
                 * and under-declaring here to look better would be exactly the
                 * dishonesty the project exists to avoid. `none` would be a lie.
                 */
                data_collection_permissions: {
                  required: ['websiteContent'],
                },
              },
            },
          }
        : {
            minimum_chrome_version: '116',
          }),
    };
  },

  vite: () => ({
    build: {
      // Model inference is the latency budget; do not also ship unminified code.
      target: 'es2022',
    },
    define: {
      /*
       * Stamped at build time so the panel can say which build is running.
       *
       * A browser keeps serving the previously loaded bundle until the extension
       * is reloaded, and every symptom of that looks like a bug in the code
       * rather than in the loading - which cost real debugging time on this
       * project already. The footer makes "is this the build I just made" a
       * question you can answer by looking.
       */
      __BUILD_STAMP__: JSON.stringify(
        new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      ),
      /*
       * Empty unless this build was given one. The background seeds the cloud
       * backend from it on FIRST run only, so a user who later configures
       * something else is not overwritten on every service-worker restart.
       */
      __AGENT_ORIGIN__: JSON.stringify(AGENT_PATTERN === null ? '' : AGENT_ORIGIN),
    },
  }),
});
