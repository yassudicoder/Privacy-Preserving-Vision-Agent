# SIH26171 Agent Test Lab

A controlled, offline website for driving the SIH26171 privacy-preserving
vision agent extension.

**This is not the product UI.** It is a fake shop with fake customers, planted
with fake PII, built so that one agent step can be watched from end to end: DOM
snapshot → detection → redaction → sanitized context → action → visible change
on the page.

Every name, email, phone number, address, password and card number here is
invented. `4111 1111 1111 1111` is the public Visa test number. Nothing on this
page reaches a network — there is no `fetch`, no `XMLHttpRequest`, no form
`action`, no external stylesheet, font or image.

---

## 1. Starting it

```bash
npm run test-site
```

Then open <http://localhost:8080/>. For a different port, run the script
directly: `node test-site/serve.mjs --port 8081`.

The server is `node:http`, no dependencies, bound to `127.0.0.1` only.

**Serve it; do not open the file directly.** The extension declares
`http://localhost/*` and `http://127.0.0.1/*` in `optional_host_permissions`,
and `deriveOriginPattern` accepts loopback http. A `file://` page can be granted
neither, so there is no path past `activeTab` and no way to reach a granted
origin at all.

---

## 2. Using it with the extension

1. Build and load the extension: `npm run build:chrome`, then load unpacked
   from `.output/chrome-mv3/`.
2. Open <http://localhost:8080/> and make it the active tab.
3. **Click the extension's toolbar button.** This is what grants `activeTab`,
   and the grant is for the tab that was active at that moment. The background
   pins that tab; the panel does not resolve "the active tab" for itself.
4. The side panel opens (Chrome) or the sidebar toggles (Firefox).
5. Type a goal into the **Goal** field.
6. **Run one step** to watch a single decision, or **Run task** for the bounded
   loop.

For a multi-step run, grant the site origin properly instead of relying on
`activeTab` — paste `http://localhost:8080` into the panel's origin field and
press **Grant**. `activeTab` is revoked by navigation, and an agent loop
navigates itself, so step two of a run can lose the access step one had.

**Load model** is orthogonal. Detection and redaction on this page come
entirely from the DOM scan, so every scenario below works with no model
loaded. The vision half needs images and has its own page - see section 10.

---

## 3. The first test: "Search for laptop"

Type `Search for laptop` into the Goal field and press **Run one step**.

What should happen:

| Stage | Expected |
|---|---|
| Detection | 18 PII detections found on the page |
| Redaction | emails, phones and the card number replaced with `[[PII:…]]` placeholders |
| Context | 63 elements sent, the search box among them as a `textbox` |
| Plan | `type` into `e7`, text `laptop`, `submit: true` |
| Execution | `typed into e7 and submitted` |
| Page | status line reads **Search results for: laptop**, two product cards appear |
| Console | Last action `SUBMIT → search-form → "laptop"`, Execution `SUCCESS` |

If the page changed, the step worked. The Agent Test Console at the bottom
right is the confirmation: it watches ordinary DOM events and reports what the
page actually did, independently of what the extension believes it did.

Verified against the real pipeline — see section 8.

---

## 4. Test scenarios

The nine goals in the page's "Suggested Agent Tests" section, and what the
**on-device baseline planner** does with each. Measured, not predicted.

Ref numbers are ordinals over the interesting elements in document order, so
**adding any image, button or heading renumbers everything after it**. Treat the
`eNN` below as a snapshot; `npm run test-site:verify` reprints the current set.

| # | Goal | Baseline planner | |
|---|---|---|---|
| 1 | Search for laptop | `type e7 "laptop"` → search box | works |
| 2 | Open Laptop Pro | `click e13` → View details for Laptop Pro | works |
| 3 | Add Laptop Pro to cart | `click e14` → Add Laptop Pro to cart | works |
| 4 | Select India as country | `done` | **baseline cannot** |
| 5 | Write a review saying Great laptop | `click e13` — wrong element | **baseline cannot** |
| 6 | Login with the test account | `click e36` → Login | works |
| 7 | Enable the terms checkbox | `click e48` → terms checkbox | works |
| 8 | Go to the profile | `click e4` → Profile nav button | works |
| 9 | Search for headphones | `type e7 "headphones"` → search box | works |

