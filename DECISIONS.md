# Decisions

One line per fork, what was picked and why. Append; do not rewrite history.

## Build and tooling

- **WXT over Plasmo / raw Vite / webpack.** Emits Chrome MV3 and Firefox MV3 from
  one source (`-b firefox --mv3`), handles the `service_worker` vs
  `background.scripts` split from one `defineBackground()`, maps one sidepanel
  entrypoint to Chrome `side_panel` and Firefox `sidebar_action`, and gives
  offscreen documents a natural home as an unlisted page. Plasmo is React-first
  and awkward for offscreen/worker entrypoints; raw Vite means hand-rolling the
  manifest branching WXT exists to remove.
- **`--mv3` pinned in every Firefox script.** WXT defaults Firefox to MV2. Left
  implicit, we would have shipped MV2 without noticing.
- **`.wxt/wxt.d.ts` added to tsconfig `include`, not `extends`.** Extending WXT's
  generated tsconfig would silently override our stricter compiler options; we
  only want its ambient types (`import.meta.env`, `PublicPath`).
- **No WXT auto-imports.** Explicit imports only. Auto-imports make the
  dependency graph invisible, and the architecture test reads imports.
- **Preact over React.** ~4 kB vs ~40 kB for no gain here; client resource use is
  20% of the score.
- **Path alias `@/*` only, no per-module aliases.** One alias keeps the
  boundary scanner simple and matches WXT's own default.
- **`spike/` has its own package.json.** Keeps a 26 MB vendored ONNX runtime out
  of the main dependency tree.

## Types and enforcement

- **`Untrusted<T>` is a real wrapper, not an intersection brand.** Discovered
  when the negative type test failed as "unused @ts-expect-error":
  `T & { brand }` is still assignable to `T`, so `wantsString(pageText)`
  compiled. The intersection version was decorative. The wrapper holds the
  payload behind a module-private symbol, which also means `JSON.stringify()`
  yields `{}` — page text cannot leak by accidental serialisation.
- **`unsafeUnwrap` requires a reason from a closed union, and the architecture
  test pins the exact file list allowed to call it.** Adding a call site fails
  the build until the list is updated deliberately. Cost: one more place to edit.
  Worth it — this is the whole security boundary.
- **`ipc-transfer` added as an unwrap reason.** `chrome.runtime` messaging is
  JSON-serialised, so the wrapper cannot survive the hop from content script to
  background. This is the one place the boundary is held by convention; naming
  it makes that visible instead of hiding it in a cast.
- **`SanitizedContext` and `BakedScreenshot` are nominal, minted by exactly one
  file each, asserted by a test that counts casts.** A second cast would remove
  the guarantee silently.
- **Coordinate space is in the type; `iou`/`union`/`containment` use `NoInfer` on
  the second argument.** Without `NoInfer`, TS widens `S` to the union and
  `iou(deviceRect, cssRect)` compiles. A device-px/CSS-px mixup shifts every
  redaction box by the DPR and fails nothing loudly.
- **`parseAction` returns `ParseResult<Action>`, not `Action`.** Approved
  deviation from the brief. It parses hostile input at a security boundary,
  where a thrown exception gets caught somewhere generic and turned into a shrug.

## Detection and redaction

- **Checksums are validated, not just matched.** Luhn for cards, Verhoeff for
  Aadhaar, holder-type character for PAN, never-issued prefixes for SSN. A
  checksum-failing candidate is dropped entirely rather than emitted with low
  confidence — a 16-digit number that fails Luhn is simply not a card number.
  This is the single biggest lever on metric 2's precision.
- **Aadhaar uses Verhoeff, not Luhn.** They are different schemes. Using the
  wrong one produces a detector that is confidently wrong about a billion
  identifiers. A test asserts a valid Aadhaar is *not* Luhn-valid.
- **Credentials use `drop-attribute`, not `remove-node`.** Deleting the password
  field would destroy the structural fact the server needs ("there is a required
  password field here"). Visual context is 25% against redaction's 20%.
  Stripping the value keeps the structure and leaks nothing.
- **`readControlValue`/`writeControlValue` wrap every control value access.**
  Found while writing the scorer: a `<textarea>` holds its value in a text node,
  so `setAttribute('value','')` does nothing and the whole delivery address in
  `checkout.html` was leaking. Now every read and write goes through one pair.
- **Merge grants a confidence boost when DOM and vision agree.** Corroboration
  from a genuinely different channel is evidence, not a duplicate. Capped at
  0.99. Same-channel duplicates get no boost.
- **Vision boxes attach to the *smallest* element containing them.** So a face
  box lands on the `<img>`, not on `<body>`.
- **Blur has a minimum radius of one eighth of the shorter side.** A light blur
  over a small region is recoverable by anyone who cares, which would make the
  redaction theatre.
- **Out-of-frame pixel ops are reported as `skipped`, never silently dropped.** A
  redaction that did not happen must not look like one that did.
- **Placeholders carry a per-session nonce, and page text is stripped of all
  placeholder shapes at ingest.** Otherwise a page forges redactions the log has
  no record of. Both client and server check.

## Scoring

- **`scoreDetections` is one-to-one and greedy by confidence.** Without it,
  firing five overlapping rules at one email reads as excellent recall instead of
  as noise. Extra detections on an already-matched item count as `duplicates` and
  are charged against precision.
- **`mustRedact: false` excludes an item from recall AND from false positives,
  and requires a written note.** A test enforces the note. Without that rule this
  field is just a way to make numbers look better.
- **`scoreScreenContext` pairs elements even when the role is wrong, then
  penalises the role.** Reporting it as both a miss and a spurious element would
  double-count one mistake and make role errors look worse than dropped elements.
- **Metric 1 composite weights: F1 0.4, role 0.2, name 0.2, geometry 0.1,
  sensitivity 0.1.** Identity of an element matters more to a planner than its
  exact pixels.
- **Failed benchmark runs average in as zeros rather than being dropped.** A
  model that works on three of five fixtures is worse than one that works on all
  five, and excluding its failures would hide exactly that.
- **Precision/recall are measured at the operating threshold, and the excluded
  count is always printed.** Found when the first scorecard run showed checkout
  at 85.7% precision because of a 0.3-confidence `account-long-digits` hit on a
  Luhn-invalid order reference — a detection that is *never redacted*. Grading
  detections the system does not act on misrepresents the pipeline; hiding them
  would be worse. So `scoreDetections` defaults to `minConfidence: 0` (grade
  everything), callers opt into the operating point, and `belowThreshold` plus
  `atConfidence` are reported either way. A test pins the weak rule below the
  threshold so nobody promotes it and starts redacting every order number.

## Manifest

- **Firefox `data_collection_permissions.required: ['websiteContent']`.**
  Required for new extensions since November 2025. Declared honestly rather than
  as `none`: redacted page structure is still website content leaving the
  machine, and under-declaring to look better is exactly the dishonesty this
  project exists to avoid.
- **`tests/architecture/manifest.test.ts` asserts the Chrome/Firefox split
  without running a build.** This is the constraint most likely to break
  silently — everything compiles, both bundles emit, and Firefox quietly ships
  MV2, or requests an `offscreen` permission that does not exist there, or loses
  the `wasm-unsafe-eval` that ONNX Runtime Web needs to instantiate at all.
- **No `host_permissions`, only `optional_host_permissions`.** A wildcard host
  permission would let this extension read every page it is installed alongside,
  which is an odd look for a privacy extension.

## Resource measurement

- **`MemoryReading` carries a `source` and a `jsHeapOnly` flag; nothing is
  nullable.** The original design had `peakHeapMb: number | null`, which is the
  same as not measuring — a null scores as zero and nobody notices. Where a
  platform cannot report a figure (Firefox has no `performance.memory`), the
  reading says which method produced it instead of going quiet.
- **Peak heap is a sampled maximum, documented as a lower bound.** A spike
  between two samples is invisible. Better to say so than to imply precision.
- **Budgets carry a `tolerance` multiplier (currently 4).** A resource test that
  fails on a busy laptop gets deleted rather than fixed, which loses the
  regression signal entirely. Ceilings are set for regression detection, not as
  performance targets.
- **`writeBudgets` exists but is NOT wired into the test run.** Auto-updating a
  budget on failure turns a regression detector into a rubber stamp. If a number
  moves, that is a decision with a line in this file.
- **CPU-time test uses a 60M-iteration workload.** `process.cpuUsage()` has ~15 ms
  granularity on Windows; a smaller loop made the assertion a coin flip.

## Model benchmark

- **The screenshot-on-vs-off choice is an OUTPUT of the benchmark, not a
  default.** `decideScreenshotPolicy` compares runs differing *only* in that
  flag, on the same candidate/backend/fixture. Unpaired runs are ignored —
  comparing screenshot-on for one model against screenshot-off for another
  measures the models, not the policy.
- **Ties go to OFF, with a 0.02 required margin.** Sending pixels has to justify
  itself: it costs latency and bandwidth, and it is the one path where a
  redaction bug leaks something a human can read directly.
- **`resolveSessionPolicy(null)` returns `sendScreenshot: false` labelled
  `source: 'fallback'`.** A fallback that announces itself beats a default that
  looks like a decision.
- **Candidate registry ships `declaredWeightsBytes: null` and
  `status: 'expected'`, never `'verified'`.** Nothing is verified until the
  benchmark has actually run it on that backend. A registry that ships claims as
  facts is worse than no registry. A test asserts nothing starts verified.
- **Unmapped detector labels are dropped, not mapped to `unknown-sensitive`.**
  Blacking out every detected chair would wreck redaction precision.

## Spike

- **`Xenova/yolos-tiny`.** A ViT backbone with a detection head — matches the
  problem statement's "ViT or equivalent", small enough to load fast, and a
  canonical transformers.js model. It detects COCO classes, so it is a proxy for
  *cost*, not for accuracy.
- **The spike is not automated with headless Chrome.** Headless would report a
  WebGPU-less, single-threaded wasm path — a misleading number, worse than none.
  Built and verified up to the browser boundary; the measurement is manual.
- **wasm threads forced to 1 unless cross-origin isolated.** An offscreen
  document is not COI, so the wasm figure is a floor rather than the achievable
  best. Documented in `spike/README.md` rather than quietly reported as "the"
  number.

## Measured - spike results, 2026-08-25

Chrome 151, Windows, RTX 40-series (nvidia/lovelace), 16 cores, 16 GB.
`Xenova/yolos-tiny`, WebGPU, fp32, 10 timed frames after 2 warmup. Two runs.

| What | Run 1 | Run 2 | Read |
|---|---|---|---|
| Model size | "125 MB" | **25.01 MB** | Run 1 was a measurement bug. See below. |
| Cold load | 205.5 s | **116.3 s** | Network-bound, not compute-bound |
| Forward pass p50 | 174.2 ms | **167.6 ms** | Stable and reproducible |
| Decode p50 | 12.7 ms | **12.0 ms** | Stable |
| Per-frame total p50 | 188.7 ms | **180.0 ms** | Well inside the 1500 ms limit |
| Peak JS heap | 76.2 MB | **100.3 MB** | Excludes WebGPU buffers |
| `captureVisibleTab` | 721.7 ms | **22.6 ms** | **Cold-start cost, not per-step** |
| Boxes found | 6 | 6 | Consistent |

### The 125 MB was mine, not the model's

`131,139,965 / 26,227,993 = exactly 5.0`. The fetch tally summed `content-length`
across every response, and a slow link retried the same 25 MB file five times. So
the figure recorded as MEASURED was a measurement bug, and the "wrong by 5x"
conclusion drawn from it was itself wrong - the original ~26 MB estimate from
parameter count had been right all along.

What caught it: the per-file breakdown added *after* run 1, which attributed the
whole total to a single `onnx/model.onnx`. The instrumentation added to explain a
surprising number is what disproved it.

The fix separates two quantities that were being conflated:

- **transferred** - every byte over the wire, retries included. What the user's
  connection actually pays, and a real cost on a bad link.
- **unique** - largest response per URL. The model's actual size.

Both are now reported. `candidates.ts` carries 26,227,993.

### captureVisibleTab is NOT the bottleneck

721.7 ms was first-call setup. Warm is **22.6 ms**, cheaper than JPEG decode. The
earlier conclusion that "capture dominates the loop" was wrong, and is retracted
here rather than quietly edited away.

The quota still stands as a structural limit -
`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` = 2, so 500 ms per step is a floor if
every step captures - but at ~180 ms inference plus a server round trip the loop
will not approach 2 steps/second anyway. A ceiling we are unlikely to hit, not a
wall to design around.

NOTE: run 2 still reported one capture timing because the spike's `bench()`
hand-picked three fields out of the capture block and dropped the repeated
samples `background.js` had collected. Fixed; the next run reports cold, warm
p50 and every sample.

### What this leaves

- **fp32 at 25 MB is viable to ship**, and the cold load is network-bound rather
  than a model problem. Bundling the weights into the extension package removes
  the multi-minute first-run wait entirely and is now the obvious move. q8 is
  still worth measuring for the memory win, but it is no longer urgent.
- **Peak JS heap of 100 MB excludes the WebGPU buffers** holding the weights, so
  true footprint is higher. `measureUserAgentSpecificMemory()` would settle it
  but needs `crossOriginIsolated`, which an offscreen document is not. Metric 4
  has a blind spot the `MemorySource` union at least makes visible.
- **Budgets stay where they are.** 25 MB scores ~1.0 on the weights axis and
  180 ms scores ~0.98 on latency. They were roughly right; nothing needs moving,
  which is the outcome that requires no argument.


### Content-Length is not a measurement

`transformers.js` logged, mid-load:

```
Unable to determine content-length from response headers. Will expand buffer when needed.
```

That warning is about its own buffer sizing, and it is harmless to the load. It
is not harmless to me: the spike's byte tally read that same header.

```js
const len = Number(res.headers.get('content-length') || 0);
if (Number.isFinite(len) && len > 0) { networkBytes += len; /* ... */ }
```

A chunked or streamed response carries no `Content-Length`. Such a file counted
as **zero bytes** and dropped out of the total silently, leaving a smaller
number that still looked entirely reasonable. The warning fires from
`readResponse()`, which is the path taken for the model file itself -- so the
file most likely to be missing from the total was the only one the total was
about.

**Fixed by not trusting the header.** The response is rewrapped around a
pull-based counting stream and the bytes are counted as they pass. Rejected
`res.clone()`: it makes the browser hold a second full copy of a 25 MB file,
and this number is reported next to a peak-memory measurement it would have
inflated. `spike/verify-tally.mjs` confirms heap growth stays around 0.3 MB
against a 25 MB payload, that the payload survives byte-for-byte, and that a
cancelled download still reports how far it got.

What is counted is now *decoded* bytes, because `fetch` un-gzips before the body
is readable. That is the file's real size and may legitimately exceed
`Content-Length`. The result adds a `byteAccounting` block giving per-file
provenance and a `complete` flag; when anything is unaccounted for, the totals
are labelled a floor rather than reported as a figure. Resource Timing is
included as a cross-check where `Timing-Allow-Origin` permits it.

**The 25 MB figure stands.** yolos-tiny is ~6.5M parameters, so fp32 is ~26.0 MB;
the measurement is 0.9% from that. It survives because two independent routes
agree, not because the tally said so -- which is the only reason to still trust
a number produced by code that has now been wrong twice.

Standing lesson, third time it has come up in this spike: **an instrument that
fails silently is worse than one that fails loudly.** Each of these bugs printed
a plausible number. That is why the tally now reports how it knows, and not just
what it thinks.

## The manifest test could not see the manifest

Loading the Firefox build via `about:debugging` showed "Can't read and change
data on this site". Both observations that prompted this - that, and "Background
script: Stopped" - turned out to be correct MV3 behaviour. Chasing them found a
real defect underneath.

**`content_scripts: [{ matches: ['<all_urls>'] }]` shipped in both builds.** On
Chrome those patterns are *scriptable hosts*, granted at install, so the Chrome
build injected into every page from installation onward - the exact wildcard
`wxt.config.ts` argues against three lines above the key that produced it. On
Firefox MV3 the same key is user-granted, so one source produced two different
privacy postures, and the Firefox dev-install path is the only reason it looked
contained.

The guard that should have caught it:

```js
expect(m['host_permissions'], name).toBeUndefined();   // passed, always
```

`manifest.test.ts` imports `wxt.config.ts` and asserts the object its `manifest()`
function returns. **That object is not the manifest.** WXT merges `content_scripts`,
`background`, `side_panel`, `sidebar_action`, `manifest_version` and
`web_accessible_resources` in at build time, so every one of those keys is
structurally invisible to that file. The assertion checked the key that was empty
and could not see the key that was not.

**Decision: assert the artifact, not the config.** `tests/built/manifest.test.ts`
reads `.output/*/manifest.json` and checks every key that can confer page access
without a gesture - `host_permissions`, host patterns in `permissions`,
`content_scripts[].matches`, `web_accessible_resources[].matches`. It also pins
the permission sets exactly (the old test only ever asked `toContain`, so adding
`tabs` would have passed), parses `script-src` into tokens against an allowlist
(the old check was a substring match that `'unsafe-eval'` passes), and greps the
shipped bytes rather than `src/`. It fails loudly when `.output/` is missing
rather than skipping. It runs from `npm run test:built`, which builds first;
`npm test` stays build-free.

**Decision: `registration: 'runtime'` with no `matches`.** The first attempt kept
`matches: ['<all_urls>']` and only moved it off the manifest - WXT hoists a
runtime-registered script's matches straight into `host_permissions`
(`core/utils/manifest.mjs:196-200`), which is strictly worse. The new test caught
that on the rebuild and named the new key. With `matches` omitted, nothing is
hoisted; injection goes through `scripting.executeScript` under `activeTab`,
where the gesture is the grant. Both builds now ship no `host_permissions` and
an empty `content_scripts`.

Cost, recorded in Known gaps: nothing injects the content script yet, so it does
not run in any page. That costs nothing today - the loop is unbuilt and
`execute()` is a stub - and it removes a real capability leak.

**Kept deliberately:** `optional_host_permissions: ['https://*/*']`. Chrome
requires that any origin passed to `permissions.request()` already appear there,
so "the user supplies any server origin at runtime" forces a broad *optional*
pattern. Narrowing has to be structural in code - one `requestServerOrigin()`
call site, pinned the way `unsafeUnwrap` sites are - not cosmetic in the
manifest. The test permits `https://*/*` and rejects `<all_urls>`.

This is the fourth instrument in this project found reporting success without
measuring the thing it was named after, after the byte tally's three. The
pattern is consistent enough to be worth stating as a rule: **a guard that
cannot see the artifact it guards is not a guard.** Prefer asserting emitted
output over the configuration that generates it.

## The extension had no way in

Clicking the extension did nothing because neither built manifest declared an
`action` key. The only UI was a sidebar reachable through Firefox's View menu,
which nobody would find.

**Decision: a toolbar button whose click opens the panel. No popup.** One UI
surface rather than two, and the click doubles as the user gesture that later
carries `permissions.request()` and wakes the Firefox event page.

Four things here fail only at runtime, so they are written down:

- **`default_popup` must stay absent.** Chrome: *"The action.onClicked event
  won't be sent if the extension action has specified a popup"*; MDN says the
  same. Adding one makes the panel unreachable with no error and no failing
  test. `tests/built/manifest.test.ts` now asserts `action` exists and carries
  no `default_popup`.
- **The gesture is scoped to the synchronous run of the listener.** Both
  `sidePanel.open()` and `sidebarAction.toggle()` are gesture-gated (Gecko marks
  all three of `open`/`close`/`toggle` `requireUserInput: true`;
  `sidebar_action.json:219-241`). The first `await` forfeits it. So `openPanel()`
  is not `async` and awaits nothing before the call, and a hand-rolled
  `await isOpen() ? close() : open()` is specifically wrong
  ([bugzil.la/1800401](https://bugzilla.mozilla.org/show_bug.cgi?id=1800401)).
  Neither call throws without a gesture -- they *reject* -- so both carry a
  `.catch`, attached after the call because the gesture is read at call time.
- **Rejected `setPanelBehavior({ openPanelOnActionClick: true })` on Chrome.** It
  opens the panel with no code, but Chromium's `RunAction` returns
  `kToggleSidePanel` *before* both `GrantTabPermissions()` and
  `DispatchExtensionActionClicked()`. The click would neither grant `activeTab`
  -- this extension's only page access, since it ships no `host_permissions` --
  nor fire `onClicked`. It also persists in on-disk prefs, so setting it true
  once while experimenting keeps `onClicked` dead on that profile.
- **`sidebar_action.default_icon` cannot be set from `wxt.config.ts`.** WXT
  assigns `manifest.sidebar_action` wholesale inside its Firefox branch, so a
  config value is discarded on Firefox and ships as a dead key on Chrome --
  neither is a type error. It is set from a `<meta name="manifest.default_icon">`
  tag in the panel's HTML instead. Firefox does not fall back to the top-level
  `icons` key for the sidebar switcher: omit it and the sidebar has no icon.

**Permissions did not change.** Neither `action` nor `sidebar_action` is a
permission, and the built arrays stayed byte-identical to the pin in
`tests/built/manifest.test.ts`. The pin was deliberately *not* widened
pre-emptively -- doing so would disarm the assertion that catches an accidental
`tabs` or `cookies` grant.

**Icons: four generated PNGs in `public/` at the repo root.** Not `src/public/`,
which WXT ignores silently despite `srcDir: 'src'` -- `publicDir` resolves from
root. PNG only; Chrome rejects SVG and WebP. They are placeholder art from
`scripts/make-icons.mjs` (zero-dependency PNG encoder over `node:zlib`), kept
regenerable rather than checked in as opaque blobs.

### Run 3: the byte tally earns its keep, and the loop turns out to be quota-bound

A third spike run, same machine, webgpu/fp32.

| | Run 2 | Run 3 |
|---|---|---|
| model.onnx | 26,227,993 B | 26,227,993 B |
| cold load | 116 s | 202 s |
| forward pass p50 | 168 ms | 226.7 ms |
| per-frame total p50 | 180 ms | 242.2 ms |
| capture warm p50 | 22.6 ms | 25.8 ms |
| peak JS heap | 100 MB | 74.5 MB |
| boxes | 6 | 5 |

**The byte accounting is now confirmed by two independent methods.** The
stream counter and the Resource Timing API's `decodedBytes` both report
26,227,993 bytes for `onnx/model.onnx` - exactly, not approximately. Together
with the parameter-count estimate (6.5M x 4 B = 26.0 MB) that is three routes
agreeing, which is the standard this number should have been held to from the
start.

**And the fix was not hypothetical.** `config.json` came back with
`contentLengthPresent: false`. Under the original header-based tally that file
counted as **zero bytes** and vanished from the total silently. It is only
4,145 bytes so the totals barely move - but the failure mode was real, it fired
on this run, and `byteAccounting.missingContentLength` named it instead of
hiding it. That is what the instrument was rebuilt for.

**Inference variance is larger than expected.** 168 ms then 226.7 ms p50 on the
same GPU with the same dtype, ~35% apart, with run 3's min (173.7 ms) landing on
run 2's p50. Neither number is THE figure. `candidates.ts` now records the range
170-230 ms rather than picking a favourite. Anything that depends on the
difference between those two needs its own measurement.

**The loop is quota-bound, not inference-bound.** Per-frame work is ~242 ms
(226.7 infer + 15.1 decode), warm capture is ~26 ms - but
`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2` imposes a **500 ms floor per
step**. So roughly half of every step is spent waiting for the quota, and
shaving 50 ms off inference buys nothing at all until the step rate changes.

This inverts the obvious optimisation order. Quantising to q8, trimming the
model, tuning the backend - none of it moves end-to-end latency (metric 5, 15%)
while the quota dominates. What would: capturing less often than once per step,
reusing a frame across steps where the page has not changed, or driving the loop
from DOM mutation rather than a fixed cadence. `BrowserCaptureAdapter` already
paces and reports its own waits, so the cost is visible rather than inferred.

### The model backend: injected library, vendored weights

`InferenceBackend` is implemented. transformers.js arrives as a PARAMETER
(`TransformersApi`), not an import, which is what makes the interesting parts
testable at all: device fallback, reporting the backend that actually loaded
rather than the one requested, coordinate space, and refusing boxes the caller
cannot trust. 32 tests cover it with no model, no WebGPU and no canvas.

**`maxEdgePx` now does something.** `EngineConfig` called it "the main latency
dial" and nothing read it. It is now the letterbox square - the resolution the
model actually sees - so it trades metric 1 against metric 5 exactly as
described instead of sitting inert in the config.

**Weights are vendored, not committed.** `npm run vendor:model` fetches 25 MB of
weights and copies ~32 MB of ORT wasm into `public/`, both gitignored.
Committing 56 MB of binaries that npm can reproduce exactly would put them in
every clone and every diff forever. The script counts downloaded bytes off the
stream and cross-checks against the file on disk, because the header-based tally
has been wrong twice now.

`model.onnx` came to **26,227,993 bytes** - matching the spike's stream count
and its Resource Timing figure exactly. Three independent methods, which is the
standard this number should have been held to from the beginning.

**`allowRemoteModels = false`.** The extension will not fetch its own weights
over the network. A missing file fails loudly instead of a privacy extension
quietly reaching out to a third party, and the spike's 116-202 s cold load says
the network path was never worth having.

### The bundle guard, and what it caught immediately

`tests/built/bundle.test.ts` reads the emitted JavaScript rather than the source.
It was written before the fix it needed, and it failed on the first run:

```
firefox has no offscreen document > loads the model in the background page
AssertionError: expected [ 'background.js', ...(1) ] to have a length of 1 but got 2
```

Firefox was shipping ONNX Runtime Web **twice**: once in `background.js`, where
its event page legitimately runs the model, and once in an offscreen chunk that
`chrome.offscreen` does not exist to create. WXT builds every entrypoint for
every browser unless told otherwise, and nothing in any source file showed it.
One `<meta name="wxt.include" content="['chrome']" />` took the Firefox package
from **1.81 MB to 923 kB**.

The Chrome half is the load-bearing one. `background.ts` is the MV3 service
worker, so a static `import * as transformers` there would break the project's
first hard constraint - and tree-shaking would NOT save it, because
transformers.js has module-level side effects and a bundler must keep a
statically imported namespace even when every function using it is gone. It is a
dynamic import inside the Firefox-only path, and the emitted service worker is
**3.3 kB with zero ORT references**. That is asserted against the built file,
not the comment.

This is the fifth instrument in this project to be corrected the same way, and
the rule has not changed: a guard that cannot see the artifact it guards is not
a guard.

### Run 4, and a capture measurement that must be thrown away

Chrome, same machine, webgpu/fp32, n=10.

| | Run 2 | Run 3 | Run 4 |
|---|---|---|---|
| cold load | 116 s | 202 s | **60.3 s** |
| forward pass p50 | 168 ms | 226.7 ms | **188 ms** |
| per-frame total p50 | 180 ms | 242.2 ms | **202.7 ms** |
| decode p50 | - | 15.1 ms | 13.2 ms |
| peak JS heap | 100 MB | 74.5 MB | 73.1 MB |
| boxes | 6 | 5 | **22** |

**The capture numbers in this run are void.** The spike reported

```
CAPTURE captureVisibleTab (Error: Either the '<all_urls>' or 'activeTab'
                           permission is required.)
  cold 1037.7 ms
  warm p50 1037.7 ms
```

Every one of those samples is the *error* path being timed, not a capture. The
spike page has neither permission, so `captureVisibleTab` rejected immediately
and the harness timed the rejection. 1037.7 ms appearing identically as both
cold and warm p50 is the tell - a real warm capture measured 23-26 ms in runs 2
and 3, and no warm number should equal its own cold number to one decimal place.

Carry forward **23-26 ms** from runs 2 and 3. This is the sixth time in this
project an instrument has reported a confident number for something it was not
actually measuring, and the pattern is identical every time: the failure had a
plausible-looking value attached, so nothing looked broken.

**Forward pass across four runs: 168, 226.7, 188 ms** on identical hardware and
dtype. The spread is real and roughly 35%. `candidates.ts` records 170-230 ms as
a range for exactly this reason; nothing should be designed around the
difference between any two of these figures.

**22 boxes this run against 5-6 before.** Same model, same dtype, and by far the
largest relative change in the table. That is a different page being probed or a
different score threshold, not a model improvement - it needs explaining before
any accuracy claim (metric 1) leans on it.

**Cold load fell to 60 s** from 202 s. Still network-bound, still the reason the
weights are vendored into the package rather than fetched at runtime.

### `modelId: 'stub'` - the default that could never load

The panel's Load model button reported:

```
model failed to load: could not load stub after 37 ms
  - webgpu: The operation was aborted. ; wasm: The operation was aborted.
```

Every layer behaved correctly. The device fallback tried WebGPU then wasm, the
error named the model, the panel showed it. The model it named was `stub`.

`DEFAULT_ENGINE_CONFIG.modelId` had been `'stub'` since before there was a
backend. Once `transformers-env.ts` set `allowRemoteModels = false` and
`localModelPath = <extension>/models/`, that string stopped being a label and
became a PATH SEGMENT - the loader resolves `models/<modelId>/config.json`. The
panel sends no config, so `host/init` fell through to the default and asked for
`models/stub/config.json`, which does not exist. `models/Xenova/yolos-tiny/` sat
right beside it, vendored and complete.

Nothing tied the contract's default to the bytes on disk.
`tests/contracts/vendored-model.test.ts` now does, importing the model id from
`scripts/vendor-model.mjs` rather than restating it. Verified in both
directions: all four assertions fail against `'stub'` and pass against the real
id. A guard that only passes is not evidence.

### A pin that could be walked around

While deciding where a local planner could live, the rule "agent-server/server
is never imported by an extension context" was probed rather than read. It was
implemented as:

```ts
if (spec.includes('agent-server/server')) { ... }
```

which catches `@/agent-server/server/planner.ts` and misses
`./server/planner.ts` - the same module, reached from inside `agent-server/`,
with a specifier containing no such substring. A probe file importing it
relatively passed all 13 architecture tests.

Specifiers are now resolved against the importing file's directory before the
check, so both spellings normalise to the same answer. Verified by probe: the
relative import now fails the test, and removing it passes. That is the sixth
instrument in this project corrected the same way, and the rule has not changed:
**a guard that cannot see the artifact it guards is not a guard.**

### The local planner, and why the logic is duplicated

`LocalPlannerClient` implements `AgentClient` with no network. It makes the
whole pipeline runnable today, on one machine, with nothing leaving it.

The heuristic is COPIED from `server/planner.ts`, not imported - and not only
because the boundary forbids it. The two are meant to diverge: the server copy
becomes the VLM adapter, this one stays a dependency-free baseline, and a
baseline that drifts with the thing it measures is not a baseline.

It returns `raw: string`, never a typed `Action`. Returning an `Action` would
have been easier and would have quietly deleted the runtime backstop for the
local path. Instead the local path speaks the same wire format and submits to
the same `parseAction` + `validateAction` gate as bytes from an untrusted
server. A test asserts the gate still refuses a ref the context never contained.

It also skips refs already in `context.history`. Without that the baseline
clicks the same best-matching button forever - the page changes, that element
keeps the best name, it wins again. A loop that cannot progress is worse than no
loop, because it looks like it is working.

### Tests that passed without testing

Probing what the planner actually picks showed `checkout` returns `done` for
every goal tried. Three tests had been written as
`if ('ref' in parsed.value) expect(...)` against that fixture - so they reached
the guard, found no ref, and passed having asserted nothing.

Fixed by moving them to a fixture that does produce a click and asserting
`expect(Object.keys(parsed.value)).toContain('ref')` first, so a future change
that stops producing a ref fails loudly instead of passing quietly. The early
`return` in the progress test became a `throw` for the same reason.

Worth noting the shape: this is the same failure as the byte tally, the manifest
test and the server-import pin. Every one of them reported success about a
subject it was not looking at.

### The Chrome host returned the envelope, and a failed load reported as success

The panel showed `Model: loaded` next to `Weights NaN MB`, `Load time NaN ms`,
`Note: undefined, NaN MB in NaN ms`.

`entrypoints/offscreen/main.ts` replies `{ok, cmd, result}`.
`ChromeOffscreenHost.request` did:

```ts
const response = await this.#api.runtime.sendMessage({ target: 'offscreen', cmd, payload });
return response as T;
```

It handed the ENVELOPE to every caller typed as `T`. Two consequences, and the
second is worse than the NaN:

1. `InitResult.backend/weightBytes/loadMs` were all undefined, so the panel
   formatted them into a confident sentence.
2. The offscreen listener CATCHES every error and RESOLVES `{ok: false, error}`
   - it has to, because a rejected promise returned from an `onMessage` listener
   arrives as `undefined` and the error is lost. Since `request` never inspected
   `ok`, `initModel`'s `.catch` was unreachable. **A model that failed to load
   reported as loaded.**

And a third, latent: `host.request<VisionResult>('detect')` would have returned
undefined `detections`, so `redact()` would throw on `vision.map` and every
Chrome step would die at the redact stage - after the panel had already called
the model healthy.

**The Firefox host was correct all along.** It dispatches in-process and returns
the bare result, which is why Firefox gave a clean
`could not load stub after 37 ms` while Chrome gave `NaN`. So
`InferenceHost.request<T>` meant two different things depending on the browser.

`OffscreenReply<T>` is now declared once in `perception/host/host.ts` and
referenced by both ends.

**Why nothing caught it.** Three separate reasons, all worth keeping:

- The only Chrome test that called `request` awaited it and threw the value
  away, asserting solely on the OUTGOING message.
- The fake's `sendMessage` returned `{ok: true}` with **no `result` field**, so
  even adding an assertion would have proved nothing - there was nothing for the
  unwrap to drop. A fake tidier than the real thing hides the bug it exists to
  catch.
- `tests/orchestrator/step.test.ts` fakes `InferenceHost.request` returning the
  UNWRAPPED payload - i.e. the fake honours the interface **more correctly than
  the real implementation does**. All 22 `runAgentStep` tests proved the pipeline
  works against a host that behaves as documented, while the shipped one did not.

`tsc` could not help either: `as T` from `Promise<unknown>` is legal under every
strict flag this project sets. Only asserting the returned value finds it. Five
new tests do, verified failing against the old code.

### MV3 service workers forget, and the panel does not

The panel displayed `attached to tab 544578691` while the background answered
`no tab attached` to five clicks in a row. Both were telling the truth: Chrome
tears the service worker down after ~30 s idle, `let attachedTab` resets to
null, and the panel is a separate context that kept its copy.

`attachedTab` now lives in `storage.session` - in-memory, cleared when the
browser closes, which is exactly the lifetime of the activeTab grant it
describes. `storage.local` would have been wrong: it would resurrect a grant the
browser no longer honours. It is re-VERIFIED on rehydration with `tabs.get`,
because the tab may have closed or navigated while the worker slept and both
revoke the grant.

`modelState` had the same defect with the opposite sign: on Chrome the offscreen
document OUTLIVES the service worker, so after a teardown the background says
"not loaded" while 26 MB of weights are still resident next door - and would
offer to load them again. The fix is not to persist the variable but to stop
believing it: a new `status` command asks the worker, which is the only context
that knows.

### Other things the sweep confirmed

- **`Math.random()` for the redaction nonce**, while `newSessionSalt()` existed
  for exactly this and documents that it refuses to fall back to Math.random.
  The nonce is the entire defence against a page forging
  `[[PII:KIND:n:nonce]]`; 32 guessable bits made that cheap and the failure is
  silent at both ends. Now CSPRNG.
- **`context.history` was always `[]`** - nothing ever filled it. That silently
  disabled the local planner's loop-breaker, so the baseline would re-pick the
  same element forever. Now threaded through `StepInput` and accumulated per
  step.
- **The panel rendered "Peak heap 0.0 MB (derived-from-model-bytes)" and
  "Latency 0 ms" before any step had run.** `resource/sample` is emitted by
  nothing in the codebase, so that figure could never have been real - and the
  attributed source made it read as a measurement rather than as its absence.
  Absent is now distinguishable from zero, which is the project's own rule.

### Redaction could not run on Chrome at all

Firefox completed a full agent step - capture, detect, redact, plan, execute, two
api-keys redacted. Chrome failed every step with:

```
redact: DOMParser is not defined
```

`redact()` calls `new DOMParser()` at redact.ts:122. Chrome's MV3 background is a
service worker with NO DOM. Firefox's MV3 background is an event page that HAS
one. Same file, same code, one engine silently unable to run a core stage - and
the stage in question is the one that removes PII.

The offscreen document exists precisely for this class of problem and already
owns the model and pixel baking. Redaction never moved there.

**Why it could not be a one-line injection.** `redact()` returns a `Document`,
`buildSanitizedContext()` consumes it, and a `Document` cannot cross
`runtime.sendMessage`. So on Chrome both calls must happen on the far side, with
only serialisable values crossing. `DomPipeline` is that seam: in-process on
Firefox and in every test, remote on Chrome. The Document is retained between the
two calls and addressed by handle - the same shape `LocalWorkerRuntime` already
uses to keep a decoded bitmap between `detect` and `bake`.

Three details that were not obvious:

- **The HTML travels as a bare string.** `Untrusted<T>` hides its payload behind
  a module-private symbol, and symbol keys do not serialise, so
  `JSON.stringify` of a marked value yields `{}`. Marking before the hop would
  have delivered an empty object and redacted an empty page - silently, with a
  plausible-looking result. The wrapper is applied on ARRIVAL, at the moment of
  parsing.
- **`refPaths` crosses as entries.** A `Map` also serialises to `{}`, so sending
  one would arrive empty and every action would report a miss with no clue why.
- **`createRuntimeDispatch` throws on unknown commands**, which is correct, so
  the offscreen entrypoint composes a router rather than forwarding. It is also
  the only place `perception` and `redaction` may legally meet.

`StepDeps.dom` is REQUIRED rather than optional. Optional-with-a-default would
have made the Chrome fix opt-in, and forgetting it at a call site would
reproduce the original bug byte for byte. Required makes that a compile error;
it caught the orchestrator test fake immediately.

**Verified structurally, not just by tests.** In the emitted bundles,
`chrome-mv3/background.js` now contains ZERO references to `DOMParser`, the
Chrome offscreen chunk contains it, and `firefox-mv3/background.js` still does.
The code that needs a DOM is now only in contexts that have one.

### Two guards that were not guards, again

**The test premise was wrong.** The first draft of
`tests/redaction/dom-pipeline.test.ts` asserted that the default node
environment has no `DOMParser`. Probing it printed `undefined` in one file and
`function` in another, with identical imports and settings. Rather than build on
an ambient property that could not be reproduced, the test now DELETES the global
explicitly and restores it afterwards. A guard resting on an environment
assumption is the same failure this project has now hit five times.

**And the guard found a real defect while being written.** `DomPipeline.redact`
is typed `Promise<DomRedactReply>` but threw SYNCHRONOUSLY - a missing
`DOMParser` is a ReferenceError raised during the call, not a rejection. Any
caller writing `.catch()` would have missed it entirely; only a surrounding
try/catch saved `runAgentStep`. Both methods are now `async`, which converts
every throw in their bodies into the rejection the signature already promised.

### The vision model cannot detect what the pipeline asks of it

`Xenova/yolos-tiny` emits the 91 COCO classes - person, bicycle, car, traffic
light. `labelToPiiKind` (postprocess.ts:120) recognises ten labels, and exactly
ONE of them is a COCO class: `person`, mapping to `face`. The other PII kinds
this pipeline supports - `signature`, `id-document`, `credit-card` - can never be
produced by this model, because it has no such classes. Any other box it emits
hits `labelToPiiKind(...) === null` and is dropped at postprocess.ts:165.

Measured on a real page (amazon.in), one step:

| | |
|---|---|
| vision | 1626 ms of a 1696 ms step - 96% |
| boxes returned | 0 |
| detections merged | 1, from the DOM |
| redactions | 2 api-keys, from `scanDom` |

So metric 1 (visual context, 25%) and metric 2 (PII recall, 20%) are currently
carried ENTIRELY by the DOM path, while the model consumes 96% of the latency
budget contributing nothing. It also ran ~8x slower than the spike's 188-226 ms,
which is a separate question and should be re-measured before being designed
around.

This is what `bench.ts` exists to decide, and it now has a real measurement
rather than an assumption. A model that detects UI elements or document regions
would change these numbers; this one cannot.

### Closing the host/state sweep

Five items the adversarial sweep confirmed and the previous session left open.

**Firefox lost the model silently.** The runtime lives in the same event page as
the background with no keepAlive by design, so an unload discards it - but
`modelState` is a variable in that same page and could still say `loaded`.
Chrome was already covered, because its offscreen document outlives the service
worker and can be asked. Firefox needed the opposite treatment: when the host is
NOT running and we think a model is loaded, that belief is stale. A step now also
reconciles up front and refuses with "model is not loaded - press Load model
first" rather than failing several stages later with an internal error about
init not having been awaited.

**Retained frames were unredacted pictures of the screen.** Eviction happened
only on a fifth `detect` or in `dispose()`, so up to four decoded buffers
(~3.5 MB each) outlived the step that captured them, in a document whose owner
might already be gone. The step knows when it is finished with a frame, so it
now says so - in a `finally`, because a step that dies at `plan` has still
captured a screenshot. Both the happy path and the failure path are tested.

**Vision detections were salted with a constant.** `LocalWorkerRuntime` took
`salt` as a constructor option defaulting to `'perception'`, and neither
entrypoint passed one - so every vision digest was reproducible across sessions
and machines while the DOM detections in the SAME log used a per-session value.
The salt now travels with `init`, which is the call that establishes a session.
The remaining default is renamed `'unsalted-no-session'`: if it ever appears in
a digest it means init was called without one, which is a wiring bug rather than
a session.

**`e2eMs` was a sum of overlapping stages.** `LatencyBreakdown` documents it as
"wall clock for the whole step - NOT the sum of the above, they overlap".
`runAgentStep` always computed the real value; no `PanelEvent` carried it, so
the panel invented one by adding the bars up and displayed the result as a
measurement. A `step/done` event now carries the real figure, on both the
success and failure paths - a step that died after 4 s of vision is a different
problem from one that died instantly.

The panel test that asserted the sum was CORRECTED, not deleted: it had pinned
behaviour the contract forbids. It now asserts the stages are still recorded and
that no wall clock is invented from them, plus a second test proving the real
figure can exceed the sum - which a sum can never show.

**Nothing spanned the two halves of the Chrome wire protocol.** The envelope was
minted in `entrypoints/offscreen/main.ts`, and `entrypoints/` has no tests by
convention; the consumer was only ever checked for what it SENT. That is exactly
how one end came to wrap while the other never unwrapped. `answerOffscreen` now
lives in `perception/host/host.ts` beside the parser, and five tests drive the
real producer into the real consumer with only the message channel faked.

### Weights were unmeasurable on Firefox

Resource Timing reports `decodedBodySize: 0` for extension-internal reads on
Firefox, so `measureWeightBytesVia` correctly returned null and the panel showed
"unmeasurable". Honest, but it left the resource metric - 20% of the score - with
no weight figure at all on one of the two supported browsers.

`measurePackagedWeights` is the fallback: it reads the packaged `.onnx` (and
`.onnx_data`, when present) and reports the real byte length. A local read, not a
network fetch, done once after load, of bytes already in the disk cache. Still
MEASURED rather than declared - it counts the actual bytes rather than trusting
`vendored.json`, which only records what a build step intended to fetch. It
returns null, never 0, when nothing is readable: a confident zero would land in
the resource metric as a model that weighs nothing.

### The server exists

The brief requires "a working prototype consisting of client side extension
**and server**", and specifically "transmission of the anonymized visual context
to a centralized LLM/VLM". Until now `agent-server/server/` held a request
handler and two dependency-free planners, and a grep for any model call returned
only comments saying "when the real VLM lands". That was the one unambiguous
missing deliverable.

**`VlmPlanner`** speaks the OpenAI chat-completions shape. That is not a
preference for OpenAI - it is the interface vLLM, Ollama, llama.cpp's server,
Together, Groq and OpenRouter all expose, so one adapter serves both halves of
the brief: an offline-deployable open-weights model for the real deliverable and
a cloud-hosted instance of the same weights during the hackathon.

It is a **VLM, not just an LLM**, when there is something to see: if the
sanitized context carries a baked screenshot it goes as an image part. Those
pixels have already been redacted on the client, and `BakedScreenshot` is a type
only `bakeRedactions()` can mint, so there is no path that sends an unredacted
frame to a server.

**It returns the raw string, never a parsed action.** `parseAction` and
`validateAction` stay on the CLIENT, precisely because the server is the part
that could be compromised. A planner that returned a typed `Action` would move
that decision to the wrong side of the trust boundary, and it would have been
the easier thing to write.

**`server/` is outside `src/` deliberately.** `boundaries.test.ts` forbids
`node:*` anywhere in `src/` except the harness, and that rule is what keeps
node-only code out of the extension bundle. The server genuinely is a Node
program, so it lives where the rule does not have to be bent - and it is still
typechecked, because `tsconfig.json` includes `server/**`. Verified after the
fact: neither built bundle contains `agent-http` or `VlmPlanner`.

**No secrets, and no default that reaches the network.** Endpoint, model and key
all come from the environment. With none set the server runs `HeuristicPlanner`
and says so at startup and on `/health`, rather than silently pointing at
somebody's cloud or claiming a model it does not have.

### Two defects the integration test found immediately

Both were in code that the pure-function tests could not see, which is the
argument for having written it.

**A refused oversize body wedged the next request.** Rejecting mid-read left the
client still sending into a handler that had stopped listening; the unread bytes
stranded the keep-alive socket and the NEXT request on that connection hung.
It surfaced as a later test timing out, not as the oversize test failing.

Two attempts got it wrong before the third got it right. `socket.destroy()`
reset the connection before the 400 had flushed, so the client saw ECONNRESET
instead of the message explaining what it did wrong - a hang traded for a less
informative failure. `connection: close` alone did the same. The fix is to DRAIN
and discard: the buffer is dropped once the cap is passed, the rest of the body
is read and thrown away, and the response is delivered normally. Memory stays
bounded at the cap; the drain itself is capped at ten times it so a body that
never ends cannot hold the handler open.

**A malformed context was reported as retryable.** POSTing a hand-rolled context
at the running server - not a test - showed that one missing `redactionSummary`
reached the planner and died inside `renderPrompt` with "Cannot read properties
of undefined (reading 'byKind')", which `handlePlanRequest` then reported as
`retryable: true`. A client obeying that would retry a malformed request
forever, and the message named a field of a field rather than the missing one.

Every existing test built its context with the real pipeline, so that shape had
never occurred. `validateRequest` now checks it, and the regression test pins
`retryable: false`.

### Using it

```
npm run server                      # HeuristicPlanner, no model
VLM_ENDPOINT=http://localhost:11434/v1/chat/completions VLM_MODEL=qwen2.5-vl:7b npm run server
```

Then grant `http://localhost:8787` in the sidebar. The background stores the
granted origin in `storage.session` and switches from `LocalPlannerClient` to
`HttpAgentClient`; with no origin granted it plans locally, which is a real mode
rather than a degraded one. `allowedOrigins` is the granted origin and nothing
else, so a `navigate` anywhere but there is refused no matter what the server
asks for.

### A match pattern cannot contain a port

Firefox refused the server grant:

```
Cannot request origin permission for http://localhost:8787/* since it was not
declared in the manifest
```

which reads as a missing declaration and was not one. The manifest declared
`http://localhost/*` all along. **A match pattern's host may not contain a
port** - that is the platform's rule - so `http://localhost:8787/*` was not a
pattern that could match anything, and Firefox said the only thing it could.
Chrome accepted the identical request, so this failed on one engine only.

`deriveOriginPattern` built the pattern as `${url.origin}/*`, and `origin`
includes the port. The two fields on `OriginGrant` already existed for exactly
this split and were being used for one thing: `origin` is what the client
FETCHES, port and all; `pattern` is what the browser is ASKED FOR. Only the
second must drop the port.

The consequence, stated rather than hidden: **the grant is per-HOST, not
per-port.** Granting `localhost:8787` also permits `localhost:3000`. There is no
narrower option - the permission model cannot express a port.

A test had pinned the old behaviour (`expect(pattern).toBe('https://agent.example.com:8443/*')`),
so it was pinning something the platform can never grant. Corrected, not deleted,
alongside a general guard that no derived pattern may ever contain a port.

### The guard then found a second instance immediately

A new built-manifest test asserts that **every origin `deriveOriginPattern` can
produce is one the emitted manifest declares** - the check whose absence let the
first bug ship, since the two halves were written independently and nothing
compared them.

It failed on its first run: `http://127.0.0.1:8787` derives
`http://127.0.0.1/*`, which was not declared. A user typing the IP form instead
of `localhost` would have hit the identical opaque failure. `127.0.0.1` is now
declared beside `localhost`; both stay http-only and loopback-only.

It also surfaced `[::1]`, which `deriveOriginPattern` accepted as loopback.
Match patterns cannot express an IPv6 literal host, so anything derived from it
could never be declared. It is now refused by name, with the fix in the message
("use http://localhost or http://127.0.0.1"), rather than deriving something
ungrantable and letting the browser explain it badly.

Emitted and verified:

```
optional_host_permissions: http://localhost/*, http://127.0.0.1/*, https://*/*
host_permissions:          (none)

http://localhost:8787          -> http://localhost/*          DECLARED
http://127.0.0.1:8787          -> http://127.0.0.1/*          DECLARED
https://agent.example.com:8443 -> https://agent.example.com/*  DECLARED
http://[::1]:8787              -> REFUSED (IPv6 literal cannot be granted)
http://evil.example.com:80     -> REFUSED (http is only allowed for localhost)
```

No `<all_urls>`, no permanent host permissions, still user-granted at runtime.

### Pinning the Chrome DOM split against the emitted bundle

The DOM work had already moved to the offscreen document, but nothing asserted
it stayed there. Two tests now do.

`tests/built/bundle.test.ts` reads the EMITTED service worker and requires it to
contain no `DOMParser`, no `parseFromString` and no `'text/html'` - the
implementation's own fingerprints, so an inlined copy under a minified alias is
caught too - plus the positive half, that some offscreen chunk DOES contain them.
Without that second assertion, deleting redaction entirely would pass.

`tests/integration/chrome-dom-path.test.ts` runs the whole Chrome path with the
real wire protocol on both ends: `answerOffscreen` mints the envelope,
`ChromeOffscreenHost.request` parses it, `createInProcessDomPipeline` does the
redaction. Only the message channel is faked.

What makes it a real test rather than a description: it runs in the NODE
environment and deletes `DOMParser` up front, installing a jsdom one ONLY for the
duration of each offscreen handler call and removing it again in a `finally`. The
background half therefore executes with no DOM in scope, exactly as a service
worker does. Verified by reverting the background to the in-process pipeline: the
test fails with `step failed at redact: DOMParser is not defined`, the original
symptom, reproduced on demand.

It also checks the redaction survived the round trip - `user@example.com` must
not appear anywhere in the returned context - and that an `ok:false` from the far
side surfaces as a staged failure rather than the silent success the envelope bug
used to produce.

`vitest.built.config.ts` gained the `@` alias it never had, because the useful
built tests compare the artifact against the source's own expectations and that
comparison needs the source importable.

### `fetch` is not callable from a service worker without a receiver

Chrome reached the server and failed:

```
plan: server: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation
```

`HttpAgentClient` did `this.#fetch = globalThis.fetch`, storing the function
unbound, so `this.#fetch(...)` invoked it with `this` set to the CLIENT. A
Window tolerates that. `WorkerGlobalScope.fetch` checks its receiver and throws.

This is the third instance of one shape: **Chrome's background is a worker and
Firefox's is not.** `DOMParser` was the first, the offscreen envelope the second,
this the third. Code that ignores the difference works in exactly one engine, and
the one it works in is the one this project happened to test in first.

Nothing caught it because every test injected `fetchImpl` - an ordinary function
with no opinion about its receiver - so the real default path was never
exercised. `tests/agent-server/client.test.ts` now stands in for
`WorkerGlobalScope.fetch` by checking `this` and throwing the actual browser
message. Verified by reverting the bind: the test fails.

### Absent is not zero, twice more in one screenshot

**"server no usable action (0 chars)"** was reported for a request that never
reached a model. The failure path emitted `server/response` with
`rawLength: 0`, so a transport error was rendered as a model that had answered
badly. The real cause appeared on the next line, but the misleading one came
first. No event is emitted now; the staged failure says what happened.

**"planning via http://localhost:8787"** and the planner's own reasoning were
being emitted as `error`, so normal operation was listed in red under Errors. A
UI that calls routine behaviour an error teaches you to ignore the error list,
which is the opposite of its purpose. Both are now a `notice`, which reaches the
timeline and never the error list.

### The vision model earns its place, on a real page

The first Chrome run through the complete pipeline, on youtube.com:

```
capture     216028 bytes in 857 ms
vision      18 box(es) via webgpu
merge       21 detection(s)
redaction   21 applied, residual risk none
sent        605 element(s), 130250 bytes
REDACTED    face x42, placeholder + blur
```

Worth recording against the earlier finding that the model contributed nothing.
On amazon.in it returned 0 boxes in 1626 ms; here it returns 18, and 42 faces are
redacted with both a placeholder and a pixel blur. The difference is the page:
COCO's `person` class is the one label `labelToPiiKind` understands, and a video
grid is full of people while a product listing is not.

So the model is not useless - it is narrow, in exactly the way its class list
predicts. That does not change the conclusion for `bench.ts`: `signature`,
`id-document` and `credit-card` remain unreachable through vision, and metrics 1
and 2 still rest on `scanDom` for every page that is not full of faces.

### Where the agent task actually stopped

The pipeline reported success at every stage and the page never changed. Three
blockers, in the order the chain hits them. Only the third was the one I
expected.

**1. The client read the wrong shape off the wire.** `server/agent-http.ts`
responds with the whole `PlanOutcome` - `{ok, response:{raw, modelId,
serverMs}}` - and `HttpAgentClient.plan()` read `raw`/`modelId`/`serverMs` off
the TOP level. All three were undefined, `raw` fell back to `''`, and
`parseAction('')` failed with `empty-input`. The step died at the parse stage
having reported a healthy server round trip.

Found by running the real server against the real client, not by reading either.
That is the THIRD envelope mismatch in this project - the offscreen host and the
offscreen dispatch were the first two - and the cause is identical every time:
one side wraps, the other reads through, and no test spans both. There is now a
test that does.

**2. Neither planner could express the goal.** `HeuristicPlanner` filtered to
`el.role !== 'button' && el.role !== 'link'` and could emit exactly two strings,
`click` or `done`. `LocalPlannerClient` had the same ceiling via a six-role
`ACTIONABLE` set. `searchbox` and `textbox` are in `INTERESTING_ROLES`, so the
search field WAS among the 602 elements sent - and both planners discarded it by
role before scoring. A goal naming text to enter was unsatisfiable in principle.
The best available move was clicking a submit button with the field still empty,
which executes cleanly, reports a hit, and changes nothing.

**3. And it did not even pick the button.** Measured on live youtube.com with the
real scoring code: goal "search for laptop" gives goalWords `{search, for,
laptop}` - "for" is three characters, so a length filter keeps it - and a news
headline ending "...Depart For?" scored as highly as the search button. The loop
takes the first element to reach the best score, so the headline won.

Fixes: a shared `text-intent.ts` that reads an entry verb out of the goal and
returns the remainder as the text to type, a stopword list so "for" stops
scoring, and a text-entry branch in BOTH planners that emits
`{type, ref, text, submit:true}`. `submit: true` matters - it routes to
`form.requestSubmit()`, which needs no focus and no synthetic keyboard event, so
one action completes the task.

Nothing is hardcoded to the task: "laptop" appears in no source file, and a test
runs the same path with "standing desk" to prove it.

The server copy also gained the already-tried and disabled guards its client twin
already had. Without them a multi-step run re-clicks the same element forever -
the exact failure the local copy was written to avoid.

### Does the page change?

`tests/integration/task-completion.test.ts` asks the question the rest of the
suite does not. Every other test asks whether `runAgentStep` returns `ok`; this
one builds a live document, runs the real step against it, and asserts
`document.querySelector('#q').value === 'laptop'` afterwards.

The action is produced by the planner, serialised as a raw string, and passed
through `parseAction` and `validateAction` before it reaches the document - the
same gate a hostile server's output faces. The test also pins the negative: a
click-shaped goal ("open the handbook") must leave the field empty, and a
sensitive field must never be typed into.

### One step was all there was

There was no loop. `runAgentStep` was called exactly once per button click and
nothing scheduled a second call - no scheduler, no `session/end` emitter, an
unabortable `deps.signal`. The prototype could demonstrate a pipeline but not an
agent.

`orchestrator/loop.ts` adds one, and the interesting part is the stop conditions,
because this clicks and types on a real page on someone's behalf. An unbounded
loop driven by a heuristic that cannot tell success from failure is a way to
submit a form forty times. Seven exits, each tested:

  done | abort | ask_user   the planner says stop
  error                     a step failed; retrying would repeat the fault
  cancelled                 the user pressed Stop, checked BEFORE the next step
  no-progress               the page fingerprint repeated twice running
  max-steps                 the hard ceiling, default 8

`no-progress` is the one that matters for a heuristic planner: it cannot observe
the effect of its own action, so without a signal from the DOM it will re-emit
the same one. The fingerprint is `href | element count | text LENGTH` - it
changes when the page changes and carries nothing readable, which matters because
it crosses to the background on every step.

`done` is the ONLY reason reported as success. `max-steps` and `no-progress` both
mean the loop ended cleanly and the task did not complete, and the panel says
which rather than showing a bare "stopped".

### "Failed to fetch" was two problems wearing one message

The server was not running. That was the immediate cause, and the message the
panel showed - a bare "Failed to fetch" - said none of it: it is what the browser
returns for a refused connection, a blocked preflight and a DNS failure alike,
and it names neither the endpoint nor a next step. The client now says
`could not reach http://localhost:8787/plan - is the agent server running?
(npm run server)`, and passes a specific error through unchanged rather than
replacing it with a guess.

But there was a second problem underneath, which would have produced the
identical message once the server WAS running.

**Private Network Access.** The extension's origin is `chrome-extension://...`,
a SECURE context; `http://localhost` is a PRIVATE network address. Chrome treats
secure-to-private as needing consent from the target: it sends
`Access-Control-Request-Private-Network: true` on the preflight and refuses the
real request unless the server answers with
`Access-Control-Allow-Private-Network: true`. The server did not.

The failure mode is nasty because the server never sees the POST at all - its log
stays empty, so it looks exactly like a server that is down. Verified by
preflight:

```
> OPTIONS /plan  Access-Control-Request-Private-Network: true
< HTTP/1.1 204 No Content
< access-control-allow-private-network: true
```

Safe here specifically because this server holds no cookies, no sessions and no
ambient authority - a request carries everything it acts on - so consenting to be
reached from a browser grants nothing that `curl` would not.

### The chain, verified end to end

Against the running server, with a context from the real redaction pipeline:

```
POST /plan   (goal: "search for laptop", benign-docs)
{"ok":true,"response":{
  "modelId":"heuristic-baseline",
  "raw":"{\"type\":\"type\",\"ref\":\"e2\",\"text\":\"laptop\",\"submit\":true}"}}
```

A real `type` action, over HTTP, with the text derived from the goal rather than
written anywhere in the source. Combined with
`tests/integration/task-completion.test.ts` - which asserts
`querySelector('#q').value === 'laptop'` on a live document after a real step -
every link from goal to changed page is now covered by something that would fail
if it broke.

### The first completed task, and the bug it exposed

On an offline test page, Chrome ran the whole chain and the task WORKED:

```
capture 113469 bytes in 26 ms
vision 0 box(es) via webgpu
merge 17 detection(s) | redaction 15 applied
sent 54 element(s), 13940 bytes
server type in 3 ms -> action type ok -> step 1 ok in 986 ms
```

The page showed "Search results for: laptop" and its own console logged
`Search form submitted` / `Results updated: 2 product(s)`. Goal to changed page,
end to end, through the real server.

**Then it kept going, and that is the bug.** Steps 2-4 were also `type`, steps
5-8 `click`, ending in `max-steps`. The dedup was per-REF, so having typed into
the search box the baseline found the next untried text field and typed into that
one too. It filled a payment form's EXPIRY DATE with `laptop` and posted the
query as a product review.

That is harmful rather than untidy: an agent that sprays the goal text into every
reachable field will eventually reach one that matters. The `no-progress`
detector could not save it either - the page genuinely changed each time, because
each step filled a different field.

**One text entry per goal.** `hasEnteredText(history)` now short-circuits both
planners: a goal that named text to enter, with a successful `type` already in
history, is `done`. Falling through to the click scan is exactly what caused the
spraying.

Verified against the live server, restarted so it was running the new code -
which mattered, because the first attempt still returned `type` from a process
started before the edit:

```
step 1 (empty history)   -> {"type":"type","ref":"e2","text":"laptop","submit":true}
step 2 (type in history) -> {"type":"done","summary":"text entered and submitted"}
```

Two steps instead of eight, and the second field is never touched. A test asserts
the direct property: after the step, exactly ONE text-bearing control on the page
is non-empty, and it is the one the planner chose.

### Other things that run showed

- **`no-progress` never fired, correctly.** Every step changed the page. The
  stall detector is not a substitute for a planner knowing when it is finished.
- **The loop's ceiling did its job.** `max-steps` stopped it at 8 rather than
  letting it continue, and was reported as a failure to complete rather than as
  success.
- **`vision 0 box(es)`** again on a page with no people, consistent with the
  COCO class analysis. All 15 redactions came from `scanDom`.
- **Redaction counts accumulate across steps** - 180 shown for a page with ~10
  planted items over 15 steps. That is a session total, not a per-step count, and
  the panel does not say so.

### Verified working, and the exact shape of what works

Chrome, offline test lab, local planner (no server granted):

```
step 1  type -> ok    (1724 ms)
step 2  done -> ok    (980 ms)
loop stopped after 2 step(s): done
```

The page showed "Search results for: laptop" with 2 products, and - the part
that matters after the previous run - Expiry Date still `12/28`, review box
empty, country unselected, cart at 0. The field-spraying fix holds on a real
page, not just in a test.

Redaction counts came back proportionate too: 30 across two steps (email 10,
credit-card 6, phone 6, password 2, person-name 2, cvv 2, unknown-sensitive 2)
against 180 over the eight-step run.

**THE LIMIT, measured rather than assumed.** The baseline was probed across goal
shapes:

```
search for laptop      -> type
open the handbook      -> done
view the pricing page  -> done
accept the terms       -> done
go to profile          -> done
```

Only TEXT-ENTRY goals produce an action. A click goal needs a button or link
whose ACCESSIBLE NAME literally shares a word with the goal, and "Open Laptop
Pro" scores nothing against a button named "View Details" - the product name is
in a heading, not on the control. So of the nine scenarios on the test lab,
realistically two work: the two searches.

This is a planner limitation and not a pipeline one. Everything downstream
handles `click`, `select`, `scroll` and `key`; no planner emits the last three at
all, and `click` only fires on a literal name overlap. Closing that gap means
either a planner that reads structure around a control - the accessible name of
an ancestor card, say - or the VLM, which is what the brief actually calls for.
The baseline exists to be beaten, and this is the measurement of how beatable it
currently is.

### Click goals work, and sprayed the same way typing did

"Go to the profile" ran cleanly: one click, then done, two steps, and the page's
own console logged `Navigated to Profile`. So the click path works - the earlier
probe that returned `done` for every click goal was a property of the
benign-docs fixture, whose controls share no words with those goals, not of the
planner.

But "Open Laptop Pro" opened FIVE products: Laptop Pro, then Gaming Laptop, then
Smartphone X, Wireless Headphones and Monitor 27". Six steps ending in done.

Same failure as the text spraying, one layer up. Laptop Pro's control scores on
both goal words, Gaming Laptop's on one, and the per-ref dedup does not help
because each is a different ref - so the baseline works its way down the list.

**Only act on a strict improvement.** Both planners now compute the best score
they have ALREADY acted on and skip any candidate scoring at or below it. A
worse match is not progress, and this baseline has no way to tell whether more
clicking helps. Laptop Pro (2) then Gaming Laptop (1) stops at done.

That leaves a real limitation, stated rather than hidden: the baseline takes at
most one action per score tier. Genuine multi-step flows - fill a field, then
click a button whose name shares nothing with the goal - are out of reach for it.
That is the VLM's job, and the loop is already built to drive one.

### `https://http` was accepted as a server origin

A scheme typo produced `planning via https://http`, and the loop spent a step
failing to reach it. `new URL('https://http')` parses happily, because "http" is
a syntactically valid hostname, so `deriveOriginPattern` had nothing to object
to - it checks the scheme, credentials, wildcards and loopback rules, and a
single-label host passed all of them.

`https://x` was accepted too. Now a hostname with no dot is refused, unless it is
loopback, with the likely intent in the message: `did you mean
http://localhost:PORT?`

### The visual context was never actually being sent

Preparing for a real VLM surfaced a gap that would have made the whole exercise
meaningless: `input.screenshot` was never set, so every context carried
`screenshot: null` and `VlmPlanner` sent text only. A vision model would have
been used as a text LLM, and the brief's "transmission of the anonymized visual
context to a centralized LLM/VLM" would have been unmet while appearing to work.

The screenshot is now sent WHEN A SERVER IS GRANTED and not otherwise. The
on-device baseline has no use for pixels and baking them costs a canvas pass per
step for nothing; a server is the only consumer, and it is what the brief is
about. The pixels that travel have been through `bakeRedactions`, and
`BakedScreenshot` is a type only that function can mint, so there is still no
path that sends a raw frame.

Note this contradicts `scorecard`'s "screenshot policy: DO NOT SEND", which was
measured against the STUB planner and found no accuracy gain. That measurement is
about whether pixels help the baseline. It says nothing about a VLM, and the
brief requires them.

### Ollama could not be installed from this environment

Recorded so it is not attempted the same way again.

- `winget install Ollama.Ollama` runs and produces NO output, indefinitely. Same
  for the `.Portable` variant with `--scope user`. The package resolves fine
  (`winget search` returns v0.33.2), so this is the installer blocking on a UAC
  elevation prompt that cannot be shown in a non-interactive shell.
- The portable zip is 1392 MB. Measured transfer: ~36 MB in ~8 minutes, or
  ~4.5 MB/min, which puts the download at **~5.2 hours**. Cancelled.

That rate is consistent with the spike's model download (25 MB in 116-202 s) and
is the same network constraint that made bundling the weights the right call.

**Consequence for model choice.** At ~4.5 MB/min through this shell a
`qwen2.5vl:3b` pull (~3.2 GB) is ~12 hours. A browser download is the better
route - it resumes and parallelises where curl here does not - and is what was
actually used.

**GPU, corrected.** An earlier note in this file said the machine has a Radeon
780M and that inference would therefore be CPU-bound and slow. That was wrong:
`Get-CimInstance Win32_VideoController` was read for its FIRST result only, and
this is a hybrid laptop. `nvidia-smi` reports:

```
NVIDIA GeForce RTX 4050 Laptop GPU, 6141 MiB, driver 596.49
```

So CUDA is available and a 3B vision model fits comfortably in 6 GB. The
installer is ~1.5 GB precisely because it bundles CUDA 12, CUDA 13 and ROCm, and
the CUDA payload is the part this machine needs. Reading one row of a
multi-row result and generalising from it is the same mistake as the byte tally
that summed retries - the query was right and the reading was not.

### Sizing the model for a 6 GB laptop that has already crashed once

A heavier model previously took this machine down - crash and shutdown under
load. The number that explains it:

```
nvidia-smi: 6141 MiB total, 1477 MiB used, 4444 MiB FREE
```

The browser and Windows hold ~1.5 GB, so the real budget is ~4.3 GB, not 6. A
7B model at q4 is ~4.7 GB of weights before any KV cache, so it does not fit,
spills into system RAM, and thrashes - sustained full load on a laptop chassis,
which is a plausible route to a thermal or power shutdown.

**Chosen: a 3B TEXT model, ~1.9 GB.** With an 8k context its KV cache is a few
hundred MB, so the whole thing sits near 2.5 GB and leaves real headroom.

The reason a text model is not a compromise here is that THIS TASK IS NOT A
VISION TASK. The sanitized context already carries every element's role,
accessible name, states and geometry, extracted from the DOM. Choosing which ref
to click is reading a structured list. The screenshot is a nice-to-have that the
brief asks for, and it is the expensive half: 1-2k vision tokens per step on top
of ~4k of text, and it requires a vision model roughly 1 GB larger than its
text-only sibling. On 4.3 GB free that is exactly the combination that does not
fit.

Two changes followed:

- `DEFAULT_MAX_TOKENS` 256 -> 160. An action is about 40 tokens. Every generated
  token is sustained GPU load, and a model that rambles cannot produce a better
  action for having done so.
- `SEND_SCREENSHOT` is now a constant defaulting to FALSE, replacing the
  automatic "send whenever a server is granted" added an hour earlier. That
  earlier change was right about the requirement and wrong about the hardware.
  It is one edit to turn on for a VLM demonstration with headroom to spare.

Note the brief says "LLM/VLM", so a text model is compliant; the visual context
it names is the sanitized context, which is derived from vision and DOM together
and is sent either way.

### First run against real weights

Ollama 0.33.2, `qwen2.5:3b`, RTX 4050:

```
/health   qwen2.5:3b at http://localhost:11434/v1/chat/completions (no auth)
serverMs  237
raw       {"type":"click","ref":"e2"}
parse     ok -> click
validate  ACCEPTED
target    searchbox "Search documentation"
```

A real model, given a real sanitized context, named a real element and survived
both client-side gates. That closes the last untested link in the chain.

Cost: **~500 ms warm**, against 34 s for the first call, which is the model
loading into VRAM. Resident footprint 3537 MiB used / 2384 free at 46 C - well
inside the budget that a heavier model had previously exceeded badly enough to
shut the machine down.

### The model was right about the page and wrong about our schema

The first attempt came back as:

```
{"type":"click","element":"e3"}
```

`parseAction` refused it: `missing-field: missing "ref"`. The model had read the
page correctly and picked a sensible element - it simply guessed a plausible name
for a key nobody had shown it.

The prompt was the cause. Rule 3 said "must use a ref from the ELEMENTS list",
and the only concrete JSON anywhere in the prompt was for `done` and `abort` -
which is exactly why those two were always right and `click` was not. Naming a
field in prose is not the same as showing it.

A SHAPES block now gives the exact JSON for every action type, ending with the
line "The element field is called \"ref\". Not \"element\", not \"id\", not
\"target\"." After that change the same model returned `"ref"` on all three
goal shapes tried.

Worth being precise about what this was: not a model failure and not a parser
failure. Stating our schema is our job, and the parser refusing an
almost-right action is the backstop behaving correctly - it named the missing
field, which is what made the fix a two-minute one.

**Quality, honestly.** For "search for laptop" the model chose to CLICK the
search box rather than TYPE into it - a reasonable first move that does not
complete the task. The heuristic baseline does better on that specific goal
because text entry is hardcoded into its structure. Where a 3B model should win
is the goals the baseline cannot express at all, and that is what to measure
next rather than assume.

### Two local models, one laptop GPU

The first browser run against real weights got two steps in and died:

```
step 1  server click in 3239 ms   ok in 4863 ms
step 2  server click in  551 ms   ok in 13842 ms
step 3  detect: offscreen "detect" failed: infer exceeded 15000 ms
loop stopped after 3 step(s): error
```

Ollama holds ~3.5 GB of a 6 GB GPU and runs inference on it. The extension's
WebGPU vision model wants the same device. Under that contention `yolos-tiny`,
which had been taking ~950 ms, blew past its 15 s timeout - and step 2's
13.8 s wall clock against a 551 ms server call shows it slowing down before it
gave up.

**The timeout value was not the bug.** Killing the whole task was.

Vision ENHANCES the detection set; `scanDom` produces the rest independently.
Every successful run in this project has reported `vision 0 box(es)` while
redaction still applied 15 detections from the DOM. Losing the boxes costs recall
on metric 1. Losing the task costs everything - and it lost a task that was
otherwise working, planned by a real model.

So `detect` now degrades to an empty detection set and the step continues. Two
properties make that honest rather than a papering-over:

- It is REPORTED. The panel gets `vision unavailable: <reason>` at the `detect`
  scope, so a run with degraded perception looks degraded rather than looking
  like a page with nothing on it. Silently substituting an empty result would
  make metric 1 appear fine while it was not being measured at all.
- The DOM path is asserted to still work. A test checks the context still has
  elements after a vision failure, because degrading must not mean an empty
  context.

The test that asserted the old behaviour was corrected rather than deleted: it
had pinned a severity that turned an optional enhancement's timeout into a lost
task. The latency test moved to a snapshot failure, since detect is no longer a
way to produce a failed step.

**Worth stating plainly:** running a local VLM and a local vision model on one
laptop GPU is a configuration this project should survive, and now does. It is
also a reason the vision model's contribution is worth re-examining - it costs
GPU contention and, on every page tested, returned nothing.

### Vision was costing 14 seconds a step to return nothing

With the degradation fix in, a run looked like this:

```
step 1  server click in 3744 ms   ok in  4958 ms
step 2  detect vision unavailable (15 s timeout)   ok in 15610 ms
step 3  server click in  551 ms   ok in 15072 ms
step 4  server click in  556 ms   ok in 15121 ms
```

The server answers in ~550 ms and the step takes 15 s. Vision is the whole
difference, and it returned `0 box(es)` every time.

**Cause: one timeout governed both loading and inference.** `EngineConfig`
had a single `timeoutMs` of 15 s, used for `pipeline()` AND for the forward pass.
Those are different questions - a packaged load is ~400 ms, a forward pass
~950 ms - so one number suits one or the other. Set short and the model never
loads; set long and a stalled inference blocks the step for the whole load
budget. Under GPU contention with Ollama it stalled, and every step paid 15 s.

`inferTimeoutMs` (4 s) is now separate. Vision that cannot answer in a few
seconds is not helping, and the step degrades rather than failing, so a shorter
budget costs recall and buys back ten seconds a step.

### activeTab cannot survive an agent that navigates

Step 5 of the same run:

```
capture: the attached tab changed underneath the step
page access lost: the page navigated, which revokes activeTab
```

This was predicted in these notes and is now fixed rather than documented. The
agent clicked a link, the URL changed, `tabs.onUpdated` fired, and the extension
detached the tab it was working on - ending a task that was otherwise going fine.

`AttachedTab` now records the page's ORIGIN, read at grant time because `tab.url`
is only populated while activeTab is live. On navigation the extension checks
whether a persistent host permission covers that origin: if it does, access is
retained and the panel says so; if not, it detaches as before.

The panel gained "Keep access to this site", which requests that permission. It
goes through `requestServerOrigin`, so the pinned single `permissions.request`
call site is unchanged - `boundaries.test.ts` still expects exactly
`agent-server/origin.ts`, and reusing the function rather than adding a second
call site is what keeps that true.

The origin is cached in the panel rather than fetched on click, for the same
reason every other permission call in this project is written carefully: asking
the background is asynchronous, and the await would forfeit the user gesture and
the prompt would silently never appear.

### The timeline called a local plan "server"

A run reported:

```
panel planner: goal names text to enter (considered 54)
server type in 0 ms
```

Those two lines are from different planners. `panel planner:` is
`LocalPlannerClient`'s own trace, and `0 ms` is not a network call - the whole
run planned ON DEVICE and never reached the configured model, while the timeline
labelled it "server". A run that never touched qwen2.5:3b looked identical to one
that did.

`server/response` now carries `modelId` and the timeline prints it, so the label
reads `local-heuristic-baseline` or `qwen2.5:3b` rather than a generic "server".
The field was already available on `PlanResponse` and was being discarded - a
sweep finding from earlier that had not seemed worth acting on until it caused
exactly this confusion.

### What the two planners can and cannot do, measured

Asked the same three goals against a synthetic context containing a combobox, a
checkbox and a product-card button:

```
select India as country     model: {"type":"select","ref":"e3","option":"India"}
                            baseline: IMPOSSIBLE - neither planner emits `select`
enable the terms checkbox   model: {"type":"click","ref":"e4"}   correct
add Laptop Pro to cart      model: {"type":"click","ref":"e1"}   WRONG - that is Search
                            baseline: correct, 4-word overlap
```

`grep -c "'select'"` returns 0 in both planner files, so the first row is
structural rather than a matter of tuning.

The third row is the honest counterweight: a 3B model picked the wrong element
where word-overlap picked the right one. The model is better at choosing an
ACTION TYPE and, at this size, worse at disambiguating similar elements. That is
a trade to measure per goal rather than a clean win, and it is the sort of thing
`bench.ts` should be deciding.

### "It only does one thing"

Worth writing down because it reads as a bug and is not one. A goal like "Add
Laptop Pro to cart" IS one click; finishing in one step and reporting `done` is
correct. "Search for laptop" takes two - type, then done.

The five scenarios on the test lab are five separate GOALS, not one task. Nothing
in the extension chains goals, and the loop's job is steps within a goal rather
than a queue of tasks.

Where multi-step genuinely applies is a compound goal, and that is the model's
job: the baseline deliberately acts once per score tier, a rule added after it
sprayed a search query into a payment form's expiry field and opened five
products for a goal naming one.

### The model added the same item to a cart ten times

The first real multi-step run with `qwen2.5:3b` granted:

```
step 1..8   qwen2.5:3b click ok   (every step)
loop stopped after 8 step(s): max-steps
Cart: 10 item(s)
```

Only the ceiling stopped it. On a real store that is an order.

**Root cause: the history the model was shown did not contain the ref.** The
prompt rendered `step 1: click ok` - action type and outcome, nothing else - so
across eight steps the model read "click ok, click ok, click ok" with no way to
know WHICH element. It was not ignoring its history. Its history did not contain
the one field that would have told it the job was done. `ExecutedStep` has
carried `ref` since it was written; the renderer discarded it.

History now reads `step 1: click e5 ("Add to Cart") ok`, and a rule 6 says
completed actions must not be repeated and that a satisfied goal should return
`done`.

**But the prompt is not where a safety property belongs.** A loop that clicks on
someone's page must not depend on a model reading its instructions, so the loop
now stops on `repeating`: the same action planned `maxRepeats` times in a row.

That is a distinct condition from `no-progress`, and the cart bug is exactly why
both are needed - the page CHANGED every step, because the cart counter went up,
so the fingerprint kept differing and the stall detector never fired. One watches
the page; this one watches the agent.

The key is the WHOLE action rather than `type:ref`. The first attempt used the
latter and immediately broke two existing tests: `scroll` has no ref, so scrolling
down and scrolling up hashed identically and looked like repetition. The question
being asked is "did the planner just say the identical thing", and the identical
thing is the whole object.

Two tests that used a single-action script were updated to alternate, since they
test the ceiling and the stall detector rather than this - and a repeated action
now stops before either of them can be reached.

### Vision was being paid for eight times and never worked

The same run:

```
detect vision unavailable: infer exceeded 4000 ms      x8
capture 113141 bytes in 16 ms  ->  capture in 7054 ms
```

Every step paid the full 4 s budget for a model that failed every time, while
contending for the GPU with Ollama - and `capture` climbing from 16 ms to 7
seconds is the browser itself struggling, which is what made the window laggy.

After three consecutive failures `detect` is no longer called. It is reported
once per step as `vision skipped after N consecutive failures`, so a degraded run
still looks degraded, and `resetVisionBreaker()` gives a new TASK a fresh
chance. Continuing to ask a model that has failed three times running is not
resilience; it is paying for a feature that is not working.

**Corrected 2026-08-30.** This paragraph used to say the reset gave "a freshly
loaded model" a fresh chance. It did not, because nothing called it: a repo-wide
grep found the definition, the re-export in `orchestrator/index.ts`, and two
comments describing a call that did not exist. The breaker was a one-way latch
for the life of the worker. Model load would have been the wrong hook anyway -
the panel disables the Load model button once a model is loaded, so that path is
unreachable by design and a test pinning it would pass while proving nothing.
`runAgentLoop` now calls it at task start.

### Preparing the VLM path

Three things had to change before a vision model could be tested, all of them
found by asking what a VLM run actually needs rather than by it failing.

**`maxEdgePx` was inert for capture.** `downscaleFactor` was written for it,
exported, and never called - so the screenshot went to the server at full
viewport resolution: ~110 KB of base64 and, for a vision model, one to two
thousand image tokens per step. The encoder now shrinks to 768 px.

The ORDER matters and is the reason this belongs in the bake rather than the
capture: redaction is applied at full resolution first and the result is shrunk
for transmission. Shrinking first would move every box relative to the pixels it
covers.

Both bake sites take the same 768, because the Chrome path bakes in the offscreen
document and the Firefox path in the background page - and if the two disagreed,
the image the server receives would depend on which browser the user is running.

**`SEND_SCREENSHOT` was a build constant.** It is now a runtime toggle in the
panel, persisted in `storage.session`. That is a hardware decision as much as a
feature one - an image needs a vision model, which is ~1 GB larger than its
text-only sibling, and on 4.4 GB of free VRAM that is the difference between
fitting and thrashing - so whoever is running the demo should be able to flip it
without a rebuild.

**Text-only stays the default.** A vision model that receives no image is just a
worse text model, and a text model that receives one cannot read it. The toggle
and the configured model have to agree, and only the operator knows which is
loaded.

### The screenshot would have leaked what the text redaction removed

Ticking "send redacted screenshot" produced no `bake` line in the timeline, and
chasing that found something worse than a broken toggle.

The bake was gated on `input.screenshot === true && redaction.pixelOps.length > 0`.
`pixelOps` comes from `pixelOnly()` - detections with `domPath === null` - so
anything found IN THE DOM is fixed in the HTML and produces no pixel op. On a
page whose PII is all text, `pixelOps` is empty and no image was ever sent. The
toggle did nothing on exactly the pages that matter.

**And that gate was accidentally load-bearing.** A screenshot is a picture of the
page as it was captured; a placeholder written into the DOM afterwards does not
repaint those pixels. Measured:

```
profile-pii   7 detections, all 7 with geometry, all 7 DOM-handled, 2 pixel ops
checkout      7 detections,                                          0 pixel ops
login-form    4 detections,                                          0 pixel ops
```

On checkout and login-form NOTHING was covered. Sending the image would have put
the card number, CVV and password in front of the model in pixels while the text
beside them read `[[PII:CREDIT_CARD:1:...]]`. That is precisely the leak this
project exists to prevent, and it was one checkbox away.

`RedactOptions.pixelCoverAll` now blacks out every applied detection that has
geometry, and the step sets it whenever a screenshot is going out. Coverage after:
7, 6 and 4 - the checkout gap of one is a sub-threshold detection that was never
applied to the text either, so the two halves agree.

Blackout rather than blur, deliberately: this is text, and a blur that leaves it
legible is worse than no redaction because it looks like one.

**Written three times before it worked.** The first attempt put the sweep inside
the removals loop and measured as doing nothing - detections are applied in THREE
loops (span edits, attribute and node edits, removals) and text PII goes through
the first. It is now a single pass after all of them, deduped on detectionId so a
vision box that already produced an op is not covered twice. A privacy fix that
silently covers a third of the cases is worse than none, because the number in
the log looks like coverage.

With coverage complete the gate could go: the bake now happens whenever a
screenshot is wanted, which is what the toggle was supposed to mean.

### A timeout tuned for a remote server, applied to a local one

`plan: server: signal timed out` after 24 s. `HttpAgentClient` defaults to 20 s -
sensible for a remote server on a fast link, wrong for a model running on the
same laptop and sharing its GPU with the extension's own. The background now
passes 60 s.

Worth noting what made it slow: the local vision model was loaded (`vision 0
box(es) via webgpu` on step 1) and competing with the VLM for a 6 GB GPU. The
first plan took 3.4 s, the second over 20.

## Offscreen document API surface

- **Offscreen documents can only use `chrome.runtime`.** Found by shipping a
  progress reporter that called `chrome.storage.local.set()` there; it threw
  `Cannot read properties of undefined (reading 'local')`. The docs are explicit:
  "The runtime API is the only extensions API supported by offscreen documents."
  Permissions carry over, the APIs do not. Progress is now relayed to the service
  worker, which persists it.
- **This gets a test, not a comment** (`boundaries.test.ts` -> "offscreen
  document API limits"). It fails at runtime and typechecks perfectly, which is
  the worst combination, and it applies to the real extension as much as to the
  spike.
- **Telemetry is now unconditionally non-throwing.** The failing
  `publishProgress` was called on the error path too, so its own TypeError
  replaced the real load error in the result and cost a run. Instrumentation that
  can fail the thing it instruments is worse than no instrumentation.

## Known measurement, already banked

- **ONNX Runtime Web is 21 MB of wasm plus 868 KB of JS**, before a single model
  weight. Measured while vendoring the spike. Applies to every candidate and is
  the reason runtime size is a first-class axis in the benchmark rather than an
  afterthought. With yolos-tiny fp32 on top, the client pays ~146 MB total.

---

## The screenshot went to the model unredacted

Found in a real Chrome run against `qwen2.5vl:3b`. The panel logged:

```
bake 0 pixel op(s), 58792 bytes
```

Zero pixel ops, and the image was sent anyway. Beside it the text redaction had
stripped five values. Every one of them was still legible in the picture. This is
the precise failure the project exists to prevent, and nothing flagged it — the
line reads like a status update.

**Three separate causes, fixed in three places.**

1. **`pixelOps` only ever covered vision-only detections.** `pixelOnly()` selects
   `domPath === null`, on the reasoning that a value found in the DOM is fixed in
   the HTML. True for the text; silent about the image. `RedactOptions.pixelCoverAll`
   now sweeps every applied detection that has geometry, as a single post-pass
   after all three apply loops — my first attempt put it inside one of the three
   and measured as doing nothing. Coverage on fixtures: profile-pii 2 → 7,
   checkout 0 → 6, login-form 0 → 4.

2. **Real pages had no geometry at all, so the sweep found nothing to sweep.**
   Redaction runs on HTML parsed from a string. A parsed document has no layout,
   so `getBoundingClientRect()` returns zeros and `attributeRectProvider` falls
   back to `data-test-rect` — an attribute only fixtures carry. Every DOM
   detection on a real page therefore had `rect === null`. The fixtures passed
   because the fixtures are the only pages with rects. *A guard that cannot see
   the artifact it guards is not a guard* — the fourth time this project has hit
   that shape.

   The content script now stamps real `getBoundingClientRect()` values onto a
   **clone** of the document before serialising. A clone because writing
   `data-test-rect` into the live DOM would be an unrequested side effect on the
   user's page, visible to the site.

3. **Nothing refused.** `step.ts` now declines to send an image when redactions
   were applied to the text but zero pixel ops were produced, and emits a `bake`
   error saying so. The step still completes and still plans — refusing costs
   the model its eyes, not the user their step.

   > Refusing is the safe direction: a model that gets text only is a weaker
   > agent, and a model that gets an unredacted screenshot is the thing this
   > project exists to prevent.

Guarded by `tests/redaction/screenshot-leak.test.ts` (7 tests, including the
no-geometry case asserting zero ops rather than false confidence) and four tests
in `tests/orchestrator/step.test.ts`. The backstop tests were verified to fail
with the condition stubbed to `false`.

## A failed forward pass must not cost the redacted screenshot

Same run, step 2:

```
bake offscreen "bake" failed: bake: no retained frame for frameId
"cap-1788033114428-2". It was never detected, or it has been evicted (retaining 4).
```

`LocalWorkerRuntime.detect` retained the decoded frame **only after a successful
forward pass**, under a comment arguing that "a frame that failed inference is
not a frame anyone should be able to bake against". That was written before
vision failure became survivable, and it is backwards: baking applies pixel ops
to a decoded image and has nothing to do with the model.

So when the vision circuit breaker did its job — degrade, carry on — the frame
was never retained, `bake` failed, and the whole step failed. The fallback path
destroyed the thing it was protecting.

The frame is now retained immediately after decode, and deliberately **after**
the natural-size check: a frame whose decoded dimensions disagree with the
capture would misplace pixel ops exactly as it would misplace boxes. Decode
failure and size mismatch still leave nothing to bake, and both are asserted.

Pinned by four tests in `tests/perception/worker-runtime.test.ts`. Reverting the
retain to its old position reproduces the user's error string character for
character, down to `(retaining 4)`.


---

## The degradation path ate the step it was protecting

A four-step Chrome run against `qwen2.5vl:3b` ended:

```
step 4: detect vision skipped after 3 consecutive failures
        bake offscreen "bake" failed: bake: no retained frame for frameId
          "cap-1788036284814-4". It was never detected, or it has been evicted.
loop stopped after 4 step(s): error
```

Three faults in one line, each of which alone would have been survivable.

**1. Retention was a side effect of inference.** The decoded frame entered
`#frames` only inside `LocalWorkerRuntime.detect`. Retaining it *before* the
forward pass (logged above) fixed the case where detect RAN and failed. It could
not fix this one, where the breaker skips detect entirely and the frame never
reaches the worker at all. `retain` is now a first-class worker command, and
`#accept` is the single implementation of "decode, validate, hold" that both
paths share. Gated on `input.screenshot === true`: retained frames are decoded
and UNREDACTED, and a text-only run has no business putting one in the worker.

Worth stating plainly: the screenshot fixes made this **more** likely, not less.
Once DOM detections carry geometry, `pixelCoverAll` produces non-zero pixel ops,
so the uncovered-redaction backstop no longer suppresses the bake — meaning bake
now gets attempted on exactly the path where no frame exists.

**2. A failed bake killed the task.** This file already argues twice that vision
should degrade rather than abort, and that "no image" is the safe direction. It
never applied that to the stage which CONSUMES the degraded one, so the throw
reached the outer catch and stopped the loop. A bake failure now costs the image
and nothing else. The class is wider than the instance that exposed it: offscreen
teardown between redact and bake, an encode failure, or `bake` refusing when no
model is loaded were all fatal to a task that could still be planned from text.

Three distinct reasons an image can be missing, three distinct messages — the
panel has to be able to say which one fired.

**3. The breaker had no way back.** Covered above; it was dead code.

**A latent version of the same bug was in the test suite.** The breaker is
module-level and nothing ever reset it, so `step.test.ts` — which trips it twice
— sat at 2 of 3. A third failing-detect test anywhere in the file would have
pushed every later test onto the vision-skipped path, where they would still pass
while asserting nothing about the code they name. Both orchestrator test files
now reset it in `beforeEach`.

Twelve new tests. All three fixes were verified to fail against the pre-fix code:
reverting the bake try/catch and the task-start reset fails 4; removing the
`retain` call fails 2 with `expected [ 'bake', 'release' ] to include 'retain'`.

### Found by a 36-agent triage, and worth recording how

Four parallel investigations (retained-frame, infer-timeout, latency,
planner-goal), each finding adversarially verified by an independent agent
instructed to refute it. 19 of the findings survived; the refuted ones included
plausible-sounding fixes that would have broken the build. The synthesis flagged
seven conflicts between proposed fixes, of which two changed the plan:

- Ranks 1 and 2 are **both** required. Rank 1 alone converts a hard stop into a
  permanent silent loss of the screenshot — every later step degrades quietly
  while the loop reports ok. Rank 2 alone leaves every other bake failure fatal.
- Making vision opt-in (a real latency win) is **downstream** of the `retain`
  command, not an alternative to it. With vision off, `detect` never runs, so
  `retain` becomes the only retention path in the product. Landing it first would
  have silently disabled the screenshot everywhere.

---

## `bake 0 pixel op(s)` meant two opposite things

Every step of a five-step run logged `bake 0 pixel op(s)` beside
`redaction 15 applied`. The obvious reading is the alarming one: fifteen values
stripped from the text, none covered in the image.

It was the other one. Reproduced by running the actual page through the
pipeline:

```
pixelOps=15 onScreen=0 APPLIED=0 skipped=15
image=1920x1080
reasons: ["rect is empty after clamping to the frame"]
sample rects: [6595, 7195, 8095]
```

Those y-coordinates are 6–8 thousand pixels down a 1080-pixel-tall frame. **A
screenshot shows the viewport; the DOM scan reads the whole document.** The PII
on that page sits below the fold, so it was redacted in the text and was never in
the picture. Zero pixel ops applied is correct, and nothing was exposed.

The problem is that the dangerous case produces a byte-identical line. Ops
covering PII that IS on screen, failing to land, would also print
`bake 0 pixel op(s)` — and that is a redaction that was supposed to happen and
did not. One number, two opposite meanings, and the distinction is the only
thing worth knowing about a screenshot.

`applyPixelOps` now counts an op whose rect lies entirely outside the frame
separately from one that overlapped and failed. `opsRequested` and
`opsOutsideFrame` travel with `opsApplied` through `BakedScreenshot`,
`BrowserBakeResult` and the `bake/done` event, and the panel prints
`9/15 pixel op(s), 3 off-screen` instead of `9 pixel op(s)`.

The guard follows from the split. Nothing is owed for an op that was never in
frame; every op that overlapped the frame must land:

```ts
const shouldHaveLanded = baked.opsRequested - baked.opsOutsideFrame;
if (shouldHaveLanded > baked.opsApplied) { /* refuse, text-only */ }
```

This is the third distinct reason the step can decline to send an image, and each
now says which one fired: uncovered redactions before baking, no retained frame,
and ops that should have landed and did not.

**On the earlier claim.** Two messages ago I read `bake 0 pixel op(s)` as an
unredacted screenshot reaching the model. On the stale build that was right — the
pre-backstop code baked whatever it had. On the current build the number means
what is described here, and the run in question was on the current build.

### Also confirmed by this run

- **The `retain` fix works.** Step 4 skipped `detect` after three failures and
  still baked. The identical step crashed the previous run with `no retained
  frame`. Steps 4 and 5 took 1798 ms and 1813 ms against 42 s for steps 1–3,
  because the skipped path no longer pays three 4-second timeouts.
- **The loop completes.** `loop stopped after 5 step(s): done`, twice. The test
  lab recorded real multi-step progress: search submitted, `Laptop Pro` added to
  cart, country changed to India, navigation to Checkout and Profile. The earlier
  complaint that the extension "only does one thing" no longer holds.
- **Vision still contributes nothing and costs ~40 s of every 43 s step.**
  `infer exceeded 4000 ms` on every attempt, 0 boxes, while Ollama holds 2.9 GB
  of a 6 GB GPU. Making the detect stage opt-in remains the largest single
  latency recovery available, and must land after the `retain` command.

---

## The panel now distinguishes safe from unsafe, and the run says safe

First timeline with the split counts:

```
bake 6/15 pixel op(s), 9 off-screen
bake 0/15 pixel op(s), 15 off-screen
bake 8/15 pixel op(s), 7 off-screen
```

Every one satisfies `opsRequested - opsOutsideFrame == opsApplied`: 6 owed and 6
applied, 0 owed and 0 applied, 8 owed and 8 applied. Every pixel op that
overlapped the captured frame landed. The screenshots were covered, and the same
line that used to read `bake 0 pixel op(s)` now shows why.

Also confirmed: `vision 0 box(es) via webgpu` on one step — the local model ran
for real, through this code path, on a real page, and returned zero boxes in a
step that took 8.9 s against 42 s for its neighbours.

## `type` at a button

Four steps in one run logged `action type failed`, and the run ended
`no-progress`. The action was:

```json
{"type":"type","ref":"e41","text":"Submit Review","submit":true}
```

"Submit Review" is the accessible name of a BUTTON. The model had picked the
right element and the wrong verb — it read `type` as "make this text happen"
rather than "put this text in a field".

`validateAction` had no role information, so it passed the action through; the
content script then refused it with `holds no value` (`execution/actions.ts:70`).
The role was in the context we SENT. Discovering the problem in the page costs a
capture, a redaction, a plan and a round trip — about 43 seconds — to learn
something that was knowable before the request left the machine.

`ValidationContext` now carries `typeableRefs`, built in `validationContextFor`
from the roles already on `ctx.elements` (`textbox`, `searchbox`, `combobox`,
`spinbutton` — matching what `asValueElement` accepts). The `type` case refuses
anything else with a new `not-typeable` code. The ref-exists check still runs
first: an unknown ref means the server named something we never exposed, which is
the more serious finding and must not be masked.

Prompt rule 6 states the constraint too, so the model has a chance to comply
rather than only being refused.

## Vision is off by default

Measured, not preferred:

| | vision on | vision skipped |
|---|---|---|
| Step wall clock | 42-44 s | **1.8 s** |
| Boxes returned | 0 | 0 |

Three `infer exceeded 4000 ms` per session on a GPU where Ollama holds 2.9 GB of
6 GB. And even with a free GPU the ceiling is low: `Xenova/yolos-tiny` emits COCO
classes, of which `labelToPiiKind` uses essentially one, so `signature`,
`id-document` and `credit-card` are unreachable through vision. Every detection
in these runs came from `scanDom`.

Default-off rather than removed. The architecture requires a local vision model,
`bench.ts` exists to choose a better one, and the toggle is how that comparison
gets run. The panel labels it with the measurement rather than as a feature.

**Ordering mattered and was nearly wrong.** With vision off, `detect` never runs,
so the `retain` command is the ONLY path that puts a frame in the worker.
Landing this toggle before that command would have silently disabled every
screenshot — the synthesis flagged it as a precondition, not an alternative.

---

## The vision model is the wrong model, and the measurements are brutal

Thirty agents researched a replacement for `Xenova/yolos-tiny`. They did not take
model cards on faith: they downloaded candidates and ran them in the shipped
runtime (onnxruntime-web 1.22.0-dev, wasm EP, `numThreads=1` as pinned in
`transformers-env.ts`).

| | yolos-tiny | YuNet |
|---|---|---|
| Forward pass p50 | **1765.8 ms** | **36.5 ms** |
| Weights | 26,227,993 B | **232,589 B** |
| Frame blacked out | 21.02% | 8.40% |
| Detects | COCO `person` | `face` |

**The incumbent is disqualified by this project's own budget.** `DEFAULT_BUDGETS`
in `bench.ts` sets a 1500 ms hard limit; at 1765.8 ms yolos-tiny scores **0.0 on
metric 5** today. It is not merely weak, it fails the rubric already written down.

The over-redaction number is the metric-3 argument: COCO `person` boxes a whole
BODY, so redacting it blacks out 2.5x more of the frame than a face detector does.
Crudeness that looked harmless costs precision, which is 20% of the score.

At 232 KB and 36 ms, YuNet also **retires the GPU-contention problem outright**
rather than mitigating it - it does not need WebGPU at all, so Ollama holding
2.9 GB of a 6 GB card stops mattering.

### What the swap does NOT fix

`signature`, `id-document` and `credit-card` stay unreachable through vision.
That is not a regression - COCO contains none of them either, so yolos-tiny
reached none of them. It must stay a written gap rather than be quietly closed by
a model swap.

### The highest-value change was not a model at all

`IMG_VISUAL_RULES` (`dom-scan.ts`) had exactly three entries - id-document,
signature, face - and **no credit-card**, while the TEXT rules have had one all
along. So `<img alt="photo of my debit card">` produced a detection from neither
channel: no number to match in text, and no model on any hub that finds a credit
card in pixels at this budget.

One regex closes it, at zero bytes and zero milliseconds. Landed, deliberately
narrow: `\bcard\b` alone would take "business card", "gift card", "loyalty card"
and "card sorting", and bare "visa" is a travel document more often than a
payment card. Seven benign controls assert it does not fire on those.

Verified by neutralising the regex: 2 of the 4 tests fail, and the two precision
controls correctly keep passing.

### The footgun, recorded before it bites

YuNet wants **BGR CHW at raw 0-255**, no normalisation. Feeding RGB throws
nothing, logs nothing, and returns confident-looking boxes - a measured A/B gave
130 faces for BGR against 36 for RGB, a silent 72% recall loss with the top score
still reading 0.913. The existing path cannot be reused: `transformers-env.ts`
calls `.rgb()`.

This is the seventh time this project has met an instrument reporting a confident
number for something it was not measuring. It belongs in a comment at the
conversion site.

### Why bench.ts cannot settle this yet

`scoreFixture` takes the engine's detections and immediately discards them
(`void visionDetections` in `bench-runner.ts`), rescoring from the fixture's
recorded `*.vision.json` - so every candidate gets identical metric 1/2/3 numbers.
And `makeEngine` builds a `StubPerceptionEngine` reporting `weightBytes: 0`, so
`normaliseCost` returns a free 1.0 for everything. Ranking today is decided
purely by latency and heap.

Worse, the fixtures cannot answer it either: four of the five `*.vision.json`
files are literally `[]`, and `profile-pii` - the only one with images - labels
them with honest alt text that `IMG_VISUAL_RULES` catches by regex without any
model. **A sixth fixture is required before any model claim here is falsifiable**:
an unlabelled photograph (`<img src="IMG_2024.jpg">`, no alt, no title, no class)
plus a benign non-face image as a precision control.

That is the real prerequisite, and it is why the swap is not a one-line change.

---

## YuNet replaces yolos-tiny

Built. The package went from **60.01 MB to 33.54 MB** and the weights from
26,227,993 bytes to **232,589**.

### The measurement was reproduced before anything was built on it

The workflow's file was still on disk. Verified independently: 232,589 bytes,
SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`, and
the hub URL serves exactly that. A real session confirmed the IO the decoder
depends on: one input, twelve outputs, `cls/obj/bbox/kps` at strides 8/16/32 with
6400/1600/400 anchors.

Then the decoder was validated end to end against a real photograph:

```
BGR (correct): 66 faces, top 0.918/0.898/0.878, warm p50 30.3 ms
RGB (wrong)  : 11 faces, top 0.907/0.887/0.849
```

**The BGR footgun is real and I reproduced it.** 83% of detections lost, and the
top score moves from 0.918 to 0.907 - a change no one would notice. Nothing
throws. This is the seventh instance in this project of an instrument reporting a
confident number for something it was not measuring, so it is pinned by a test
and commented at the conversion site rather than recorded in a commit message.

### What was built

- `yunet-decode.ts` - pure, no ORT import. Transcribed from OpenCV's own
  `face_detect.cpp`, not reimplemented from a paper. 13 tests, every value
  computable on paper. The one most worth having asserts the grid column comes
  from the FEATURE MAP width, not the input width - getting that wrong puts every
  box in the first row and they still look like boxes.
- `yunet-backend.ts` - implements `InferenceBackend` with the ORT session
  injected, so all 12 tests run in Node with no ORT at all. Refuses a wrong-sized
  input, a missing output, and a non-float tensor, each by name.
- `unlabelled-media` fixture - the sixth, and the only one where a model swap can
  change a score.
- `bench-runner.ts` now scores the candidate's OWN detections.

### The benchmark could not previously tell two models apart

`scoreFixture` did `void visionDetections` and rescored from the fixture's
recorded `*.vision.json`. Proven, not asserted - reverting the fix gives:

```
expected 1 to be greater than 1     (working detector vs blind one)
expected 1 to be less than 1        (blind model on a face-only page)
```

**A model that detects nothing scored a perfect 1.000.** Every other fixture
labels its images with honest alt text that `IMG_VISUAL_RULES` matches by regex,
and four of five recorded vision files are `[]`, so the swap was unfalsifiable on
the existing suite. `unlabelled-media` carries an unlabelled photograph plus a
bar chart, a logo and a Luhn-invalid card-shaped number as precision controls.

### Constraints held

`background.js` contains zero occurrences of `onnxruntime`, `ort-wasm` or
`InferenceSession`; ORT lives only in the offscreen chunk. The import stayed
dynamic and uses the BARE specifier - the `onnxruntime-web/wasm` subpath
hardcodes the non-jsep glue and would silently forfeit WebGPU.

`onnxruntime-web` ships types its own `exports` map makes unreachable, so
`src/types/onnxruntime-web.d.ts` declares it as `unknown` rather than `any`:
`any` would disable checking at every use site, `unknown` forces the single
existing cast to stay explicit while the real contract lives in the hand-written
`OrtModule`.

### Still true, and still written down

- **Faces only.** `signature`, `id-document` and `credit-card` remain unreachable
  through vision. Not a regression - COCO contains none of them either.
- **Never run in a browser.** Every number here is Node with the shipped ORT
  build and wasm EP, `numThreads=1`. The candidate row says `expected`, not
  `verified`, and stays that way until an offscreen document runs it.
- **`bench.ts` still gives every candidate a free 1.0 on cost**, because
  `makeEngine` builds a `StubPerceptionEngine` reporting `weightBytes: 0`. The
  quality half now discriminates; the resource half does not.

---

## First browser run of YuNet, and a regression I caused

```
capture 77761 bytes in 20.0 ms
vision 0 box(es) via webgpu
bake 3/15 pixel op(s), 12 off-screen
qwen2.5vl:3b type in 1939 ms
step 1 ok in 2042 ms wall clock
```

**2042 ms per step, against 42,000 ms.** Vision ran on WebGPU and did not time
out - the 4000 ms limit that fired on every attempt with yolos-tiny was never
approached. The Node measurement transferred to the browser.

`bake 3/15, 12 off-screen` balances: 3 owed, 3 applied.

`vision 0 box(es)` is expected on that page - a shopping test lab has no faces -
but it is NOT yet evidence the model works. Zero on a page with no faces and zero
from a silent BGR fault are the same line. **The outstanding verification is one
run on a page with a visible face.**

### The regression

```
step 2 failed in 1966 ms
loop stopped after 2 step(s): error - validate: refused action: not-typeable
```

The `not-typeable` check was added so a wrong verb would be caught before the
request left, instead of being discovered in the page 43 seconds later. Then the
refusal called `fail()`, which ends the step and stops the loop - so catching the
mistake was strictly worse than letting it through. The model corrects this
readily when told; it never got the chance.

### The fix is a distinction, not a blanket

Degrading every refusal would have weakened two security tests that exist for
good reason - a hostile server naming a ref we never exposed, and a navigate
outside the granted origin. Those are not mistakes to retry.

`CORRECTABLE_REFUSALS` = `not-typeable`, `text-too-long`, `scroll-too-far`,
`wait-too-long`. Mistakes about OUR schema, made by a model doing its job: the
step succeeds, the reason goes into history, and the next plan can fix it -
`not-typeable` even says what to do instead ("use click for buttons and links").

Everything else - `unknown-ref`, `origin-not-allowed`, `sensitive-target`,
`bad-url` - still ends the task. CLAUDE.md calls the ref allowlist the runtime
backstop against a fully compromised server; giving such a server another turn is
the opposite of a backstop.

Both halves are pinned, and forcing every refusal fatal again fails 3 tests while
the security cases keep passing unchanged.

---

## YuNet verified against real weights, and the loop's second navigation bug

`test-site/verify-vision.ts` is the first real forward pass through
`YunetBackend` anywhere in the project - every test under `tests/perception/`
injects a fake session and a zero-filled buffer, so nothing else had ever loaded
the actual 232,589 bytes.

```
PASS  portrait-a.png        faces=1 (want 1)  top=0.921   53 ms
PASS  portrait-b.png        faces=1 (want 1)  top=0.917   35 ms
PASS  portrait-c.png        faces=1 (want 1)  top=0.926   32 ms
PASS  labelled-portrait.png faces=1 (want 1)  top=0.919   33 ms
PASS  landscape.png         faces=0 (want 0)              33 ms
PASS  chart.png             faces=0 (want 0)              33 ms
PASS  id-card-scan.png      faces=0 (want 0)              33 ms
PASS  signature-sample.png  faces=0 (want 0)              32 ms

1920x1080 @ 220px tiles (~73px in model space)  faces=4/4  top=0.911
```

Every planted face, no control. That closes the question the browser run left
open: `vision 0 box(es)` on the shop page was correct, because the page had no
faces in it. The BGR order, the stride decode and the weights are all right.

The faces are RENDERED, not photographs of real people - `make-images.mjs` draws
them procedurally, so the suite works offline and ships no one's likeness.

### The loop navigates itself out of its own content script

```
step 1 ok in 8382 ms
panel page navigated - access retained via http://localhost:8080
snapshot Could not establish connection. Receiving end does not exist.
loop stopped after 2 step(s): error
```

`ensureContentScript` ran once, before the first step. Step 1 clicked a link, the
document was replaced, and the new one has no content script.

This is the injection twin of a problem CLAUDE.md already describes: *the loop's
own clicks navigate, and each navigation revokes the access the next step needs.*
There the casualty was the permission. Here it is the script - and the permission
survived, which the same run says on the line above the failure.

`contentRequest` now re-injects and retries ONCE, and only on "nobody is
listening". A content script that ran and returned an error is reported as-is:
re-sending `execute` after a real failure could perform the action twice.

### Images on the shop page, chosen so the result is falsifiable

Product photos are face-detector CONTROLS - a search for "laptop" must surface
them and produce zero boxes. The headphones are deliberately adversarial: two
dark ellipses over a curve is the closest thing a product catalogue contains to a
face. All four measure faces=0.

The reviewer pictures are the opposite. Their alt text reads "Verified buyer",
which matches none of the `IMG_VISUAL_RULES` patterns, so the DOM scan cannot
tell there is a person in them. **A face reported on a laptop search therefore
came from the model and from nowhere else** - which is the whole point of putting
them there. The profile avatar keeps `alt="Profile photo"` so both channels fire
and the merge can be watched corroborating.

---

## History has been lying about which element it touched

Found while designing a context budget; present long before it, and unrelated to
the 400 that started the investigation.

Refs are POSITIONAL ORDINALS. `extractElements` numbers interesting elements in
document order from a counter that restarts every step, so a ref identifies an
element only within the step that minted it.

`renderPrompt` rendered each history line by looking the OLD ref up in the
CURRENT element list:

```ts
const el = ctx.elements.find((e) => String(e.ref) === ref);
```

Correct exactly until the page changes - and the ordinary case changes it. In the
failing run a search inserted two results, the element count went 63 -> 69, and
every ordinal after the insertion point shifted. The history line then carried a
truthful ref beside the name of a **different element**, with nothing to indicate
it. `step 1: click e4 ("Laptop Pro")` when step 1 clicked Profile.

`ExecutedStep` now carries `name`, captured at execution from the context that
was actually sent. `renderPrompt` resolves no refs at all, which is also what
makes a budget safe: an element missing from ELEMENTS can no longer orphan the
history line that mentions it. Required rather than optional, because an optional
field lets a new call site quietly reintroduce the lookup.

Three tests, all failing against the old lookup.

## The context budget, and the trap in it

69 elements plus a screenshot produced `request (4139 tokens) exceeds the
available context size (4096 tokens)`. Nothing bounded the payload: the only
limit was `MAX_REQUEST_BYTES` at 2 MB, which the failing request used 3% of.

**The dangerous fix is to compact the list.** `extractRefPaths` walks the
unfiltered document, so a compacted `e17` names one element to the model and
resolves to a different one in the page - validated, executed, reported ok, and
wrong. Dropping rows while each survivor keeps its original ordinal makes the
worst case "absent", which is visible.

`applyElementBudget` sheds cheapest-harm-first: names capped always, geometry
dropped when there is no image to correlate it against, then elements by
ascending rank, never below `minElements`. Ranking is role tier, plus goal
affinity (the same signal the planner scores on, so the budget keeps what the
planner would have reached for), plus on-screen, with document order as the final
tie-break - which makes the kept set identical across steps on an unchanged page.

The load-bearing test asserts the survivors are `[e1..e4, e6..e10]` and not
`[e1..e9]`. My first version of it asserted only that every kept ref existed in
the input, which **passes against the compacting bug** - e1..e9 all exist in
e1..e10. Only the literal expected list catches it.

Two more things the design turned up and the code now bounds:

- `accessibleName` takes `aria-label` verbatim and the only prior bound was
  `MAX_ATOM_CHARS` at 512. A page that pads its own labels can drive names to
  most of the prompt: a deterministic, page-controlled way to exhaust the context
  window. Page content is attacker-controlled by this project's own rule, so an
  unbounded page-derived quantity in the prompt was not acceptable regardless of
  the 400. Capped at 96 chars against a longest observed name of 23.
- `context/sent` reported `bytes` as `JSON.stringify(context).length`, folding
  the base64 screenshot in with the text - so nobody could see which half grew.
  `imageBytes` is now split out.

The panel prints `61 of 69 element(s) - dropped 8 (e62, e63, ...), ~2891/3400
tok, geometry omitted` as a `warn`, not an `info`. A step that succeeded while
doing less than asked must not read as routine.

**The server-side fix is a stopgap and is recorded as one.** `qwen2.5vl:3b`
reports a 128k context; 4096 is Ollama's default `num_ctx`. A `qwen2.5vl-8k`
variant unblocks this machine today, and the OpenAI-compatible body has no field
to set it - so it is a deployment change. The extension has to work against
endpoints it does not control, which is why the budget exists at all. 8192 rather
than 16384 deliberately: 16k left 472 MiB of a 6 GB card, and YuNet needs GPU
room on the same card.

---

## The budget I shipped was worse than the bug it fixed

```
sent 8 of 63 element(s) - dropped 55 (e1, e2, e5, e6, e8, e9, ...),
  ~27506/3400 tok, geometry omitted, 57708 bytes (53132 image)
```

**Base64 image bytes were being counted as text tokens.** 53,132 bytes divided by
a 2.0 bytes-per-token TEXT ratio valued one screenshot at ~26,500 tokens. A
vision model tokenises an image as PATCHES; its base64 length has nothing to do
with the cost. The real figure is about 1,200.

So the budget believed it was eight times over, shed 55 of 63 elements to its
floor, and still reported `27506/3400`. It made the agent nearly blind while
fixing nothing - strictly worse than the overflow it existed to prevent. The task
completed anyway, which is the part worth noticing: a run can succeed while the
mechanism under it is badly wrong.

With correct accounting the same page is ~3000 tokens and **nothing should have
been dropped at all**.

Three fixes:

- `imageTokens` is a flat policy reserve, not a byte division. Text is still
  estimated from bytes; the two are no longer mixed.
- The screenshot is now dropped BEFORE any element, which the escalation was
  always specified to do and which I had left as a hardcoded
  `screenshotDropped: false`. An image is ~1200 tokens and an element is ~15:
  dropping the picture buys back what eighty elements would, and the benchmark
  measured screenshot-on and screenshot-off scoring identically.
- The estimate is computed in tokens throughout, so a report can no longer say
  `27506/3400` after exhausting every lever.

Four tests. The one that matters asserts a realistic 63-element page with a
screenshot drops NOTHING and keeps the picture. My first version of it passed
against the bug, because the newly-added screenshot escalation made the page
"fit" by silently throwing the image away - technically zero elements dropped,
and a total loss of the vision half. Asserting `screenshotDropped === false` is
what catches it.

**A note on the default.** `maxPromptTokens: 3400` targets Ollama's default 4096
window. On this machine the server is now `qwen2.5vl-8k`, where the same page
needs no shedding at all - a test pins that at 7000. The safe default costs
geometry on a large page and says so in the panel. Making it settable per-server
is the honest next step; discovering it from the endpoint is not possible through
the OpenAI-compatible body.

---

## The budget is right, and the model still could not read a rule

```
sent 63 element(s), ~2340/3400 tok, geometry omitted
```

63 of 63 elements, nothing dropped, and the screenshot kept. The token
accounting is fixed. Geometry is still shed because 63 rows with boxes plus an
image is ~3809 tokens against a default sized for Ollama's 4096 window - correct
behaviour, and unnecessary on the 8k server actually running.

The remaining failure was different:

```
step 3: qwen2.5vl-8k type in 1953 ms
        validate refused action: not-typeable (ref "e20" is not a text field...)
step 4: identical action, identical refusal
loop stopped after 4 step(s): no-progress
```

The refusal degradation worked exactly as designed - the step completed, the loop
continued, the repeat guard stopped it after two. So the mechanism was right and
the model was not learning.

**The history was not the problem.** Rendering the real prompt shows:

```
HISTORY
step 2: type e20 ("Add to Cart") FAILED - refused action: not-typeable
        (ref "e20" is not a text field; use click for buttons and links)
```

That is as clear as prose gets, and a 3B model repeated the action anyway.

So the fix is not more prose. Rule 6 required the model to classify `role=`
itself and apply a rule stated elsewhere in the prompt. `SENSITIVE` already
demonstrates the cheaper shape - put the affordance on the element - so text
fields now render `TYPEABLE` and rule 6 points at the marker instead of at a role
list.

Derived from the SAME `TYPEABLE_ROLES` set `validationContextFor` uses, moved
into `contracts` for that reason. A marker that could disagree with the refusal
would punish the model for following the instructions it was given, and a test
asserts they match element for element.

Cost: a handful of rows on a typical page, so a few dozen bytes.

**What this does not do** is guarantee the model gets it right. It removes one
inference step from a task the model was measurably failing. Whether that is
enough is a question for the next run, not something to claim here.

---

## Two prompt fixes were written, tested, built, and never served

The TYPEABLE marker changed nothing, because it was never running:

```
$ grep -c TYPEABLE .output/chrome-mv3/background.js
0
```

**`renderPrompt` runs on the SERVER.** It is not in the extension bundle at all.
Both the history-name fix and the TYPEABLE marker were written, unit-tested,
built into the extension, and then evaluated against a server process that had
been running since before either change. `server/main.ts` runs from source
through tsx, so a restart was all that was ever needed - and a restart is not
part of `npm run build`.

What makes this worth writing down is how it looked from outside: the next run
was byte-for-byte the same failure, twice, and the natural reading each time was
that the fix had not worked. It had. Nothing was executing it. That is the same
shape as every other failure in this file - an instrument reporting confidently
about something it was not measuring - except the instrument here was the whole
test loop.

`/health` now carries a fingerprint of the static prompt rules:

```json
{"ok":true,"planner":"qwen2.5vl-8k","prompt":"07a8a8ac"}
```

The same function is exported from source, so "is the server running the prompt I
just wrote" is one comparison instead of an inference from behaviour. Verified:
source `07a8a8ac`, server `07a8a8ac`.

`INSTRUCTIONS` moved to module scope for it, which also separates the static
rules from `renderRedactionScheme(ctx)` - the one part of the preamble that
depends on the page, because it carries the session nonce.

### The model's reasoning was never the problem

Worth recording, because two rounds were spent treating it as a prompt-quality
issue:

```
step 1: type e7 "laptop pro"  submit:false   -> ok
step 2: type e14                             -> refused, not-typeable
step 3: type e14                             -> refused, not-typeable
```

It typed the query WITHOUT submitting, then went to press the Search button - and
reached for it with `type` instead of `click`. The element choice is right and
the plan is coherent. Only the verb is wrong, which is exactly what the marker
and rule 6 address, and exactly what had not been served.

---

## The model was never going to read another rule

Three rounds were spent improving prompt wording. This is what finally settled
it - asking the real model, at temperature 0, with the real page:

```
{"type":"type","ref":"e14","text":"Add Laptop Pro to cart","submit":true}
```

`e14` is `role=button name="Add Laptop Pro to cart"` - the RIGHT element, and the
goal exactly. The model is treating `type` as "activate the thing named X" and
putting the button's own label in the text field. Deterministic, reproducible,
and unchanged by the TYPEABLE marker sitting in front of it.

Every link had been verified first, which is what made the conclusion safe:

- `e20` in the failing run is `e14` shifted by the six elements the search
  results insert - "Add Laptop Pro to cart", confirmed by enumerating the real
  page through the real pipeline.
- The marker renders: 9 TYPEABLE rows on that page, and `e14` correctly has none.
- SHAPES lists `click` first, so nothing biases toward `type`.
- The server was running the prompt in question (fingerprint matched).

Then the experiment worth running: the SAME prompt plus a short CORRECTION block
naming the mistake.

```
{"type":"click","ref":"e14"}
```

First try, both phrasings tested.

### What was built

`PlanRequest.correction` - a first-class field, rendered LAST in the prompt,
after the element list. Deliberately not another history line: history is exactly
what the model had been ignoring, and a correction buried above 63 element rows
is a history line by another name.

`step.ts` re-plans ONCE on a correctable refusal, re-parses, re-validates, and
executes the corrected action. Bounded at one - a model that will not take the
correction will not take it on the third attempt, and an unbounded retry hands a
hostile server unlimited attempts at the ref allowlist. Security refusals
(`unknown-ref`, `origin-not-allowed`) are never re-planned, for the same reason
they end the task.

The correction carries a ref, an action type and a ROLE - all of them ours. The
element's NAME is page-authored and deliberately absent, because the correction
lands in the prompt's instruction region.

Five tests, plus an end-to-end run through the real server:

```
FIRST::  {"type":"type","ref":"e14","text":"Add Laptop Pro to cart","submit":true}
AFTER::  {"type":"click","ref":"e14"}
```

### The lesson worth keeping

Three rounds of prompt edits were shipped against a model that had never been
asked directly what it would do. One request to `/v1/chat/completions` with the
actual prompt would have shown, at any point, that the wording was not the
problem. Measure the model the way this project measures everything else.

### Confirmed in the browser

```
step 3: qwen2.5vl-8k type in 1900 ms
        validate re-planning once: not-typeable at e20
        validate correction accepted: click
        action click ok
step 4: done
loop stopped after 4 step(s): done
```

The refusal, the re-plan and the corrected action all fired in one step, and the
task finished. Four steps, 2.2-3.7 s each, against the 42 s steps of two weeks of
notes above.

Worth stating precisely: `done` is the MODEL reporting completion, not the page
confirming it. The test lab's own console is the independent check on whether the
cart actually changed, and it is a separate observation from this line.

---

## The context budget is a setting, because it belongs to the server

`geometry omitted` appeared on every step of an otherwise clean run. Not a fault:
63 element rows with `box=` plus a screenshot is ~3809 tokens against a default
sized for Ollama's stock 4096. The escalation shed the cheapest thing and carried
on, exactly as designed.

But the machine was running `qwen2.5vl-8k`, where nothing needed shedding at all.
The default was costing `box=` coordinates - the model's only means of tying a
region of the screenshot to a ref, and therefore a direct cost against metric 1
(visual context, 25%) - for no reason.

**It cannot be discovered.** The OpenAI-compatible request body has no field that
reports the context window, and the model's own `context_length` (128k for
qwen2.5vl) is not what Ollama actually serves. So it is neither safe to hardcode
to one deployment nor possible to detect: it is a property of the endpoint, which
makes it a setting.

`Context budget (tokens)` in the panel, persisted in `storage.session` beside the
screenshot and vision toggles, clamped to 1200-120000 in the BACKGROUND rather
than in the input. The floor is scaffolding plus `minElements` - below it every
step would refuse and the panel would blame the server. The ceiling exists so a
typo cannot reintroduce the context-overflow 400 the budget was built to prevent.

`PanelState.tokenBudget` holds what the last step actually ran under, so the field
shows the value in force rather than a hardcoded default. A field reading 3400
while steps ran at 7000 would make `geometry omitted` look inexplicable.

Default unchanged at 3400. It is the value that works against an endpoint nobody
has configured, which is the only sane default for something that ships.

---

## The model reads the end of the prompt

The budget setting landed and the run got further than ever - geometry back at
`~4557/7000`, the correction firing reliably - and then stopped on a new
condition:

```
step 3: re-planning once: not-typeable at e20 -> correction accepted: click -> ok
step 4: re-planning once: not-typeable at e20 -> correction accepted: click -> ok
step 5: re-planning once: not-typeable at e17 -> correction accepted: click -> ok
loop stopped after 5 step(s): repeating - planned {"type":"click","ref":"e20"} 3 times
```

It clicked Add to Cart three times. The repeat guard did its job; the model did
not.

Asked directly, with history stating the job was done:

```
history: step 1: click e14 ("Add Laptop Pro to cart") ok
         step 2: click e14 ("Add Laptop Pro to cart") ok
reply:   {"type":"type","ref":"e14","text":"Add Laptop Pro to cart","submit":true}
```

Twice over, and still the same action. The obvious conclusion is that the model
ignores history.

**It does not. It ignores the MIDDLE of the prompt.** The identical text, moved
below the 69 element rows:

```
{"type":"done","summary":"Laptop Pro added to cart."}
```

That also explains, retroactively, why the CORRECTION block worked when a history
line carrying the same information did not - the correction was placed last, and
I attributed its success to being a distinct channel rather than to where it sat.
It was position all along.

So `HISTORY` is now `ALREADY DONE`, rendered AFTER the element data with a single
line telling the model what to do about it, and the correction stays last after
that. Everything the model must ACT on lives at the end; the rules, the schema and
the redaction scheme stay at the top, where being read once is enough.

Verified through the running server:

```
FRESH::        {"type":"type","ref":"e14","text":"Add Laptop Pro to cart","submit":true}
AFTER-CLICK::  {"type":"done","summary":"Laptop Pro added to cart."}
```

The prompt fingerprint moved 07a8a8ac -> 676c73a2, which is the staleness guard
earning its place two changes after it was added.

**The general lesson, third time in this file.** Content was correct and position
was wrong, and the failure looked exactly like the model being incapable. Three
rounds of rewording preceded one placement change. For a small model, WHERE a
thing sits in a long prompt is not presentation - it is whether the thing exists.

---

## The task completes, confirmed by the page rather than the model

```
step 1: type "laptop pro" + submit          -> ok      8.3 s (cold model load)
step 2: type at a button -> refused -> re-planned -> click  -> ok  3.7 s
step 3: done                                          2.6 s
loop stopped after 3 step(s): done
```

And the independent check, from the test lab's own console rather than from the
agent:

```
Cart: 1 item(s)
✓ Cart updated: Laptop Pro added (1 total)
✓ Results updated: 2 product(s) for "laptop pro"
✓ Search form submitted
```

**Exactly one item.** The earlier version of this project clicked the same button
eight times and reached ten. That distinction - the model reporting `done` versus
the page confirming the cart holds one Laptop Pro - is the one worth keeping,
because every failure in this file looked like success from one side of it.

Per-step: capture 20-690 ms, vision 75 ms, redact 5 ms, bake 11 ms, server
1.9 s. Context ~4567/7000 tokens with nothing dropped and geometry intact.

### The 25 lines before the run

The timeline opens with twenty-five `context budget N tokens` lines. Two defects,
both mine, both shipped in the change that added the setting:

- The input read `state.tokenBudget ?? 3400`, and `state.tokenBudget` is only
  populated by a step's `context/sent` event. A reopened panel therefore showed
  3400 while the background still had 7000 stored, and the only way to reach the
  real value was to step the field up to it - which is exactly what those lines
  are. This is the precise disagreement `PanelState.tokenBudget` was added to
  prevent, reintroduced one layer up. `budget/get` now answers with what is
  actually stored.
- `onChange` on a number input fires once per arrow-key press, so each nudge sent
  a message and wrote a timeline line. Committed on blur or Enter instead.

---

## v0.4.3 shipped a blank panel

The whole surface came up as a dark rectangle. No error line, no partial UI.

`let budgetTokens` was declared BELOW `draw()`, and `draw()` referenced it. The
module body calls `draw()` on load, so the first render threw a temporal-dead-zone
`ReferenceError` and Preact rendered nothing.

`tsc --noEmit` passed, because TDZ is a runtime error. There is no linter in this
project. And every panel test exercises `reducePanel` or `App` as COMPONENTS -
nothing had ever mounted the entrypoint that wires them together. So 835 tests
were green against a build whose main surface did not come up.

That is the worst shape a bug can take here: silent, total, and invisible to the
entire suite.

`tests/built/sidepanel-smoke.test.ts` now evaluates the ACTUAL emitted chunk in
jsdom against a stubbed extension API and asserts the root element ends up with
content. Verified by reintroducing the bug and rebuilding:

```
ReferenceError: Cannot access 'Te' before initialization
```

`Te` being the minified `budgetTokens`.

A third assertion was written alongside it and then deleted: its comment claimed
to refuse use-before-declaration in the emitted text, and its body only asserted
the file was non-empty. A test whose comment describes a check it does not perform
is worse than no test, because the next person reads the comment.

**On the shape of this mistake.** The change that broke it was a two-line fix to a
UI annoyance, made after the hard problem was already solved and verified. It went
out without the panel being opened once. The blank screen was found by the user,
not by me.

---

## Settled baseline

The run that stands, on the real test site with vision on and a screenshot sent:

```
step 1: type "laptop pro" + submit                        ok   2045 ms
step 2: type at a button -> refused -> re-planned -> click ok   3269 ms
step 3: done                                                    1382 ms
loop stopped after 3 step(s): done
```

Per-stage on the last step: capture 31 ms, vision 66 ms, redact 5 ms, bake 13 ms,
serialize 0 ms, server 1258 ms, execute 1 ms. The server is 91% of it, which is
the right shape - everything on-device is now noise next to the model call.

52 redactions across the task, including 7 faces blurred from the reviewer
avatars, which only the vision channel can find.

Against the harness, all six fixtures: visual 100%, PII precision 100%, PII
recall 100%, redaction precision 100%, **0 leaks**.

### Where the numbers came from

| | before | after |
|---|---|---|
| Step latency | 42-44 s | 1.4-3.3 s |
| Vision forward pass | 1765 ms (over budget, scored 0) | 66-75 ms |
| Model weights | 26,227,993 B | 232,589 B |
| Package | 60.01 MB | 33 MB |
| Loop outcome | error / no-progress | done, cart holds exactly 1 |

### The one number that is not measured

`Peak heap 0.0 MB (derived-from-model-bytes)` - the resource metric is 20% of the
score and the heap half of it is still a placeholder, reported honestly as
derived rather than measured. `measureResources` exists and runs in the harness;
nothing samples the real JS heap in the browser. That is the largest remaining
gap between what this project reports and what it knows.

---

## The heap figure is measured now

`Peak heap 0.0 MB (derived-from-model-bytes)` on every step, because
`StepDeps.sampleMemory` was optional and nobody ever supplied it. The resource
metric is 20% of the score and its heap half was resting on a fallback constant.
Labelled honestly - `MemorySource` exists for exactly that - but a labelled
placeholder is still a placeholder.

Sampled in the OFFSCREEN DOCUMENT, via `RuntimeStatus.heap`, because that is
where the model, the decoded frames and the ORT arena live. A service worker's
own heap is unrelated to any of them, which is why `sampleMemory` had to become
async: reaching the right context is a message round trip, and a synchronous
sampler could only ever have read the wrong one.

`performance.memory` is Chrome-only, non-standard and JS-heap only - it excludes
the wasm arena and every GPU buffer, so it UNDER-reports. `jsHeapOnly: true` says
so and the panel prints the source beside the number.
`performance.measureUserAgentSpecificMemory()` would be authoritative and needs
`crossOriginIsolated`, which an extension page is not. Firefox has neither, and
reports **null** - "not measured", never zero.

## Plan-only, for pointing this at a real site

Everything runs - capture, vision, redaction, the sanitized context, the server
round trip, validation - and only the final click is withheld.

The reason it exists: the claim this project is built to demonstrate is that a
logged-in page's real name, address and card on file are stripped before anything
leaves the machine. Testing that requires a real logged-in page, which is also
the single worst place for an agent to click something by mistake. Those two
facts were in direct conflict and the resolution is a switch.

### Found while wiring it

The single-step path was building its `StepInput` WITHOUT `budget` and WITHOUT
`screenshot`. "One step" and "Run task" were running different pipelines: one
with a context budget and an image, one with neither. Nothing failed, so nothing
said so - a step tested with the button behaved differently from the same step
inside the loop. Both paths now take the same three settings.

---

## Amazon: the run that looked like nothing happening

```
panel PLAN ONLY - the agent will decide but not click
capture 177232 bytes in 35 ms
vision 3 box(es) via webgpu
sent 246 of 344 element(s) - dropped 98, ~6975/7000 tok, 9 name(s) truncated
local-heuristic-baseline type in 0 ms
loop stopped after 2 step(s): done
```

Reported as "nothing happened on screen". Two separate facts in that, and only
one is a defect.

**Plan-only was on**, so nothing touching the page is the feature working.

**But the VLM was never asked.** No `planning via` line, and the planner is
`local-heuristic-baseline` at 0 ms - the on-device fallback, used whenever
`serverOrigin` is null. The origin had not been granted for that session.

The notice for this existed and fired only when the ORIGIN CHANGED, so a run that
never had one said nothing at all. The sole evidence of planning on-device was
the ABSENCE of a line. That is the same shape as every other failure in this file
- a signal that has to be inferred from a gap - and it turned "the VLM did
nothing" into a reasonable reading of a run where the VLM had never been
contacted. Both entry points now announce the planner at the start of every run.

### What the run does show

The three things that had never been tested outside a fixture all held on a real
page of 344 elements:

- **The budget worked as designed.** 246 sent, 98 dropped, ~6975 of 7000 tokens,
  9 names truncated - and it named the dropped refs rather than truncating
  silently. This is the first evidence that `maxRenderedNameChars` earns its
  place: nine real names on Amazon exceeded 96 characters.
- **YuNet ran on a real page** and returned 3 boxes in a viewport of a site
  nobody wrote fixtures for.
- **Capture handled 177 KB** in 35 ms.

### The number worth asking about

`redaction 3 applied`, with 3 vision boxes - which suggests the DOM scan
contributed almost nothing, on a page that should carry an account name.

That is consistent with the oldest gap in this project: person names in free
prose are undetected, and need NER or OCR-plus-classification. A fixture page
carries emails, card numbers and phone numbers, all of which match patterns. A
real logged-in page's visible PII is frequently just a NAME, which is exactly the
kind this build does not find.

Not yet confirmed - the session may simply have been logged out. But it is the
right hypothesis to test next, and if it holds it is the most important finding
of the whole real-site exercise: the fixture suite scores 100% on a class of PII
that a real page barely contains.

---

## Amazon, second attempt: the model replied in prose

```
planning via http://localhost:8787
sent 248 of 340 element(s), ~7000/7000 tok, geometry omitted, 9 names truncated
bake 2/2 pixel op(s), 131816 bytes
qwen2.5vl-8k no usable action (688 chars)
parse unparseable action: no-json-found
```

The VLM was reached this time - the planner notice added an hour earlier is what
made that visible. It returned 688 characters containing no JSON.

**And the panel showed none of them.** Two hypotheses were built and tested
against the live model before that became the obvious problem:

- 194 elements, no image: clean JSON.
- 124 elements WITH a 131 KB image: clean JSON.

Neither reproduces it. So the cause is something about Amazon's actual content,
and the evidence was sitting in a reply the panel had counted and discarded.

`unparseable action` now carries a 220-character snippet of what came back,
neutralised and capped - the reply is text from a remote endpoint and is held to
the same standard as page content, shown as a diagnostic rather than trusted as
one.

**The lesson is the recurring one, in a new place.** `rawLength: 688` was
measured, reported, and useless. The instrument recorded that something existed
without recording what it was, and the next two hours would have gone into
guessing. This project's own rule - a number that cannot distinguish two causes
is not a measurement - applies to error text as much as to pixel ops.

---

## The model was captioning the screenshot

The diagnostic snippet added an hour earlier paid for itself on the first run:

```
parse unparseable action: no-json-found - model said: The image is a screenshot
of the Amazon India website. Here are the key elements visible in the image:
1. **Header Section**: - The top of the page includes the Amazon India logo...
```

621 characters of image description and no JSON. Handed a screenshot of a web
page, a vision model did what it was overwhelmingly trained to do with one.

`VlmPlanner` built its content parts as `[text, image]`, which put a UI
screenshot at the very END of the request. **This is the third time in this file
that a small model acted on whatever came last** - history above the element list
was ignored while a correction below it was obeyed, and now an image in the final
position outranked every instruction above it.

Two changes:

- The image goes FIRST, so `Respond with one JSON action object` is the last
  thing in the request rather than a picture of a shop.
- The prompt names the failure mode: `Do NOT describe the image or list what is
  on the page.` Telling the model what to do was not enough against that pull.

**Not verified locally, and said plainly.** Two attempts to reproduce failed: 194
elements with no image, and 124 elements with a 131 KB portrait, both returned
clean JSON. A synthetic UI-shaped bitmap was rejected by Ollama. The trigger
appears to need a real screenshot of a real interface, which nothing here can
manufacture. The fix is reasoned from the model's own words and from a behaviour
this project has now measured twice; it is not measured itself.

### The staleness guard had a hole, and this found it

After adding the anti-caption line the fingerprint did not move: it hashed only
`INSTRUCTIONS`, and the new line lives in the per-call assembly. A guard that
answers "is the server running the prompt I just wrote" would have said yes to a
server running a different prompt - the exact failure it was built to prevent,
one layer down.

The static tail is now a named `CLOSING` constant and part of the hash.
07a8a8ac -> 676c73a2 -> **8a942286**, which is the number moving for the right
reason.

---

## The handover report listed a finished job as the top priority

`STATUS.html` was written to hand this project to teammates. Re-checked before
turning it into a circulated PDF, and it was wrong in the way a status document
is always wrong: it had aged past the work.

The headline was the problem. **"If you pick up one thing: get a screenshot in
front of the model."** That had already happened - `124 elements WITH a 131 KB
image: clean JSON`, recorded in this file. The single most prominent sentence in
the report pointed a teammate at a closed task.

What else had drifted, all of it verified against a command rather than memory:

| Claim | Was | Actually |
|---|---|---|
| Version | `v0.2.0` | `0.5.4` from package.json |
| Unit tests | 842 | 846 (`npm test`, confirmed over three runs) |
| Built-artifact tests | 58 in one place, 56 in another | 56 (`npm run test:built`) |
| Fixtures | 5 rows in the scorecard | 6 - `unlabelled-media` missing |
| Server model | `qwen2.5:3b`, incl. the pull command | `qwen2.5vl:3b` (`npm run ollama:pull`) |
| Faces redacted | 42 | 42 was the **yolos-tiny** run; the YuNet-era figure is 52 redactions, 7 of them faces |

The `qwen2.5:3b` one had teeth. The report's setup steps told a teammate to pull
a **text-only** model, immediately below a section saying the priority was to get
an image to the model. Following the report exactly would have made the priority
impossible and given no clue why.

### The correction that mattered more than the numbers

A global find-and-replace of `qwen2.5:3b` -> `qwen2.5vl:3b` fixed the setup steps
and **falsified two measurements**: the 237 ms / 3537 MiB first-run figures and
the select/checkbox/cart planner comparison were both recorded against the text
model. Reverted those two to `qwen2.5:3b` and said so in the prose.

Renaming a thing in a document is not the same operation as renaming it in code.
Historical measurements are attributed to whatever produced them, permanently,
and a sweep that cannot tell "what we run now" from "what we ran then" corrupts
the evidence while appearing to tidy it.

### What was added

The real-site chapter was absent entirely. It is now its own section, because it
is the only place the fixtures get contradicted:

- the context budget worked on 344 real elements, naming the refs it dropped
- YuNet returned 3 boxes on a page nobody wrote fixtures for
- the DOM scan found **almost nothing** on a page that should carry an account
  name

The scorecard table now carries the sentence that belongs beside every 100% in
this project: **the fixture suite scores 100% on a class of PII that a real page
barely contains.** Fixtures are dense with emails, card numbers and phone
numbers - the kinds that match a pattern. A real logged-in page's visible PII is
frequently a person's name, which is the oldest known gap here.

The new top priority is settling that, in plan-only mode, on one logged-in page.
Nothing else on the list changes what we can honestly claim.

Also recorded: the sub-threshold `bank-account` on `checkout` that the scorecard
reports and the summary table cannot show - found but never acted on, counting as
neither a hit nor a leak.

### The recurring rule, in a new place

This project's rule is that a guard which cannot see the artifact it guards is
not a guard. A status report is an instrument pointed at the work, and it had no
check at all - nothing fails when it goes stale, so it went stale in six places
at once and stayed confident. Every number in it now comes from a command that
was run while correcting it, and `make-pdf.sh` regenerates the PDF from the HTML
so the two cannot diverge.

---

## Amazon: JSON at last, and two things the run exposes

```
sent 103 of 437 element(s) - dropped 334, ~3376/3400 tok
qwen2.5vl-8k type in 2381 ms
validate re-planning once: not-typeable at e128 -> correction accepted: click -> ok
... three times ...
loop stopped after 3 step(s): repeating
```

**The captioning is gone.** Moving the image to the front of the multimodal
request and naming the failure mode in the closing line produced valid JSON on
the first try, on the page that had been returning prose. That was the fix
reasoned from the model's own words and it holds on the real stimulus, which no
local reproduction could manufacture.

### 3400, not the 7000 that was set

`storage.session` is cleared when the extension reloads. The context budget lived
there, so every rebuild silently reverted a setting the user had typed - and this
run sent **103 of 437 elements** as a result. The panel dutifully reported the
drop; the number it was obeying was simply not the one that had been chosen.

Preferences now live in `storage.local`: budget, plan-only, screenshot, vision,
and the server origin. Session storage keeps what genuinely should not outlive a
reload - the attached tab, which is tied to a grant the browser can withdraw.

The origin moves with a check rather than on trust: `hasSiteAccess` is consulted
on restore, because the permission is revocable independently of the stored value
and reaching for a server we can no longer call is worse than starting with none.
Losing it silently is what turned an earlier Amazon run into "the VLM did
nothing" when the VLM had never been asked.

### The click that changes nothing

Three identical steps, `capture 227771 bytes` byte-for-byte each time, `action
click ok` each time. The executor reports success and the page does not move.

Two candidates, and this run cannot separate them:

- With 334 of 437 elements dropped, the element the task needed may never have
  been sent, and `e128` is whatever survived that looked closest.
- Or the ref resolves to a real node and clicking it genuinely does nothing -
  Amazon is full of wrappers and spans that swallow a click.

The budget fix has to land first, because at 103 elements the agent is choosing
from a quarter of the page. Re-running at 7000 is the experiment that tells these
apart.

---

## The screenshot guard was too weak, and a page could disarm it

A 19-agent adversarial review of the guard, prompted by it refusing on every
Amazon step. It found the opposite of what was being investigated.

**The guard was an AGGREGATE.** `appliedCount > 0 && pixelOps.length === 0` asks
whether ANY pixel op exists, not whether EACH applied redaction got one. On a page
with one coverable PII item and one uncoverable one, a single op disarmed it and
the image was sent with the second still legible. Demonstrated: reverting to the
aggregate makes the new test fail with `expected { base64: 'BAKED', ... } to be
null` - the screenshot going out.

**And the page could supply that op itself.** `stampGeometry` wrote
`data-test-rect` only in its success branch; the two `continue` paths left a
page-authored value untouched, and `attributeRectProvider` reads it back with no
provenance check. `grep -rn 'data-test-rect'` across `src/` found nothing that
strips it. So a hostile page mints one fake rect, one pixel op exists, and the
aggregate guard is off for the whole page.

Both are fixed, and either alone would have left the other exploitable:

- The guard joins on `detectionId` and refuses if ANY applied redaction lacks an
  op. The message names the KINDS left uncovered, never the values.
- `stampGeometry` calls `removeAttribute` on every element before measuring, so
  the attribute means exactly one thing: a rect WE measured.

**What it does NOT do is relax anything.** The Amazon case - PII in a collapsed
menu, unpainted, therefore genuinely absent from the screenshot - still refuses.
Relaxing it needs a three-state paint classifier that this repo has no source for
and no measurement of, and the review was explicit that the obvious version is
unsound: a selected `<option>`, a shadow root, and `content-visibility:auto` all
report no client rects while being painted. Refusing costs metric 1 on real
pages. Shipping a picture of somebody's account menu costs the premise.

### The budget was measuring a prompt it does not render

`renderElement` pushed `box=` UNCONDITIONALLY while the budget's first shedding
lever is to drop geometry and report `geometryOmitted`. So the budget believed it
had freed ~40% of every row and the renderer emitted it anyway - every estimate
after that lever fired was wrong in the direction that overfills the window,
which is the direction that produces the 400 the budget exists to prevent.

The call site had a second trap on top: `.map(renderElement)` passes the array
INDEX as the second argument, so a naive fix would have omitted geometry for
element zero and emitted it for every other one. A test asserts NO row carries
`box=` when the budget dropped it, rather than "not all rows".

### Still open, and named rather than guessed

- **703 elements against any window.** At ~32 tokens a row that is >20k tokens;
  8192 cannot hold it and neither can any setting. The review measured a
  608-element Amazon-shaped page sending 106 rows carrying **one distinct name
  and zero buttons** - the ranking keeps duplicates. That is the next thing worth
  fixing and it is a ranking problem, not a budget one.
- **`action click ok` on a page that does not move.** Unresolved: the executor
  reports success for a click that has no effect, and the capture comes back
  byte-identical. Whether the ref was inert or the needed element was among the
  90% dropped cannot be told apart from this run.

---

## 250 rows carrying 40 distinct names

The real-site blocker, measured on a synthetic 150-product storefront rather than
argued about:

```
BEFORE  AVAILABLE 907  SENT 250   tok 6996/7000
        distinct names 40    empty names 31
        roles: link 98, button 151

AFTER   AVAILABLE 907  SENT 110   tok 6989/7000   collapsed 588
        distinct names 106   empty names 0
        roles: link 105, button 4
```

**151 of those 250 rows were the identical button "Add to basket".** The model
has no way to tell the 40th from the 1st - they render identically - so the extra
148 bought no choice while distinct product links were dropped to make room for
them. That is why the agent kept planning the same ref on Amazon: the elements it
needed to navigate by were the ones being discarded.

Fewer rows now carry 2.6x the distinct names.

Two changes, and the ORDER of them is the point:

- **Duplicates are collapsed BEFORE anything competes for space.** Ranking them
  lower would not have worked - 151 duplicates ranked below a heading still
  outrank it 151 times and still consume the budget. Removing them first is what
  frees the room. Capped at three per (role, name), not one: two "Next" buttons
  or a pair of "Sign in" links are a real choice, and collapsing those to one row
  would hide it. On-screen duplicates are preferred, then document order.
- **An unnamed element is penalised.** `ref=e50 role=link name=""` gives the model
  nothing to reason about, and once the budget drops geometry there is no other
  handle either. 31 of the 250 were these. Penalised rather than excluded: on a
  page small enough to fit, sending one costs nothing.

Collapsing is a FILTER, like every other lever here - ordinals are untouched. A
test asserts the survivors of six identical buttons are `e1, e2, e3`, because a
renumbering here would be exactly as dangerous as one in the drop loop.

`duplicatesCollapsed` travels in the report and the panel prints it, under the
same rule as the rest: bounded coverage is never silent.

Verified by disabling the collapse: 3 tests fail, including
`expected [ 'e1'..'e6' ] to deeply equal [ 'e1', 'e2', 'e3' ]`. The six fixtures
still score 100% across the board with 0 leaks.

**What this does not fix.** Whether the agent then picks the right element from a
better list is untested - the storefront is synthetic, and the real question is
what Amazon does. The measurement here is about information density in the
payload, not about task success.

---

## The agent can ask a question now, and the model is not what asks it

`ask_user` was plumbed end to end - parse, validate, execute, a loop stop - and
went nowhere. The loop halted, the panel showed a reason, and the question itself
was discarded with the action. There was no route for a reply.

**The model will not volunteer one.** Measured against qwen2.5vl at temperature 0
on a page carrying both "Add Laptop Pro to cart" and "Add Gaming Laptop to cart",
goal "add a laptop to the cart":

```
rule in the RULES block      -> {"type":"type","ref":"e14","text":"Add Laptop Pro..."}
same instruction at the END  -> identical
```

Two placements, no difference. On the `checkout` fixture with the goal "buy a
laptop" it went further and invented a card number. A 3B model does not stop to
ask, and this project has already spent three rounds learning that more prose is
not the lever.

So detection is DETERMINISTIC and runs on the client. `detectAmbiguity` fires
when a goal term matches several distinctly-named candidates OF THE SAME ROLE and
no other goal word picks between them. It runs BEFORE the server call - there is
nothing to plan yet, and the question is composed from the page's own accessible
names rather than from anything a server said, which keeps it on the safe side of
the trust boundary.

Deliberately narrow, because a question the user did not need turns a working
agent into a nag:

- Capped at 4 candidates. Forty laptops on a results page is not an ambiguous
  goal, it is a goal about forty things, and a question listing forty options is
  not a question.
- Skipped when the goal already decides. The check is whether some goal word
  appears in exactly ONE candidate - not whether each candidate shares SOME word
  with the goal. "add laptop pro to cart" against those two buttons: both contain
  `cart`, so the loose version called both decided and asked anyway. `pro` is the
  word that actually decides.
- Grouped by role, so a heading sharing a word with a button is not a choice.
- Stopwords include the verbs every shop button carries, so "add" is never the
  discriminating term.

The panel shows the question with a warning that no legitimate question needs a
password, card number or OTP - a compromised server that can ask anything would
otherwise have a channel straight into the extension's own trusted UI. The prompt
forbids asking for one; the panel says so independently, because the prompt is
advice to a model and the warning is for a person.

Answers are held against the CURRENT GOAL and cleared when the goal changes:
answers about which MacBook do not carry over to booking a flight.

## A boundary test that had stopped testing anything

Adding `ambiguity.ts` made `boundaries.test.ts` fail - on a FALSE POSITIVE. Its
scanner is `/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/`, and the new stopword list
contains `'from', 'into',`. The regex read `from', '` as an import of `", "`.

The fix was a negative lookbehind, since `from` preceded by a quote is inside a
string. **And the fix silently broke the guard entirely.** Writing it through a
Python heredoc turned `\b` into a literal BACKSPACE character (0x08), so the
emitted regex was:

```
/(?<!['"])^H(?:from|import)^H\s*\(?\s*['"]([^'"]+)['"]/g
```

It matched nothing. The test went green and checked NOTHING - a module-boundary
guard passing vacuously, which is worse than the false positive it replaced.

Caught by doing the negative check: adding a real `import { readFileSync } from
'node:fs'` to a contracts file and finding the suite still passed. Both
directions are now verified - the real import fails 2 tests, the string literal
passes 13.

That is the fourth time in this file that a guard needed to be shown FAILING
before it could be believed, and the first where the damage was done by the
escaping of the fix rather than by its logic.

---

## The task panel is a conversation

One input, two buttons and a status row, replaced by a transcript.

The interaction always had this shape and the UI would not admit it. An agent
that needed to ask something had nowhere to put the question: the loop stopped,
`ask_user` appeared as a reason in a status field, and the only way to supply an
answer was to retype the whole goal.

What changed:

- **A transcript.** Every line is either FROM THE USER - the one string in this
  pipeline that is trusted input - or FROM THE AGENT, meaning a question composed
  on this machine from the page's own accessible names, or a status this panel
  generated. Nothing a server said is rendered as a message.
- **One input for both jobs.** When a question is outstanding it sends the
  answer and resumes the ORIGINAL goal; otherwise it starts a task. Two boxes
  would make the user decide which applies, and the panel already knows. The
  button label changes so the mode is visible.
- **The credential warning is separate from the conversation**, and only shown
  while a question is open. It is advice to a PERSON, not a turn in the dialogue.
  The prompt already forbids the model asking for a password - but the prompt is
  advice to a model, and a server that can put text in front of a user could
  otherwise ask for one inside the extension's own trusted UI.
- **"One step" survives, demoted.** It answers a different question from "run the
  task" - it is how you watch the agent think when a step is going wrong - and
  this panel is a debug view until the Figma design lands.

`messages` lives in the panel entry rather than in `PanelState`, deliberately:
`reducePanel` is a pure function of `PanelEvent`, and a transcript is a mix of
what the user typed and what the view generated. Routing it through the event
stream would make the reducer responsible for formatting, which is a view
concern.

Six tests RENDER THE REAL COMPONENT rather than type-checking it, because the
last panel change that was only type-checked shipped a blank side panel. They
caught two things immediately: the buttons are gated on `canRun` (an attached tab
AND a loaded model), and `modelLoaded` reads `state.host`, not `state.model` - a
fixture that guessed either would have asserted nothing.

### Confirmed in the browser

```
plan needs an answer: Which one did you mean - Laptop Pro, or Gaming Laptop?
step 1 ok in 205 ms
loop stopped after 1 step(s): ask_user
panel answered: Laptop Pro
qwen2.5vl-8k click in 1782 ms -> action click ok
qwen2.5vl-8k done  in 1699 ms -> action done ok
loop stopped after 2 step(s): done
```

**205 ms for the question**, because it is asked BEFORE the server call - there
was nothing to plan yet, and the round trip would have been spent on a choice the
model was measured not to make. Answering resumed the original goal and finished
in two steps.

The question named both candidates from the page's own accessible names. Nothing
a server said reached the user, and the model - which does not volunteer
`ask_user` at any prompt position - was never asked to.

## Pointing the agent at the wrong port

A run reported `plan: server: server returned 404` with the panel showing
`planning via http://localhost:8080` - the test SITE, not the agent server on
8787. Two ports on one machine and one field between them.

Two things came out of it:

- **`serverOrigin` was restored from BOTH stores.** The session read ran first
  and set it unconditionally; the local read, added with the preferences
  migration, only overrode it when `hasSiteAccess` passed. So a stale unverified
  value survived whenever the checked one was rejected - two sources of truth for
  one setting, with the weaker one winning. The session read is gone.
- **A 404 now names the likely cause.** `server returned 404` reads like the
  server is broken rather than like it is not an agent server at all, so the
  message says the origin does not serve `/plan`. Named, not diagnosed: the
  client cannot know what the origin should be, only that whatever answered does
  not serve that route. Non-retryable, because re-sending identical bytes to a
  server without the route cannot start working.

---

## The clarification looked like it worked, and the answer changed nothing

Two consecutive real runs, answering differently:

```
answered "Laptop Pro"    -> not-typeable at e14 -> click e14
answered "Gaming Laptop" -> not-typeable at e14 -> click e14
```

Same ref. `e14` is "Add Laptop Pro to cart". The conversation happened, the panel
showed both turns, and the agent did the same thing either way.

Probed directly, with the ANSWERS block confirmed present in the prompt:

```
BLOCK-PRESENT true
answered "Gaming Laptop" -> {"type":"type","ref":"e14","text":"Laptop Pro"}
answered "Laptop Pro"    -> {"type":"type","ref":"e14","text":"Laptop Pro"}
```

**The model ignores the answer**, exactly as it ignores history and ignored the
ambiguity rule. A conversation whose answer changes nothing is worse than no
conversation: it demos beautifully and does the wrong thing.

So the answer CONSTRAINS instead of instructing - the same principle the ref
allowlist rests on. The way to stop the model choosing wrongly is not to send the
wrong ones.

Three defects had to be fixed before that worked, and each was only visible
because the previous one was:

1. **The question was about the wrong elements.** It asked "Laptop Pro, or Gaming
   Laptop?" - those are the HEADINGS. The buttons are called "Add Laptop Pro to
   cart", so the answer matched no actionable element and nothing could be
   narrowed. Detection is now restricted to actionable roles, which keeps the
   question and the remedy in one vocabulary.
2. **The group was too broad.** With headings excluded it asked "View details for
   Laptop Pro, or Add Laptop Pro to cart, or View details for Gaming Laptop, or
   Add Gaming Laptop to cart?" - four options across two different actions, when
   the goal said "add ... to cart". Candidates are now scoped to those matching
   the goal best, which gives two.
3. **Matching on raw overlap tied.** Every candidate shares the goal term by
   construction, so "Gaming Laptop" scored a point for `laptop` against both.
   Narrowing now matches on DISTINCTIVE words - what actually separates the
   candidates - which is `gaming` versus `pro`.

Verified against the running model:

```
QUESTION :: Which one did you mean - Add Laptop Pro to cart, or Add Gaming Laptop to cart?
"Gaming Laptop" -> Pro removed from the sent set -> model returns e18
"Laptop Pro"    -> Gaming removed                -> model returns e14
```

Different refs. The answer decides.

**It refuses to guess.** An answer matching none of the candidates, or all of
them, leaves the page untouched - narrowing on a half-understood reply is how a
clarification becomes a wrong click wearing the user's own words. And it is a
FILTER: a test asserts the survivors keep their ordinals, because
`extractRefPaths` walks the unfiltered document.

---

## The question the server asks was never neutralised

Sent 25 agents to design clarification for facts absent from the goal ("book a
flight" with no date). The verdict was **do not build it yet**, and the first
finding was not about flights at all.

`ask_user` is the ONE thing a server says that is rendered to the user as prose -
in the extension's own panel, directly above the input box - and it arrived raw.
No neutralisation, no length cap, newlines preserved under `white-space:
pre-wrap`. `grep -rn neutralize src/` returned exactly one production call site,
the parse-error snippet, and the panel was not it. `validateAction` passed
`ask_user` through with no checks whatsoever.

`contracts/context.ts` already stated the requirement - *"neutralise before
rendering it anywhere a person will read it"* - and nothing did it. This file's
own claim that "nothing a server said is rendered as a message" was false, and
the counterexample was the feature that claim was written about.

Two fixes:

- **Neutralised and capped at parse**, so every consumer downstream gets clean
  text rather than each being trusted to remember. Same treatment page text gets
  from `toDataAtom`, for the same reason. 200 characters, because a question is
  one sentence and a wall of text above an input box is how a person is talked
  into typing something.
- **A question soliciting a credential is REFUSED**, not warned about. The panel
  defended this with a line of hint text beside the question, which asks the user
  to out-argue a sentence we chose to display. "Confirm your password to
  continue" arriving there is a phishing prompt wearing our credibility. Refused
  rather than stripped: a question with the words removed still means what it
  meant. The rule names the SECRET, not the phrasing - paraphrases of "what is
  your" are endless.

### The flight feature: not yet, and the reason is measured

Option (b), "ask about empty required fields the page declares", is refuted on
its own terms:

- **`required` is absent on the motivating domain.** Measured live on Google
  Flights, MakeMyTrip, Kayak and IndiGo: `[required],[aria-required=true]` = 0,
  `input[type=date]` = 0 on all four. `statesOf` can only emit `required` from
  those attributes, so it fires on none of them.
- **It is absent from this repo too.** One hit across six fixtures and the test
  site - login-form's PASSWORD field. So "fires zero times on the corpus" is
  true and empty: `if (false) ask()` scores the same.
- **"Empty" is not observable at all**, and this is the one that matters beyond
  flights. The content script serialises with `clone.outerHTML`, which emits
  CONTENT ATTRIBUTES only, and `readControlValue` reads `getAttribute('value')` -
  the markup default. Typing sets the value IDL property and never touches the
  attribute. So a field the user just filled reads empty, a `<select>` reads
  empty forever, and **the agent cannot see its own typing**, because
  `execution/actions.ts` sets `field.value` too.

That last point is a real defect independent of this feature: `execute` returns
`ok` unconditionally, so typing "next Friday" into a date input - which the HTML
value-sanitisation algorithm turns into "" - is reported as success.

The shape that would work is **ask-when-stuck**: act, and raise a question at an
observed dead end rather than a predicted one. It needs a read-back after `type`
that does not exist, and `runOneStep` does not pass `clarifications` at all, so
the single-step path would re-ask forever. Both are cheap; neither is done. The
feature is gated on the measurement, not on the calendar.

**Second time today the same escaping trap hit.** Writing `\b` through a Python
heredoc produced a literal BACKSPACE in the emitted regex, so
`SOLICITS_CREDENTIAL` matched nothing and all six refusal tests failed. The first
occurrence silently disabled a module-boundary guard. Regexes go in through an
exact edit, not through string interpolation.

## Asking about a word the user did not mean

A real amazon.in run, goal "add macbook pro to cart":

```
Which one did you mean - Cart, shift, alt, c, or 0 items in cart?
```

Those are Amazon's cart LINK - whose accessible name carries a keyboard shortcut
hint - and the cart counter. No answer to that question helps, and the task
stopped to ask it.

`macbook` matched nothing, because the homepage has no MacBook on it. So the term
loop fell through to `cart`, a word that appears all over the nav, and offered two
pieces of chrome as if they were a choice.

**The user named something the page does not contain.** That is not an ambiguity,
it is a page the agent has not navigated to yet, and the right move is to go and
find it. `detectAmbiguity` now returns null when ANY goal term is absent from the
actionable names on the page - one pass, no per-domain knowledge.

Checked against the case that must keep working: "add a laptop to the cart" on the
test site has both `laptop` and `cart` present, so it still asks. And a `macbook`
appearing only in a HEADING does not license the question either, because the
page-word set is built from actionable elements only - the same restriction the
candidate groups already use.

Verified by disabling the rule: the Amazon question comes back as
`expected { term: 'cart', ... } to be null`.

### Also visible in that run, both working as intended

- `bake screenshot NOT sent: 1 of 1 applied redaction(s) produced no pixel op
  (api-key)` - the per-detection guard, naming the KIND left uncovered rather
  than the value.
- `sent 241 of 345 element(s) - dropped 98, 6 duplicate(s) collapsed` - the
  collapse fires on a homepage too, though only six: Amazon's front page carries
  far fewer exact-duplicate names than a search results page does.

## "Done." having done nothing

Two amazon.in runs, goal "add macbook pro to cart":

```
sent 243 of 415 element(s)
qwen2.5vl-8k done in 1935 ms
action done ok
loop stopped after 1 step(s): done
```

The model returned `done` on step 1 without touching the page. No MacBook on the
homepage, no obvious move, so it declared success - and the panel printed
"Done."

That is the panel asserting something it cannot know, and it is the same failure
this file keeps naming: a confident report about something that was never
checked.

`LoopResult.actionsTaken` counts actions past the terminal check, so `done` and
`ask_user` - which touch nothing - can never be mistaken for work. The transcript
now distinguishes them:

  "I did not need to do anything - the goal already looked met. If that is
   wrong, tell me what to do instead."

Still `ok: true`, deliberately. A goal CAN be met without acting - "am I signed
in?" is answered by looking - so this is not an error, it is a different outcome
that was being reported identically.

### The planner notice was reporting the opposite of the truth

Line 16 of the same run said `planning ON-DEVICE (heuristic baseline) - no server
origin granted`, and line 23 said `qwen2.5vl-8k done in 183 ms`.

The notice fired BEFORE `await attachedReady`, so it read `serverOrigin` before
storage had been rehydrated. A line added two days ago specifically to remove a
blind spot - a run that silently fell back to the on-device planner - was itself
announcing the wrong planner. Moved after rehydration in both entry points.

Worth noting the shape: the fix for an observability gap introduced a NEW
observability gap, in the opposite direction, and it took a contradiction inside
one timeline to see it.

## Privacy Gate proof UI: show evidence, not a claim

The core pipeline already had the right security property: a screenshot is
created only by `bakeRedactions()`, and the step refuses an image when an
applied redaction has no pixel operation or an overlapping operation fails to
land. That was invisible in the side panel, so a judge could only trust a log
line saying that privacy protection happened.

The panel now carries a small, data-only proof ledger for the latest step:

```
capture local -> detect/redact -> pixel verification -> planner delivery
```

Two rules kept the demo feature honest:

1. **The panel receives only the baked screenshot.** `context/sent` may include
   an image preview, but it is copied from `SanitizedContext.screenshot` after
   bake; `CapturedFrame.dataUrl` has no path to a panel event. The original
   remains visible only in the user-controlled browser tab.
2. **Prepared is distinct from delivered.** `context/sent` now means the
   sanitized context is ready. `context/transmitted` is emitted only after the
   planner successfully accepts it, and says whether it went to a cloud planner
   or stayed on-device. A failed request cannot be dressed up as a transmission.

The `Privacy Lens` is the complementary live visual. Once local redaction
finishes, the content script overlays locally-derived category/geometry masks on
the source page, so the audience sees the page become protected in real time.
It is explicitly a visual aid, not the network artifact: it is cleared before
the next snapshot (so it cannot contaminate capture), is non-interactive, carries
no detected values, and can be removed with one panel button. The immutable
evidence remains the baked preview and its `opsApplied/opsRequested` record.

Verified with `npm test` (915 tests) and `npm run test:built` (both Chrome and
Firefox build targets plus 56 emitted-bundle checks).

## Three AI deployments, one privacy boundary

The brief asks for the same extension to plan against a local model, an
organisation's own GPU server, or a hosted API - without the privacy boundary
moving when the destination does. What follows is what that actually required,
including the parts that turned out to be traps.

### The abstraction already existed; the DEPLOYMENT abstraction did not

`AgentClient` was already the right seam: `plan(request, signal) => PlanOutcome`,
with `PlanRequest.context` typed `SanitizedContext` so nothing else can be sent.
It was not an abstraction over deployment. The background chose between two
concrete classes on `serverOrigin === null`, and a single nullable string cannot
express four modes: it could not tell a loopback Ollama from an organisation's
GPU server from a hosted API, so the panel could not name the destination, the
receipt could not record it, and the TLS rule could not differ between them.

`AgentBackend extends AgentClient` adds exactly two things - `descriptor` and
`health()` - and the settings UI, the health indicator, the "unavailable" flow
and the privacy receipt are all built from those. What it deliberately does NOT
add is any hook for changing what is sent. There is no per-backend context
transform and no "cloud mode also needs X", because a backend that could reshape
the payload would be a backend that could unredact it.

`local`, `private` and `cloud` are three instances of ONE `HttpAgentBackend`
wrapping ONE `HttpAgentClient`. That is the whole mechanism behind "privacy does
not depend on the backend": there is no second HTTP path to forget the gate in.
`tests/agent-server/backend.test.ts` asserts the three produce a BYTE-IDENTICAL
body for the same context, compared as strings after a real serialisation and a
real socket - because every leak this project fears is a leak of bytes, and an
injected `fetch` sees the object the client passed rather than what went out.

`on-device` is the fourth kind and is a first-class CHOICE, not a fallback. If it
were a fallback then every failure of a real backend would silently become it,
and the panel would report a successful plan produced by a different agent.

### Two gates, at two layers, because one layer cannot reach both checks

**`contracts/egress.ts` - the shape gate.** Runs as the first statement of
`HttpAgentClient.plan`, before the endpoint is even read. That placement is the
point: it is the last code before a socket write, and it is the choke point all
three off-device deployments share.

It exists because the nominal type stops being a fact at the first message
boundary. On Chrome the context is built in the offscreen document and
JSON-serialised back to the service worker, where `receiveSanitizedContext`
RE-BRANDS a plain object - `createRemoteDomPipeline` says so in its own comment.
From that point `SanitizedContext` is an assertion about provenance, not a
property of the bytes in hand.

The check that earns its keep is not any of the specific rules; it is
`unexpected-field`. Every other rule can only refuse something somebody thought
of. That one inverts it: the sanitizer emits a fixed set of keys, so any other
key - `rawHtml`, a `domPath` on an element, a token bolted on later - is either a
mistake or an exfiltration.

For screenshots it keys on the OP COUNTERS. `CapturedFrame` carries `dataUrl`,
`frameId`, `natural` and `viewport` and has no counters at all, because only
`bakeRedactions()` produces those. Their absence is what makes "only a baked
image may be sent" a runtime fact rather than only a type - and it closes the one
real structural weakness, `receiveBakedScreenshot`, which will brand any object
with the right seven fields on the word of the sender.

**`redaction/egress.ts` - the content gate.** Re-runs the PII detectors over the
text about to leave. It cannot live in contracts (it needs `scanTextPatterns`)
and it cannot run inside the client (`agent-server` may import only contracts),
so the orchestrator - the one layer that sees both modules - calls it as a new
`verify` stage between `sanitize` and `plan`.

A finding here is almost certainly real, and the reason is structural: the
redactor scanned page text at `minConfidence` and replaced what it found; this
scans the ALREADY-REDACTED text at the SAME threshold, passed through rather than
defaulted. Same code, same setting, so they can only disagree where the text they
see differs - a value assembled across nodes, a group name lifted from a heading.

Three things it deliberately does not scan, each for a reason:

- `goal` and `clarifications`, which are what the USER TYPED. Somebody whose task
  is "email the invoice to me@example.com" authored that address on purpose.
- `screenshot.base64`. A long base64 run trips the card and phone rules
  constantly and means nothing; the image is checked by its counters instead.
- Redaction placeholders, stripped before scanning. `[[PII:PHONE:3:9f2a…]]`
  carries a digit run and a hex tail and the phone rules match inside it - a
  verifier that scanned them would fire hardest on the pages it protected best,
  and would be switched off within a day.

Both gates FAIL CLOSED and neither repairs a payload. A gate that stripped the
offending field and sent the rest would turn "we found a leak" into "we sent
something", produced by a pipeline just shown to be wrong about this page.

**The gates run for `on-device` too.** The requirement is not "check harder when
the destination is a cloud"; it is that the boundary does not move when the
destination does. A leak that only manifests on-device is still a redaction bug,
and finding it in the mode nobody fears is how it gets fixed before it matters.

### The token: write-only, header-only, session-only

`HttpClientOptions.authToken` is a FUNCTION, not a string, and that is the whole
design. The token is never a field on the client, so it cannot be reached by
anything holding a reference and does not appear if the object is ever logged.
It is read per request, so revoking it takes effect on the next step. And it goes
into an `authorization` header and nowhere else - not the body, not the URL, not
`BackendDescriptor`, not a `PanelEvent`, not the receipt.

`BackendDescriptor` has an `authenticated: boolean` and no field capable of
holding a secret. That object is persisted, broadcast to the panel and stamped on
every receipt, so a token in it would be in all three.

Tokens live in `storage.session`, and it is worth being honest about what that
buys: not encryption - an extension is not a secret store - but LIFETIME. It is
in-memory and cleared when the browser closes, so a bearer credential is not left
on disk in the profile directory. The cost is re-entering it after a restart.

There is no read path. The background answers `deployment/get` with a boolean per
kind and there is no message that returns a value.

**The CORS header was the trap.** `authorization` is not a CORS-safelisted
request header, so a cross-origin POST carrying it triggers a preflight, and a
preflight that does not name it in `Access-Control-Allow-Headers` FAILS. The
extension would see a bare "Failed to fetch" with nothing in the server log,
because the POST never arrives - the identical silent shape as the
private-network-access header this server already carries a comment about.

### No silent fallback, enforced by having one writer

`PlanError.kind` was added because the alternative was matching error strings,
and a string match deciding whether to offer somebody a switch to a cloud
provider is not a defensible way to make that decision.

Only `transport` - not reached, or 5xx - raises the prompt. Two exclusions carry
their weight:

- `refused` is OUR egress gate firing. Offering to switch backends because our
  own redaction check blocked a payload would be the worst possible response.
- `protocol` covers 401 and 403. The server is UP and said no. "Private server
  unavailable, use cloud instead?" would be a wrong diagnosis attached to a
  data-sharing decision.

And what a transport failure DOES is emit an event. `deployment/select` is the
only writer of the selection, and nothing in the failure path calls it; the panel
renders the alternatives as buttons and a human clicking one arrives there. That
is why it is a guarantee rather than a policy.

`alternativesTo` offers `on-device` always and the others only when configured -
offering a switch to an unconfigured backend is offering a second failure.

### The receipt: no line may be a constant

The tempting version of a privacy receipt prints

    RAW PII        NOT SENT
    RAW SCREENSHOT NOT SENT

with both lines hard-coded, because the architecture says they are true. That
card would keep saying it after a regression and would be the LAST thing anyone
doubted - a UI asserting a property it never measured is worse than no UI.

So `EgressClaim` has four states and `not-checked` is used. A step that died at
capture never ran a gate; reporting "NOT SENT" there is technically true and
epistemically worthless, because it is equally true of a step that did nothing.
`verified-absent` carries `checkedFields`, because a scanner that walked nothing
also reports nothing found.

`stayed-on-device` is its own state rather than `verified-absent`, and collapsing
them would be the receipt's worst lie in either direction: one means a check ran
over an outbound payload, the other means there was no outbound payload.

`modelAnswered` comes from `PlanResponse.modelId` and is kept separate from
`deployment.model`, which is what the operator typed. When they disagree the
measurement wins and both are shown - a settings field silently overriding a
measurement is how a report describes a model that never ran.

Post-action verification is reported as `changed`/`unchanged`, never `verified`.
A DOM fingerprint proves something moved, not that the right thing moved; on a
page with a clock in the header it moves every step regardless. The comparison
already existed and drove `no-progress`; what it did not do was SAY anything, so
a step where the model claimed success and the page did not move looked identical
to one where both were true until two stalls later.

Plan-only reports `execution: WITHHELD`. `ok: true` alone reads as "the click
landed" in the one mode whose entire purpose is to touch nothing.

### Two things the tests got wrong first, and what they taught

**jsdom + undici.** The first version of both new integration suites carried
`// @vitest-environment jsdom`. Under jsdom the `AbortController` comes from
jsdom while `fetch` comes from undici, which rejects the foreign signal:

    RequestInit: Expected signal ("AbortSignal {}") to be an instance of AbortSignal

Every request failed as a TRANSPORT error - which is exactly the failure mode the
suite exists to distinguish from a real one. A leak test would have passed
because nothing was ever sent. Both files now run in `node` with
`ensureDomParser()` supplying the single DOM API the pipeline needs.

**A vacuous "must not contain" suite.** The guard asserting the fixture literals
are genuinely present in the source page used `JSON.stringify(fixture.html)` and
got `{}` for every fixture, so it passed by finding nothing anywhere. That is
`Untrusted<T>` working exactly as designed - the payload sits behind a
module-private symbol and symbol keys do not serialise - and it is the property
that stops page text leaking by accident. Reading it deliberately needs
`unsafeUnwrap(…, 'test-fixture')`.

Both are the same failure the boundary tests keep re-learning: a guard that
cannot see its subject is not a guard. The new network-exit pin in
`boundaries.test.ts` was therefore probed in both directions - a `fetch(` added
to `panel/selectors.ts` fails it, and removing it passes again.

### The network-exit pin

A second `fetch` in the extension would be a second way out with no gate on it,
and it would be easy to add without anyone noticing - a "cloud client" that
seemed to need its own transport, a telemetry ping, a model-list lookup. So the
list is pinned exactly the way `unsafeUnwrap` and `permissions.request` are.

Three sites beyond `client.ts` are on it, each reviewed rather than excluded by a
heuristic: `backend.ts` (GET /health, no context), `browser-codec.ts` (a `data:`
URL, which has no host) and `yunet-backend.ts` / `transformers-env.ts` (packaged
model weights via `browser.runtime.getURL` - a file read wearing `fetch`'s API).
"It only fetches extension-local URLs" is a claim about a runtime value and this
scanner can only see the call, so naming them is the honest version.

### Verified

`npm test` - 1016 tests, up from 916. `npm run test:built` - both browsers build
and 56 emitted-artifact checks pass, including `sidepanel-smoke`, which mounts
the REAL emitted panel chunk and would catch a TDZ error the typechecker cannot.
Package unchanged at 33.61 MB.

Against the real `server/main.ts` on port 8791 with `AGENT_AUTH_TOKEN` set:
startup reports `auth: ON` without printing the token; `/health` answers
unauthenticated with `auth: true` and no token; `/plan` returns 401 for a missing
AND a wrong token with byte-identical bodies (distinguishing them tells an
attacker their format is right); the right token gets through; the preflight
lists `content-type, authorization`; and the token appears zero times in any
response.

One `profile-pii` context, sha256 `4f031ec3922ddcc9`, 2452 bytes, driven through
all four deployments against that server: shape gate PASS, PII re-scan PASS over
11 fields, all five ground-truth literals (aadhaar, PAN, email, mobile, IFSC)
absent from the body, every backend healthy, every plan parsed and validated, and
no token in any descriptor.

### What an adversarial audit of the above found

The deployment work was reviewed by four independent adversarial passes -
egress bypass, credential leakage, silent fallback, correctness - each finding
verified by a separate agent instructed to default to refuted. 32 claims, 20
confirmed, 12 refuted. The confirmed ones are recorded here because several were
in code written the same day with comments explaining why it was correct.

**Tokens were keyed by backend KIND, and that was a live credential leak.**
There is one `cloud` slot. Point it at provider A, set A's token, later retype the
same row as provider B: the token survived the endpoint change, and the panel's
own success path calls a health check immediately - so A's bearer credential was
in B's access log before a single agent step ran, with the panel showing nothing
worse than "Access token: set for this backend". Now keyed by ORIGIN and resolved
THROUGH the endpoint on every read, so a re-pointed row simply has no token. The
old by-kind stored shape is refused on rehydration rather than migrated, because
migrating it would reintroduce exactly the mis-binding.

**`server/origin` guessed which deployment an endpoint belonged to.** It derived
the kind from the URL and the current selection, then wrote both the endpoint and
the selection - from a bare text box with no kind selector. With `private`
selected and an org server configured, pasting a public vendor URL REPLACED the
org endpoint, kept `private` selected, and every later step sent the sanitized
context to a third party while the panel, the descriptor and the copied privacy
receipt all said "Private Organization Server". The audit trail named the wrong
class of destination, and the org's own URL was gone from storage. It could also
promote `on-device` to transmitting, from a button labelled Grant.

That path is now loopback-only - a localhost origin is the `local` backend and
cannot be anything else - and https must be entered against a kind the user
names. The panel's box is relabelled "Local agent server" to match.

**Switching backends mid-run changed nothing except the label.** `runTask` builds
ONE backend and one `StepInput` and hands both to `runAgentLoop`, which reuses
them for up to eight steps. A user who got nervous mid-task and clicked
"On-device (no network)" saw the panel switch and the receipt stamp on-device
while the loop kept POSTing to the cloud it started with. That is the audit trail
lying in the most damaging direction, and it defeats the most intuitive way to
stop egress.

Refused rather than made live. Rebuilding the client per step is easy; making
`allowedOrigins`, `transport`, `screenshot` and the reported `backend` follow it
is not, and a run whose destination changes halfway is an ambiguous thing to
record. Stop is the answer and Stop already works. The three deployment commands
refuse while a loop runs and the panel disables the controls.

**Rehydration is the one automatic selection change, and it was silent.** An
off-device backend whose origin is no longer granted is demoted to on-device -
correct, and the safe direction, since the alternative is a run that dies at the
plan stage with a host-permission string. But silence there is exactly the
failure the rest of this feature exists to prevent. It now reports itself the
first time a panel is listening (rehydration runs at module scope, before any
panel exists, so it is held and announced rather than broadcast on the spot).
`deployment/select` applies the same permission rule, which it did not - so
revoking an origin without restarting left the backend selectable through the
"use this instead" button and the next run died inside the HTTP client.

**The panel's proof and receipt disagreed on a step that failed early.**
`frame/captured` reset the receipt but spread `...state.privacyGate` and
overwrote only `capture` - and nothing else cleared it, because `session/start`
is emitted by no production path. So step 2 could capture a frame, die at redact,
and the receipt card would correctly say `not-checked` everywhere while the
Privacy Gate section directly above it said "Sanitized context delivered to
qwen2.5vl:3b" for a step in which nothing was sanitized and nothing was sent. Two
sections of one panel disagreeing, with the reassuring green one being wrong.

Three more of the same family: a step failing BEFORE `frame/captured` sealed the
PREVIOUS step's measurements under the new step number (fixed by sealing only a
fresh, started accumulator - `e2eMs === null && domCaptured`, deliberately not a
step-number comparison, since the panel derives its own numbering and a panel
opened mid-session starts at 0 against an event that says 5);
`context/transmitted` printed "SENT (0 bytes)" when it had never seen
`context/sent`, asserting both that a transmission happened and that it was
empty; and `page/verified` matched on step number alone, which restarts every
run, so it patched receipts belonging to a previous task.

**Two pre-existing bugs the audit surfaced, fixed because they are in the same
files.**

`ANY_PLACEHOLDER_RE` carries `/g`, and `sanitize.ts` called `.test()` on it three
times per element - name, group name, value. `.test()` on a global regex resumes
from `lastIndex`, so the answers alternated true/false/true regardless of the
input. `DataAtom.redacted` is what tells the server which fields were protected,
so roughly half of them were wrong on every page. Now `hasAnyPlaceholder`, a
separate non-global literal - resetting `lastIndex` at each site works and has to
be remembered at each site, which is the property that failed.

`applyElementBudget` sheds the screenshot as its second escalation lever and sets
`screenshotDropped: true`, and that flag changed only the token ESTIMATE:
`buildSanitizedContext` still assigned the image and the planner still sent it.
The accounting was wrong in the direction that overfills the window, and
`budget.screenshotDropped` - the field a reviewer reads to confirm no image was
sent - said the opposite of what happened.

And `metrics.counts.steps` was incremented by both `action/executed` and
`step/done`, so the panel's Steps stat was exactly double reality. The test that
covered it emitted only `action/executed`, so it saw 2 for 2 actions and pinned
the bug; half of a doubled number looks plausible, which is why it stood.

**What was left as a documented gap rather than fixed.**

`url` is exempt from the PII re-scan. `sanitizeUrl` keeps origin + pathname, and
a path segment like `/user/9876543210` matches the phone rule - so scanning it
would fail the step closed on ordinary pages. Refusing a page for having digits
in its URL is a worse failure than the one it prevents, and query and fragment,
where a token or an email actually lives, are already stripped.

`clarifications[].question` is now scanned - the first version of the gate
excluded the whole `Clarification` as user-authored, and only the ANSWER is. The
QUESTION is composed by `detectAmbiguity` from the page's own accessible names.
What is NOT fixed is that `renderPrompt` places the ANSWERS block outside the
data fence: measured, FENCE_CLOSE at index 4131 and the question at 4236. Its
provenance comment says "user-authored", which is half true. The names have been
through `toDataAtom` so fence tokens are already defanged, and the same file
already renders `ALREADY DONE` with page-derived names after the fence, so this
is a pre-existing prompt-structure question rather than something this change
introduced. Recorded, not quietly widened into.


## Cloud-first, zero-configuration - without moving the boundary

The ask was "open the extension and it works": no backend picker, no model
download, no configuration. Three parts of that were straightforward and one was
a misunderstanding worth recording.

### The vision model cannot move to the server, and did not need to

The first version of the request was to run the vision model in the cloud. It
cannot be: face detection needs the RAW pixels, so a server doing it receives the
unredacted screenshot - the one thing the whole architecture exists to prevent.
There is no variant of server-side detection that keeps the guarantee.

But the real complaint was about a BUTTON, not about where the model runs. And
the button turned out to be gating nothing:

    // runtime.ts, before
    * It requires an initialised runtime even though decoding needs no model,
    * because `bake` requires one.

`bake` is `#bakeFn(image, ops, quality)` - `applyPixelOps` over an RGBA buffer,
a downscale, an encode. It reads neither `#backend` nor `#config`. It called
`#ready()` for no reason at all, and `retain` called it *because bake did*. The
circle made the weights a prerequisite for the default configuration, which -
vision being off by default from measurement - never loads them. Every step
refused until somebody pressed Load model and waited for a WebGPU adapter that
then went unused.

`detect` still requires init, because `detect` is the call that reads the model.
The load now starts on its own when the panel opens with vision ON, and
`ensureModelLoading` deliberately does NOT retry a failed load: it would fail
again for the same reason, and retrying on every panel open spends a battery
rediscovering that. The button survives as a retry rather than a gate.

The old comment justifying manual loading - "it reads ~26 MB off disk" - was
written for `yolos-tiny`. The model is YuNet: 232,589 bytes, 30.3 ms p50.

### AGENT_ORIGIN: one build variable, three effects

`AGENT_ORIGIN=https://... npm run build` bakes the origin into the bundle,
declares `host_permissions` for that single host, and seeds the stored deployment
to `cloud` on FIRST RUN ONLY. Unset, the build is the old behaviour exactly.

Declaring a host permission required loosening a test that read
`expect(host_permissions).toBeUndefined()`. Its stated intent was "a wildcard
would let this extension read every page" - and a host permission for one named
https host reads no page at all: page access is still `activeTab` plus a
deliberate per-site grant. So the rule that matters was never "no host
permissions", it was "no wildcard, and exactly one". The test now asserts that,
by re-invoking the config with the variable set rather than trusting the default
build - the vacuous-guard failure this file keeps re-learning.

First run only, and that is load-bearing: re-applying it on every service-worker
wake would silently undo a user who had switched to on-device, which is a
data-sharing setting.

The ENDPOINT is baked and the TOKEN is not. A credential in a bundle is a
published credential.

### The free tier sleeps, and saying so is the whole fix

A free instance stops after ~15 minutes and takes tens of seconds to wake. Both
a sleeping host and a dead one fail a probe, and reporting them identically tells
a user their server is down at the exact moment it is coming up.

`BackendHealth.waking` splits them on the DOMException name that
`AbortSignal.timeout` actually produces: timed out (accepted the connection,
answered nothing) versus refused (nothing listening). The panel renders
"Connecting to AI server..." for the first and "Unavailable" for the second, and
a plan taking longer than 2.5 s emits a notice naming the endpoint - silence is
what reads as a hang, and a hang is what makes someone reach for a different
backend.

Nothing retries and nothing switches. The step timeout is already 60 s, which
covers a cold start; the alternatives stay buttons.

Finding the timeout path required widening a regex. `/failed to fetch/` is what a
browser says; undici says `fetch failed` - different word order - so the friendly
message worked in every browser-shaped test and produced a bare "fetch failed"
anywhere else. Caught by a test that ran in Node, which is exactly why that suite
runs in Node.

### The provider's error body was being forwarded verbatim

A live probe against OpenAI with a bad key returned, through /plan, to the
extension:

    Incorrect API key provided: sk-fake-************************0000

OpenAI masked it. That is OpenAI's courtesy, not our guarantee - this server is
meant to work against any OpenAI-compatible endpoint, and the proxy that echoes
the Authorization header back in a 400 exists. `maskCredentials` now scrubs key
shapes before the detail is forwarded; the useful part (a bad model id, an
over-length context) survives, because losing it turns a five-second fix into a
hunt.

The same probe exposed a second thing: every planner exception became
`retryable: true`, so an invalid API key was retried once per step until the loop
hit its ceiling - eight identical failures and a stop reason that blamed the
page. `ModelEndpointError` carries the upstream status, and a 4xx is a
configuration fault rather than something to try again.

### Verified

`npm test` 1073, `npm run test:built` 57, both browsers build.

Against a live server configured exactly as Render runs it (PORT=10000,
OPENAI_API_KEY, AGENT_AUTH_TOKEN, RENDER=true): binds 0.0.0.0:10000; /health
reports `server: ok`, `vlm: {configured: true, model: gpt-4o-mini}`,
`auth: true`; /plan answers 401 / 401 / 200 for missing / wrong / correct token;
and the two secrets appear ZERO times across the startup log, the health body and
a 401 body.

A cloud build emits `host_permissions: ["https://...onrender.com/*"]` on BOTH
browsers, `content_scripts: []`, no key-shaped field in either manifest, the
origin present once in the background bundle and no `sk-` anywhere in any chunk.

NOT verified: Render itself. Nothing here has been deployed.


## gpt-5.6-luna as the cloud model, and asking rather than assuming

The model id is now `gpt-5.6-luna`, pinned in `render.yaml` and defaulted in
`server/main.ts`. Three things came out of making that change that are worth
recording, because two of them were bugs and one is a rule.

### The model id is configuration, so the server ASKS whether it resolves

Nothing in this repository can confirm a provider's catalogue from a string. The
id was supplied as configuration and is treated as such - it is used verbatim,
everywhere, with no substitution on any path.

What the server does do is `GET /v1/models/<id>` once, after `listen`, and report
the answer in the startup log and on `/health` as `vlm.verified`. Three states,
and the third is the point:

    true   the provider lists it
    false  the provider was asked and said no
    null   the question could not be asked - no catalogue endpoint, unreachable,
           or a rejected key

`null` is NOT a synonym for fine, and it is deliberately distinct from `false`.
A rejected key says nothing about the model id, and reporting it as "model not
found" would tell somebody their correct configuration is wrong.

The probe never blocks startup, never retries, and never picks a different
model. That last is the rule: if a failed check could substitute a fallback, a
typo would produce a working demo powered by something nobody chose, and every
receipt line naming the model would be wrong while looking right. A verification
failure is a REPORT.

Measured, with a deliberately bad key:

    [agent-server] planner: gpt-5.6-luna at https://api.openai.com/v1/chat/completions (authenticated)
    [agent-server] model check: gpt-5.6-luna - UNKNOWN (the API key was rejected, so the model could not be checked)

which is the correct answer to that input, and is the line that would have said
NOT FOUND for a bad id.

### Importing server/main.ts started a real server

`createAgentServer(...).listen(...)` ran at module scope. So a test importing
`selectPlanner` - a pure function of an env object - bound port 8787 as a side
effect, and the SECOND test file to import it died with EADDRINUSE: a failure in
one file caused by an import in another, which is about as confusing as a test
failure gets. A passing run also left an agent server listening for as long as
the worker lived.

Now `start()` is a function, called only when the module is the entry point.
Compared through `pathToFileURL(process.argv[1])` rather than by string, because
argv carries a filesystem path and `import.meta.url` is a URL - on Windows those
differ in separator AND in drive-letter case, so a string compare works on Linux
and silently never matches here. That failure mode would have been "starts on
Render, starts nowhere locally", found at the worst possible moment.

### An apiKey FIELD broke a property the code already had

The verification probe needs the key. Putting `apiKey` on `PlannerChoice` was
the obvious way, and the existing test `NEVER puts the key in the description`
caught it immediately - it asserts `JSON.stringify(choice)` carries no
credential, and `PlannerChoice` had always been safe to log whole.

It is a closure now: `verify: (() => Promise<ModelVerification>) | null`. Same
shape as `HttpClientOptions.authToken` on the client, for the same reason - a
function holds the secret in a scope nothing can enumerate, and
`JSON.stringify` of a function yields nothing at all.

A test asserted the wrong thing for about ten minutes: that `choice.apiKey`
EQUALS the key. Encoding a leak as a requirement is how a guard gets weakened by
whoever hits it next, which this file has recorded happening before.

### What actually reaches the provider

`tests/server/model-config.test.ts` asserts the four things that are only
meaningful together, on one real request body built from the `checkout` fixture:

  - `model` is `gpt-5.6-luna`, verbatim
  - an `image_url` part exists, and it is the output of `bakeRedactions()` -
    the sole constructor of the nominal `BakedScreenshot`, so an image reaching
    the request at all is one that went through redaction
  - the sanitized text is present
  - the fixture's card number and email appear NOWHERE in the body, and neither
    does the key, which travels as a header

Plus the fail-closed consequence: a context whose screenshot was refused
upstream plans TEXT-ONLY and does not reach for a second capture.

### Security sweep

Zero references to `api.openai.com` or `OPENAI_API_KEY` anywhere under `src/`.
Zero in either emitted bundle, along with zero key shapes and zero occurrences
of the model id - the extension does not name the model, because which model
answers is the server's business and the extension consumes a `PlanOutcome`.

Every `fetch(` in `src/`: two in the agent client (the plan request, gated, and
the health probe, which carries no context), one in `agent-server/server/**`
which is never bundled, and three that read `data:` or `chrome-extension:` URLs
for frame decoding and packaged weights. Exactly one carries a context.

### Verified

`npm test` 1082, `npm run test:built` 57, both browsers build.

Live, configured as Render runs it: binds `0.0.0.0:PORT`, `/health` reports
`{"vlm":{"configured":true,"model":"gpt-5.6-luna","verified":null}}`, `/plan`
answers 401 without a token and 200 with one, and both secrets appear zero times
across the startup log, the health body and a refused plan body.

NOT verified: any real call to gpt-5.6-luna. Every test uses an injected
transport and a fake key; nothing in this repository has spoken to OpenAI.

---

## Local data analysis, and two quadratics that had been there all along

The ask was calculations, trend detection, prediction and table analysis, under
one rule: *raw user data stays protected; computers calculate, the model
reasons.* The design follows from the rule rather than from the feature list.

### Why the arithmetic is not the model's job

A 100,000-row table is 17.7 MB of HTML and roughly 150,000 tokens. Putting it in
a prompt is both the privacy failure this project exists to prevent and the most
expensive available way to get a worse answer, because a language model asked to
average 100,000 numbers does not average them. So `analysis/` computes on the
client and emits about forty numbers.

Measured over the generated datasets, the payload is effectively flat:

| dataset | rows | PII cells removed | bytes out | redact | analyse | gate | leak |
|---|---|---|---|---|---|---|---|
| telemetry-100 | 100 | 100 | 9,299 | 62 ms | 9 ms | OK | none |
| telemetry-1000 | 1,000 | 1,000 | 9,686 | 364 ms | 73 ms | OK | none |
| telemetry-10000 | 10,000 | 10,000 | 10,390 | 3,342 ms | 633 ms | OK | none |
| telemetry-100000 | 20,000* | 20,000 | 3,029 | 34,388 ms | 4,711 ms | OK | none |
| sales-100000 | 28,571* | 57,142 | 1,967 | 28,781 ms | 3,538 ms | OK | none |

\* `too-many-cells`: the ceiling bit and said so. A partial read is never
reported as a whole one.

A hundred times the data for 1.1x the payload. `test-site/verify-analysis.ts`
greps the exact outbound bytes for planted literals; NO LEAK is a search of the
serialised payload, not an assertion about intent.

### The structural guarantee

`AnalysisShape` has no field that can hold a cell value. Not "we are careful not
to put one there" - there is no `rows`, no `sample`, no `examples`, no
`rawValues`. An outlier is a ROW POSITION and a z-score. The only page text that
survives is a column HEADER, and it takes the same route a button label does:
`markUntrusted` then `toDataAtom`, which neutralises control and bidi characters,
defangs fence tokens and caps length.

`contracts/egress.ts` re-derives that at runtime, because the nominal type stops
being a fact at the first message boundary. It validates field NAMES against a
pinned list and enum VALUES against a pinned map - so `method: "the max row was
Yash, 5000"` is refused even though `method` is an allowed field. It refuses the
whole analysis rather than stripping the bad part: a gate that repaired a payload
would turn "we found a leak" into "we sent something".

### What the measurement found instead

The feature was finished and the verification would not complete. The analysis
engine was never the problem - it was 58 ms while `redact()` was 378,745 ms on
the same 1,000-row page.

Two separate quadratics, neither introduced here, both invisible to 1112 passing
tests because every fixture in this repo is a page of a few dozen elements:

1. `canonicalPath` materialised `parent.children` - a live HTMLCollection - once
   per level per call, and `resolveDomPath` handed a deep `:nth-of-type` chain to
   a CSS engine that evaluates it right-to-left. One `querySelector` cost 307 ms
   on a 1,000-row table, and `redact()` called it once per detection group.
2. `mergeDetections` deduplicated with `kept.findIndex(...)` inside the loop over
   candidates - 5 billion pair comparisons at 100,000 detections, each a string
   compare of two path chains.

| stage | 10,000 rows | 100,000 rows | growth |
|---|---|---|---|
| `scanDom` before | 3,021 ms | 29,788 ms | 9.9x |
| `mergeDetections` before | 1,035 ms | 1,767,327 ms | **1708x** |
| `mergeDetections` after | 7 ms | **66 ms** | 9.4x |
| whole `redact` before | 6,991 ms | 334,885 ms | 48x |
| whole `redact` after | 3,286 ms | **36,633 ms** | 11.1x |

### Why the fixes are equivalences rather than approximations

Both are caches, and a wrong cache here is not a slow bug - it is a DOM path that
resolves to the wrong element, gets clicked, and is reported as success. So each
is pinned by the strongest available check.

`DomIndex` is valid only across a pass with no structural mutation. It is never a
module-level cache; each caller creates one and scopes it to a pass that can be
shown mutation-free, and the removals loop in `redact()` is deliberately passed
none. `dom-index.test.ts` asserts the indexed and unindexed paths are
byte-identical and resolve to the same element, sampled ACROSS the table - the
first version of that measurement sliced the first 500 cells, which all live in
the first ~60 rows, and measured as linear when it was not.

The merge index is checked against the rule it replaced: `dom-index.test.ts`
runs the original O(n^2) predicate as a reference implementation over randomised
colliding detections and compares the surviving id set element for element,
across five seeds. Every hash hit is additionally re-verified with `sameTarget`
itself, so drift between hash and predicate can only cause a MISSED merge, never
an invented one - an invented merge discards a detection, and a discarded
detection is a value that never gets redacted.

### Honesty in the output

Two places where correct arithmetic can still produce a dishonest result.

The PROMPT labels every figure OBSERVED / CALCULATED / PREDICTED, and rule 9
forbids the model computing a new statistic. Having been handed the answers the
failure mode inverts: instead of failing to average 100,000 numbers, a model
produces a neighbouring number that was never computed, in the same voice as the
real ones. `nRedacted` travels with every mean for the same reason.

The RECEIPT distinguishes four outcomes, because "0 raw records transmitted" is
equally true of a step that analysed 100,000 rows and a step that did nothing.
Writing the test for it found a real defect: `refuse()` returned `columns: []`,
so `all-columns-redacted` - the redactor having removed every column, which is
the pipeline working - rendered as "Analysis blocked" above "0 column(s), 0
value(s) excluded". A claim with its own evidence zeroed out reads as a crash.

### Verified

`npm test` 1131 across 59 files, `npm run test:built` 57, both browsers build,
33.64 MB. All eight synthetic datasets pass the gate with no planted literal in
the outbound bytes.

NOT verified: any of this in a real browser. Every number above is Node with
jsdom, where an 8.9 GB heap for a 17.7 MB page is jsdom materialising 1.1 M nodes
and not something the extension does - it never parses, the browser's DOM already
exists. The 100,000-row browser cost is unmeasured and must not be inferred from
these figures.

### What an adversarial review found afterwards

The layer above shipped green: 1131 tests, both builds, every synthetic dataset
through the gate with no planted literal in the outbound bytes. A five-dimension
adversarial review of the same diff - each finding independently verified by a
second agent whose default was to refute it - found **nine real defects**. One
was a leak in the merge optimisation described above; the rest were in the new
analysis code.

**Three were disclosure**, and all three published an actual cell:

- The header row was `first all-<th> row ?? rowEls[0]`. On a table with no header
  - most hand-written HTML - the first DATA row became the header and its cells
  became `label` DataAtoms. A label is the ONE string this module may emit, so
  real values left through the single field the egress gate exists to pass. The
  row was also dropped from every statistic.
- `summarize` had no minimum n. At n=1 min, max, mean, median, sum, p25 and p75
  are all the single cell, published beside an `n` that says there was one row.
- `forecastNext` returned `values[n - 1]` under `method: 'last-value'` - the last
  cell, verbatim, labelled a prediction. Neither a prediction nor an aggregate.

**Six were honesty** - no leak, but a number presented as something it is not:

| defect | what it claimed | what it was |
|---|---|---|
| `1.96 * se` with n-2 df | a 95% interval | ~70% at n=3 (t is 12.71) |
| perfect fit | interval `[next, next]` | zero uncertainty from 5 rows |
| moving-average `confidence` | goodness of fit | the r2 of the fit just REJECTED |
| `confidence` | a probability | r-squared, unlabelled anywhere |
| `direction` | total change | slope x ROW COUNT, not x the x-span |
| `momentum` | acceleration | later window's LEVEL, so every rising series read `accelerating` |

Plus two counting bugs with the same shape as the `classify()` one: cells that
were neither empty, redacted nor numeric were tallied nowhere (a 1,000-row column
with 200 reading "N/A" reported `n=800, nMissing=0, nRedacted=0` - every row
parsed), and `N/A` counted as a categorical value pushed mixed columns under the
0.8 numeric threshold so their numbers were discarded entirely. And European
decimals: `"1.234,56"` parsed as `1.23456`.

`recentHigh` and `recentLow` were removed rather than fixed. They were window
extremes - real cells, and worse than the column's global min/max because naming
the window narrows the rows they came from to the last third of the table - while
`movingAverage` and `volatility` already carried the useful part.

**What this changes about the claim.** `min` and `max` are cell values by
definition, and pretending otherwise would be the dishonesty this file exists to
avoid. The claim is now stated as: aggregates leave, two of the aggregates
coincide with real rows, and no summary at all is emitted below five values
(`MIN_VALUES_TO_SUMMARISE`), because below that the summary IS the data.

**What this says about the tests.** The equivalence test written for the merge
optimisation passed on five seeds and missed the leak, because its generator gave
every detection a `domPath` - and the only way a kept entry can GAIN one is to
have started without one. A fuzzer that cannot reach a state cannot test it. Nine
of the ten remaining findings lived in code paths no fixture exercises: tables
without `<th>`, columns of one value, columns of "N/A", de-DE decimals.

### Verified after the fixes

`npm test` 1147 across 60 files, `npm run test:built` 57, both browsers build,
33.64 MB. All eight synthetic datasets pass the gate with no planted literal in
the outbound bytes; the two 100,000-row files report `too-many-cells` having
analysed 20,000 and 28,571 rows.

---

## The website

A public marketing site at `site/`, for three audiences on one page:
individuals, private companies, and government organisations such as ISRO.

### The stack is hand-written, and the named inspirations were not adopted

The brief named liquid-glass-js, shadergradient and react-three-fiber. All three
were studied against their source and none was adopted. That is a deviation from
what was asked for, so the reasoning is recorded rather than assumed:

- **react-three-fiber.** Measured, not looked up: the r3f stack (three + r3f +
  react + react-dom) is **312.6 KB gzipped** against **2.8 KB** for the same two
  visuals hand-written - a fullscreen shader gradient and one lit object. three
  alone is 134 KB gz to draw a fullscreen quad, because a gradient uses none of
  what three is made of. It also forces React 19 exactly (r3f v9 bundles
  react-reconciler and reads React's private client internals, so `preact/compat`
  cannot satisfy it) into a Preact repo. And `drei` would have a *privacy* site
  fetching HDRIs from a GitHub CDN proxy and the Draco decoder from Google by
  default. Someone will open devtools on this site precisely because of what it
  claims.
- **shadergradient.** React-only, with three.js as a hard peer dependency, so it
  was ruled out at the manifest level. Its `plane` preset is reproduced instead:
  the mesh exists only to turn one noise sample into a surface a light can hit,
  and a fragment shader gets there directly by keeping the scalar height field,
  synthesising the normal from `dFdx`/`dFdy` (free, core in GLSL ES 3.00) and
  lighting it with one Blinn-Phong term.
- **liquid-glass-js.** Rejected on a technical fact rather than on size: it
  rasterises the page with `html2canvas` once and refracts that **static
  snapshot**. This page's backdrop is a moving gradient, so every panel would
  hold a still frame of it. It also composites its contents in a shader, so real
  HTML cannot live inside a panel and stay selectable. The technique used
  instead - `backdrop-filter: url(#f)` over an SDF-derived displacement map - is
  ~60 lines, refracts the LIVE backdrop, and holds ordinary DOM children.

Result: **148 KB of self-hosted fonts and about 40 KB of everything else**, no
dependencies, no build step, and no third-party request. The footer counts
requests with a `PerformanceObserver` and invites the reader to check; the CSP in
`render.yaml` sets `connect-src 'none'` so that is enforced rather than promised.

### `@supports` cannot gate the refraction, and this is a trap

`CSS.supports('backdrop-filter', 'url(#x)')` returns **true in Chrome, Firefox
and Safari** - `url()` is valid `<filter-value-list>` grammar, so all three
parse it and only Chromium applies it. An `@supports` guard here always passes.
Firefox is excluded by `-moz-appearance` and Safari by `-webkit-hyphens`, by
name: Safari is worse than unsupported, with an open WebKit bug reporting the
GPU process crashing repeatedly for as long as the page is open. The blur also
lives in a separate declaration from the `url()`, because a filter list is ONE
value and an engine that cannot honour one part discards the whole list.

The refraction is garnish and runs on exactly two surfaces. The blur-and-bevel
panel is the design that gets screenshotted. If the refraction were load-bearing
the design would be wrong.

### The claim ledger

`site/assets/claims.js` is the single source of truth for every figure on the
page. Each carries a state (`measured` / `tested` / `unverified` / `gap`), the
command or file that produced it, and a caveat - several are actively misleading
without one. `site/check-claims.mjs` asserts the static fallback text in
`index.html` matches the ledger, so the no-JS copy cannot drift from the source
of truth, and it runs as the deploy's build command.

**Writing this site required correcting this repository's own documents.** The
research found statements false in BOTH directions: `README.md` still says
"Status: scaffold", while the tail of CLAUDE.md's known-gaps log is superseded
history (it names `gpt-5.6-luna` as the cloud model, 59.95 MB as the package
size, and says the content script is registered nowhere). Anyone writing copy
from the docs alone would publish falsehoods. Every figure on the site was taken
from code, from a command actually run, or from a live probe of the deployed
health endpoint.

### Two content bugs found by rendering it

Both were the exact failure the site argues against, committed by the site:

1. **The corridor recoloured the redacted values instead of replacing them.**
   Station 4 displayed `4111 1111 1111 1111` in amber while the caption beside
   it said the value had been removed. Now the text is genuinely substituted for
   the marker.
2. **The signature moment had fabricated arithmetic.** The two sixteen-digit
   numbers are checked with a real Luhn implementation whose accumulator drives
   the on-screen readout - `4111...` sums to 30 (valid), `1234...` sums to 64
   (not a card). Hardcoding those was less work than computing them and would
   have been the single most checkable falsehood on the page, aimed at the one
   audience recruited to check figures.

### What the site deliberately does not say

`do-not-claim` lists were produced alongside the content and enforced: no
"no data ever leaves your device" (a sanitized context does leave, on three of
the four deployments); no "100% accurate" without its denominator (nineteen
planted values on six pages this project wrote itself); no "on-device LLM" (the
offline planner is a keyword heuristic and the only model on the device is a
232 KB face detector); no implied ISRO endorsement; no claimed audit or
certification; and the amazon.in run is described as the model reporting
completion, next to the test-lab run where the page's own console confirmed it.
Those two are rendered in deliberately different colours.

### Verified

`npm run site:check` passes (9 figures match, 18 claims all sourced and
caveated). Rendered in Chromium at 1440x900, 1280x800 and 390x844: zero console
errors, WebGL live, 2 refracted surfaces, no horizontal overflow on mobile, the
sticky stage correctly degrades to stacked cards below 820px, nothing left
invisible under `prefers-reduced-motion`, all 9 static figures readable with
JavaScript disabled, and 10 network requests - all first-party. `npm test`
unaffected: 1,169 across 61 files.