These are single-step outcomes. Across a **Run task** loop the baseline enters
text at most once per goal (`hasEnteredText` in `text-intent.ts`), so a
"search for X" run fills the search box and then stops looking for fields —
it will not go on to fill the payment expiry box or post the query as a review.

The two failures are limitations of the baseline, not of this page, and both
are worth keeping as the comparison a real VLM has to beat:

- **#4** — `LocalPlannerClient` only ever emits `click`, `type` or `done`. Its
  actionable set is `button/link/menuitem/tab/checkbox/radio`, which excludes
  `combobox`. It cannot emit a `select` action at all, even though
  `executeAction` implements one and `#country-select` is in the context.
- **#5** — `textIntent` recognises `search for / look up / find / type / enter /
  query / fill`. "Write" is not among them, so the goal falls through to click
  scoring, where "laptop" matches the Laptop Pro button. Even a recognised verb
  would not help: `typeAction` takes the *first* typeable element, which is
  always the search box. The review textarea is unreachable to this planner.

---

## 5. Why the page is laid out this way

Four structural choices are load-bearing. Changing them will break scenarios in
ways that look like extension bugs.

**`#search-input` is the first typeable element in the document.**
`typeAction` in `local-planner.ts` picks the first element whose role is
`textbox`/`searchbox`/`combobox` and which is not sensitive, disabled or
readonly. It does not choose the *best* field, it takes the first. Insert a text
input above the search section and every "search for X" goal will type into it
instead.

**Navigation is `<button>`, not `<a href="#…">`.**
A hash link changes `tab.url`; `tabs.onUpdated` fires, and the background
detaches the pinned tab with *"the page navigated, which revokes activeTab"*.
A loop would then die on its own navigation. `#hash-link` in section 9 is the
single deliberate exception, kept so that behaviour can be observed on purpose.

**Every product button carries the product name in `aria-label`.**
The planner scores an element's *accessible name* against the goal. A bare
"View Details" scores zero against "Open Laptop Pro". View Details is placed
before Add to Cart in each card because ties are broken by document order, and
opening a product is the safer reading of an ambiguous goal.

**The radios say "Pay by card", never "credit card" or "debit card".**
Those exact phrases match `KEYWORD_RULES` in `dom-scan.ts`; the radio would be
marked sensitive and the baseline refuses to act on anything sensitive. Real
card detection belongs in the payment section, where it is tested properly.

Also: no interactive element is hidden by a CSS class anywhere on this page.
The extension's `isHidden()` understands the `hidden` attribute, `aria-hidden`,
`input[type=hidden]` and an *inline* display/visibility style — not a class. A
class-hidden control would still be handed to the model as though it were on
screen. So the page is one long scroll and everything is visible.

---

## 6. What this page does for the agent

One affordance is worth calling out, because it papers over real extension
behaviour and you should know it is there.

**Attribute mirroring.** `dom-scan.ts` reads form state through
`getAttribute('value')` and `hasAttribute('checked')` — the *attributes*. A
value the agent types updates only the *property*. On an ordinary page the next
snapshot therefore still shows the field empty, and a loop cannot see its own
work. `script.js` mirrors property back to attribute on every `input` and
`change` event, so each step is observable in the next.

This is a property of the test lab, not a fix. On a real site the agent will
not see what it typed. Worth deciding whether that is intended before the loop
is judged on multi-step tasks.

The Agent Test Console is an **observer**. It has no channel to the extension
and never reports success for something it did not watch happen. It records
values from `#login-password`, `#card-number` and `#card-cvv` as a character
count rather than as text — console hygiene, not a second redaction system.
This page implements no privacy logic; the extension does all detection and
redaction.

---

## 7. Stable IDs

| Element | ID |
|---|---|
| Search field / button / form | `#search-input` `#search-button` `#search-form` |
| Search status / results | `#search-status` `#search-results` |
| Product cards | `#product-laptop` `#product-gaming-laptop` `#product-smartphone-x` `#product-headphones` `#product-monitor` |
| Per product | `#view-laptop` `#add-laptop` (and the same pattern for each) |
| Cart / details | `#cart-count` `#cart-contents` `#product-details-title` `#product-details-body` |
| Login | `#login-form` `#login-email` `#login-password` `#login-button` `#login-status` |
| Payment | `#payment-form` `#card-name` `#card-number` `#card-expiry` `#card-cvv` `#payment-check` `#payment-status` |
| Review | `#review-form` `#review-textarea` `#review-submit` `#review-list` `#review-status` |
| Preferences | `#country-select` `#country-selected` `#terms-checkbox` `#newsletter-checkbox` `#pay-card` `#pay-upi` `#pay-cod` `#preferences-status` |
| Navigation | `#nav-home` `#nav-products` `#nav-profile` `#nav-checkout` `#current-section` `#hash-link` |
| Plain-text PII | `#pii-name` `#pii-email` `#pii-phone` `#pii-address` `#pii-reference` |
| Profile | `#profile-name` `#profile-email` `#profile-phone` `#profile-dob` `#profile-address` |
| Console | `#console-task` `#console-last-action` `#console-execution` `#console-page-state` `#console-events` `#console-clear` |

No generated class names anywhere.

---

## 8. Checking the page still matches the extension

```bash
npx tsx test-site/verify-pipeline.ts
```

Runs `index.html` through the real `scanDom` → `redact` → `extractElements` →
`LocalPlannerClient` in jsdom and asserts the invariants above. It prints every
detection, the full element list the server would receive, and the action the
baseline plans for each of the nine goals. Exit code 1 if an invariant breaks.

It is deliberately **not** part of `npm test`: `tsconfig.json` does not include
`test-site/**` and `vitest.config.ts` only collects `tests/**/*.test.ts`, so
nothing here can change what the extension's own suite reports. Fixture HTML in
`src/harness/fixtures/` must be inert (no `<script>`), which is why this page
cannot live there and needs its own checker.

Last run: **12 invariants pass, 0 fail**, including that the outgoing sanitized context
contains none of `yash@example.com`, `TestPass123!`, `4111 1111 1111 1111` or
`9876543210`.

---

## 9. Gaps this page is planted to expose

`verify-pipeline.ts` reports these as `GAP`, not as failures, and tells you if
one ever closes.

- **A date of birth is detected and then dropped.** `date-dmy` carries
  confidence 0.45 in `patterns.ts`; `orchestrator/step.ts` and `redact()` both
  gate at `minConfidence: 0.5`. So `#profile-dob` reaches the redacted document
  as `14/08/1998`. Re-running redaction at 0.4 redacts it — the threshold is
  the cause, not the pattern.
- **The card expiry field is not recognised.** `cc-exp` is absent from
  `AUTOCOMPLETE_PII` and "card expiry" matches no `KEYWORD_RULES` entry, so
  `#card-expiry` is neither detected nor redacted.
- **A password written as prose is undetectable.** The copy of `TestPass123!`
  in the "Detected Test PII" table survives redaction — no pattern can identify
  an arbitrary password string, and it sits in no password field. It never
  reaches the server (a `<td>` is role `generic` and is not carried in the
  context), but it does stay in the page HTML. The `#login-password` *value* is
  correctly emptied.
- **Person names in prose are not detected**, which is the already-recorded
  project gap. "Yash Desai" reaches the server from `#pii-name` and
  `#profile-name`. `#card-name` *is* caught, via its `autocomplete="cc-name"`.

### What the vision model can and cannot contribute

The shipped model is OpenCV YuNet, and it emits exactly one label — `face`.
Everything else index.html plants is unreachable through it: `signature`,
`id-document` and `credit-card` are caught by `IMG_VISUAL_RULES` regexes over
`img` attributes, never by the model.

index.html does carry faces, in three places, and all three are measured:

| Where | Rendered | In model space | YuNet |
|---|---|---|---|
| Two reviewer photos (`alt="Verified buyer"`) | 48 px | ~24 px | **2 faces, 0.799** |
| `#profile-avatar` (`alt="Profile photo"`) | 96 px | ~48 px | **1 face, 0.843** |
| Product photos (laptop, phone, headphones) | 160 px | ~80 px | none — no face in them |

Both figures are from real 1280×800 browser screenshots of this page, scored
through the shipped weights. Note the reviewer photos survive at 24 model
pixels, which is smaller than the 40 px floor measured elsewhere.

The reviewer photos carry neutral alt text, so a `face` on them can only be the
model. `#profile-avatar` says "Profile photo" *and* has `class="avatar"`, so the
DOM rule fires there whether or not the model runs — that one is the
corroboration case, not evidence.

The dedicated, controlled version of this test is section 10.

---

## 10. The YuNet vision test (`vision.html`)

index.html now carries a few faces of its own (section 9), but they are
incidental — small, mixed in with everything else, and one of them trips the DOM
rule. `vision.html` is the controlled version: faces sized for the model,
matched controls, and nothing else competing for the frame.

The vision half is the only part of this project that has **never been run
in a browser** — every YuNet number in `CLAUDE.md` is Node with the shipped ORT
wasm build. `vision.html` exists to change that.

```bash
npm run test-site        # then open http://localhost:8080/vision.html
```

### The images are synthetic, and measured

No real person appears anywhere. The four portraits are rasterised by
`make-images.mjs` from canonical face proportions — eyes at 0.44 of head height,
inter-pupil spacing 0.45 of head width, nose base 0.635, mouth 0.775. Those
ratios are the whole trick: YuNet keys on frontal geometry, not on realism.

Regenerate them with `npm run test-site:images` (deterministic — same bytes
every time), and re-measure with:

```bash
npm run test-site:vision
```

That scores every image through `createYunetBackend`, `letterboxImage`,
`undoLetterbox` and `decodeDetections` — the same functions the offscreen worker
calls — using the ORT build in `public/wasm/` that ships inside the extension.
**It is the first real forward pass through `YunetBackend` anywhere in the
project**; every test under `tests/perception/` injects a fake session and feeds
it a zero-filled `Uint8Array`.

Measured on this machine:

| Image | YuNet | Confidence |
|---|---|---|
| `portrait-a/b/c.png` | 1 face each | 0.921, 0.917, 0.926 |
| `labelled-portrait.png` | 1 face | 0.919 |
| `landscape.png`, `chart.png` | 0 | — |
| `id-card-scan.png`, `signature-sample.png` | 0 | — |

Controls stay at zero even with the threshold dropped to 0.15. Inference runs
32–54 ms, consistent with the 30.3 ms in `candidates.ts`.

Through a **real 1280×800 browser screenshot of this page**: **4 faces, top
0.921**. Through simulated captures at JPEG quality 80 (what `captureVisibleTab`
actually produces) at 1280×800, 1440×900 and 1920×1080: 4/4 every time.

### The one property the whole test rests on

`IMG_VISUAL_RULES` in `dom-scan.ts` joins an image's **alt, title, src and
class** into a single haystack and fires `img-face` at confidence 0.65 — over
the 0.5 redaction gate — for:

```
/(profile\s*(photo|picture)|avatar|headshot|selfie)/i
```

If any of those words touched a portrait, a `face` row would appear **with the
model switched off**, and the panel row would be byte-identical to a real
detection. `` matches at a hyphen or underscore, so `avatar-1.png` alone is
enough to ruin it.

So the three neutral portraits say nothing of the kind, in any attribute,
including the filename. **A `face` detection on those can only be YuNet.**
`verify-pipeline.ts` pins this: it asserts each portrait trips *no* DOM rule,
and that the deliberately-labelled ones trip exactly the rule they are meant to.
Renaming a file breaks the build rather than silently making the experiment
unfalsifiable.

| Image | DOM rule | YuNet | A detection means |
|---|---|---|---|
| `portrait-a/b/c` | none | face | vision ran |
| `labelled-portrait` | `img-face` 0.65 | face | either — both channels fire |
| `landscape`, `chart` | none | none | false positive |
| `id-card-scan` | `img-id-document` 0.8 | none | DOM only |
| `signature-sample` | `img-signature` 0.8 | none | DOM only |

### Running it against the extension

**Use Run task, not Run one step.** `runOneStep` never sets `screenshot`, so a
single step captures no frame and the model is never asked anything.
`resetVisionBreaker()` is also only called from the task loop.

1. Open `vision.html`, make it the active tab, portraits visible.
2. Click the toolbar button (grants `activeTab`).
3. **Load model**, wait for `loaded`.
4. Tick **Run local vision model** — it is in the *Agent server* card, not
   under Runtime. Vision is **off by default**.
5. Any goal (`check the photos` ends after one step), then **Run task**.

### Reading the result

The panel's redaction table groups by kind and strategy and **does not show
which channel found something** — `groupRedactionsBySource` exists in
`panel/selectors.ts` but has zero render call sites. So:

| Signal | Vision ran | It did not |
|---|---|---|
| **Detections** stat | 4+ | 0 |
| Timeline `vision` line | `4 box(es) via wasm` | `0 box(es) via stub` |
| Redacted table | `face` rows | only `id-document`, `signature` |

The **Detections** counter is incremented in exactly one place in the whole
panel reducer — inside `case 'vision/done'`. DOM detections never touch it.
Despite the generic label, that number *is* the YuNet box count.

**Run once with vision off first.** The neutral portraits give `face: 0` on a
vision-off run by construction. Any `face` that appears only when the box is
ticked came from the model. Without that comparison a `face` row is not
evidence.

### If it finds nothing

- **The checkbox has no `checked` binding** — it renders unticked on every panel
  open regardless of the real state, so clicking it after reopening turns vision
  *off*. Watch for the notice at toggle time.
- **The breaker is latched** — three consecutive detect failures disable vision
  for the life of the background context; only **Run task** resets it.
- **The model was never loaded** — `detect`, `retain` and `bake` all refuse.
- **The images were below the fold** — only the visible viewport is captured.
- **The Backend row is not evidence** — it shows the provider *requested* at
  load time, not the one that ran.

Before blaming the browser, run `npm run test-site:vision`. If it passes in Node
and the browser finds nothing, the difference is the browser — which is exactly
the measurement this page exists to make.

### Using your own photograph

```bash
npx tsx test-site/verify-vision.ts path/to/photo.jpg
```

Scores any single image (JPEG/PNG/WebP, decoded with `sharp`). To put it on the
page, drop it in `test-site/images/` and point one of the `<img>` tags at it —
but keep the alt, title, src and class free of the words listed above, or the
result stops meaning anything. Aim for **≥ 0.6**: anything between 0.35 and 0.50
is detected and counted, then dropped by `redact()`'s `minConfidence` and never
reaches the panel table.

---

## 11. What each section tests

| Section | Exercises |
|---|---|
| Search Products | `type` with `submit: true`, `form.requestSubmit()`, visible page change |
| Products | `click` resolution across 10 similarly-named buttons, counter state |
| Customer Record | regex detection of email, phone, address in plain text; `data-sensitive` tier-0 declaration |
| Sign in | `input[type=password]` structural detection, `type=email` detection, pre-filled values to redact |
| Payment Details | `autocomplete` detection (`cc-number`, `cc-csc`, `cc-name`), Luhn validation, the `cc-exp` gap |
| Write a review | typing into a `<textarea>` — the element whose value lives in a text node, not a `value` attribute |
| Preferences | the `select` action, checkbox and radio state, `checked` attribute mirroring |
| Navigation | `click` on buttons, `aria-current` state, and one deliberate URL change |
| Profile | date-of-birth detection, more plain-text PII |

---

## 12. Files

| File | |
|---|---|
| `index.html` | The page. Semantic HTML, stable IDs, no framework. |
| `style.css` | Plain CSS. No `@font-face`, no `@import`, no `url()` to anywhere. |
| `script.js` | Behaviour. ES2020, no modules, no build, no network. |
| `serve.mjs` | Zero-dependency loopback static server. |
| `verify-pipeline.ts` | Runs the page through the extension's real pipeline. |
| `vision.html` | The YuNet face-detection test page (section 10). |
| `vision.js` | Image self-check for that page. Nothing else. |
| `make-images.mjs` | Generates `images/` deterministically. No dependencies. |
| `verify-vision.ts` | Scores the images through the shipped weights and ORT wasm. |
| `images/*.png` | 4 portraits, 4 vision controls, 4 product shots. ~866 KB. |
| `favicon.svg` | Local icon, so the tab is identifiable in a screenshot. |
| `README.md` | This file. |
