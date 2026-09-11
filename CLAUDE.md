# SIH26171 â€” Privacy-Preserving Vision Agent



ISRO problem statement SIH26171. A browser extension where a **local** vision

model reads the screen, PII is redacted **on-device**, and only sanitized

context reaches a server running an open-weights VLM, which returns **one**

action for the client to execute. Then the loop repeats.



---



## Working agreement



```

Do not stop for approval. Decide, log it in DECISIONS.md, continue.

Do not report a phase complete without pasted terminal output from the

actual commands.

```



There are **no module owners**. One engineer. Do not write "Owner A/B/C" or

assign modules to people â€” the five modules are a dependency boundary, not a

staffing plan.



Collect anything needing review and put it at the END, after the work is done.



---



## Hard constraints



Do not violate these. Do not invent APIs â€” check the docs if unsure.



| Constraint | Detail |

|---|---|

| **Manifest V3** | Both browsers. WXT defaults Firefox to MV2, so every Firefox script passes `--mv3` explicitly. Do not drop that flag. |

| **No model in the background** | Chrome's MV3 background is a service worker: no DOM, no canvas, no WebGPU. The model lives in an **offscreen document**. |

| **Offscreen docs get `runtime` ONLY** | "The runtime API is the only extensions API supported by offscreen documents." `chrome.storage` is undefined there despite the permission. This fails at runtime, not compile time — a test in `boundaries.test.ts` guards it. Anything else must be relayed to the service worker. |

| **Firefox has no offscreen API** | `background.service_worker` is unsupported ([bugzil.la/1573659](https://bugzil.la/1573659)); Firefox MV3 uses `background.scripts`, an event page that **does** have a DOM. `chrome.offscreen` does not exist there. Hence `perception/host/` with two backends. |

| **TypeScript strict** | Plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`. |

| **Page content is untrusted DATA** | It can never become an instruction. Enforced at the type level â€” see below. |

| **No secrets** | No API keys, no baked-in endpoints. The user supplies a server origin at runtime via `optional_host_permissions`. A test asserts this. |
| **One network exit** | The extension performs a request with a context in exactly ONE file: `agent-server/client.ts`, where `assertOutboundContext` runs as the first statement. `boundaries.test.ts` pins the whole list of `fetch(` call sites. A second one would be a second way out with no gate on it. |
| **Privacy does not depend on the backend** | `local`, `private` and `cloud` are three instances of one `HttpAgentBackend` over one `HttpAgentClient`. A test asserts the three send a BYTE-IDENTICAL body for the same context. There is no per-backend context transform and there must not be one. |



### Scoring weights (drive every tradeoff)



| # | Metric | Weight | Scorer |

|---|---|---|---|

| 1 | Accuracy of visual context from screen | **25%** | `harness/score-screen.ts` â†’ `scoreScreenContext()` |

| 2 | PII detection recall & precision | **20%** | `harness/score.ts` â†’ `scoreDetections()` |

| 3 | Precision of redaction | **20%** | `harness/score.ts` â†’ `scoreRedaction()` |

| 4 | Client-side resource utilization | **20%** | `harness/resource.ts` + `budgets.json` |

| 5 | End-to-end latency | **15%** | `harness/timing.ts` |



These live in `contracts/metrics.ts` as `SIH_WEIGHTS` and are what

`perception/bench.ts` ranks candidate models against. When two design choices

conflict, check the weights before arguing.



---



## The untrusted-data rule



Anything read off a web page is **data**, never an instruction. This is a

compile-time property, not a convention.



**`Untrusted<T>` is a real wrapper, not `T & { brand }`.** An intersection is

still assignable to `T`, so `wantsString(pageText)` would compile and the

guarantee would be decorative. The payload sits behind a module-private symbol

in `contracts/untrusted.ts`. Two consequences:



- No property access reaches it from outside that file.

- `JSON.stringify()` of an `Untrusted` value yields `{}` â€” symbol keys are not

  serialised, so page text cannot leak by being accidentally included in a

  payload. It has to be deliberately unwrapped first.



The chain:



1. Every DOM read is wrapped with `markUntrusted()`.

2. The only way back out is `unsafeUnwrap(value, reason)`, where `reason` is one

   of a fixed union. Every call site is greppable, and

   `tests/architecture/boundaries.test.ts` **pins the exact list of files**

   allowed to contain one. Adding a call site fails the build until you update

   that list deliberately.

3. Network-bound page text is a `DataAtom`, minted only by `toDataAtom()`, which

   neutralises control characters, bidi/zero-width characters, and prompt fence

   tokens, then caps length.

4. `SanitizedContext` is nominal. Only `redaction/sanitize.ts` may cast to it,

   and a test asserts there is exactly one such cast in the codebase.

5. `renderPrompt()` accepts only `DataAtom`, so page text physically cannot be

   concatenated into the instruction region of the prompt.

6. **Runtime backstop:** the model may only address elements we sent it

   (`ElementRef` allowlist in `validateAction`). Even a fully compromised server

   cannot name a target we did not expose.



`tests/types/untrusted.type-test.ts` asserts all of this with `@ts-expect-error`

directives â€” those **fail the build if the guarded code ever starts compiling**.



### The placeholder nonce



Redactions substitute `[[PII:<KIND>:<ordinal>:<nonce>]]`. The nonce is

per-session. Without it, a hostile page can print a placeholder-shaped string

and make the server believe a field was redacted when it was not. So:



- Page text is stripped of **all** placeholder shapes at ingest

  (`stripForgeriesFromDoc`), before the redactor mints any real ones.

- The count of forgeries found is reported in the log â€” it is always an attack,

  never a coincidence.

- Both ends check: `agent-server/server/app.ts` rejects a context carrying a

  placeholder with a foreign nonce.



---



## Module boundaries



```

contracts/     shared types + pure helpers. Zero runtime deps. The leaf.

perception/    model loading, offscreen/background host, capture, postprocess,

               model benchmark. Returns bounding boxes.

redaction/     DOM PII detection, merge with vision boxes, HTML + PIXEL

               redaction, machine-readable log, SanitizedContext.

panel/         UI showing what was redacted and live metrics. Pure reducer.

agent-server/  sanitized context in, one action out. Client + server halves.
               `backend.ts` is the deployment layer: one AgentBackend interface
               over on-device / local / private / cloud.

harness/       fixtures, scoring, timing, resource budgets. Node-only.

entrypoints/   thin WXT wiring. No logic.

```



**Dependency DAG** (enforced by `tests/architecture/boundaries.test.ts`):



- `contracts` imports nothing.

- `perception`, `redaction`, `panel`, `agent-server` import **only** `contracts`.

- `harness` and `entrypoints` may import anything.

- **No deep imports.** Cross-module imports must go through `@/<module>/index.ts`.

  A module's internals are not anyone else's API.

- `harness/` touches the filesystem â€” nothing in the extension bundle may import

  it, and nothing outside it may import `node:*`.

- `agent-server/server/**` must never be imported by an extension context.



`perception/bench.ts` takes its scorers as **injected dependencies** rather than

importing `harness/`. That is what keeps the DAG acyclic; the wiring lives in

`harness/bench-runner.ts`.



### Where pixel redaction happens



`redact()` returns HTML â€” it cannot touch pixels. Pixel redaction is

`redaction/canvas-redact.ts`: pure functions over an RGBA buffer, fully tested

in Node with no canvas. Only `encode` is environment-specific and it is injected.



It **runs in the inference worker**, inside the offscreen document (Chrome) or

the background event page (Firefox). Not in the content script â€” the page must

never be handed the unredacted frame â€” and not in the Chrome service worker,

which has no decoded frame.



Sequence, and why it is two round trips:



```

detect(frame) â†’ [background merges vision boxes with DOM detections] â†’ bake(frameId, ops)

```



The ops depend on the merge, and the DOM lives in the content script. The worker

retains the decoded bitmap between the two calls, so the frame is decoded once

and the large buffer never crosses a context boundary.



`buildSanitizedContext` accepts a `BakedScreenshot`, which only

`bakeRedactions()` can mint. There is no way to hand the sanitizer a raw frame

and assert its redactions were applied.



---



## Fixture conventions



Every fixture is a triple sharing a stem in `src/harness/fixtures/`:



| File | Contents |

|---|---|

| `<id>.html` | The page. Self-contained, inert, offline: no `<script>`, no `<iframe>`, no `on*=` handlers, no remote `src`/`href`. |

| `<id>.truth.json` | `GroundTruth` â€” see `harness/types.ts`. |

| `<id>.vision.json` | `VisionDetection[]` a plausible model would emit, in `css-viewport` space. |



**`data-test-rect="x,y,w,h"`** on every element that matters. jsdom has no layout

engine â€” `getBoundingClientRect()` returns zeros â€” so geometry would otherwise be

untestable. The browser uses a different `RectProvider` that reads real layout.

A test asserts the attribute and the truth file agree.



Rules:



- `literal` is the exact string the leak test greps for in the outgoing payload.

- `benign` entries assert what must **not** be redacted. This is what keeps

  redaction precision honest.

- `expectedElements` is ground truth for metric 1 â€” role, accessible name,

  geometry, states, sensitivity.

- `mustRedact: false` marks something genuinely sensitive that this build is not

  expected to catch. It is excluded from the recall denominator **and** never

  counted as a false positive. **Every one requires a written `note`** â€” a test

  enforces this. It is a documented gap, not a way to make a number look better.



Current set: `login-form`, `checkout`, `profile-pii`, `benign-docs` (zero-PII

control â€” any detection here is a precision failure), `injection` (hostile page:

imperative text, forged prompt fence, forged redaction tokens).



---



## Commands



```bash

npm install && npm test

```



`npm test` = `tsc --noEmit && vitest run`. The typecheck is a real test: the

negative type tests fail the build if forbidden code starts compiling.



| Command | Purpose |

|---|---|

| `npm run build:chrome` | Chrome MV3 build |

| `npm run build:firefox` | Firefox MV3 build (note the `--mv3`) |

| `npm run test:built` | Builds both browsers, then asserts the EMITTED manifests. Not part of `npm test`. |
| `npm run scorecard` | Per-fixture rubric numbers + benchmark ranking |

| `npm run vendor:model` | Fetch weights + ORT wasm into `public/` (~56 MB, gitignored). Required before the model can load. |
| `npm run spike:setup` | Vendor transformers.js into `spike/` |
| `npm run server` | The agent server. Reads `.env` via `--env-file-if-exists`, and a SHELL variable still wins over the file. `VLM_ENDPOINT` + `VLM_MODEL` pick a real VLM; `VLM_API_KEY` is what the SERVER presents to the model; `AGENT_AUTH_TOKEN` is what the server REQUIRES from the extension. Two different secrets in two directions - do not conflate them. `npm start` (Render) deliberately does NOT read `.env`. |
| `npm run verify:server` | Drives REAL page HTML through the SHIPPED pipeline into a RUNNING server, via `createAgentBackend` - so the egress gate and the per-kind TLS policy run exactly as in the extension. `--url` / `--file`, `--goal`, `--endpoint`, `--kind`, `--token`. Not part of `npm test`: it needs a server on the other end. |



Load unpacked from `.output/chrome-mv3/`.

**Opening the UI:** click the toolbar button. It opens the side panel on Chrome
and toggles the sidebar on Firefox. There is deliberately no popup -- a
`default_popup` would suppress `action.onClicked` entirely and make the panel
unreachable, which is why `tests/built/manifest.test.ts` asserts its absence.

**Static assets live in `public/` at the repo ROOT**, not `src/public/`. WXT
resolves `publicDir` from the project root even though `srcDir` is `src`; files
under `src/public/` are silently ignored -- not copied, not warned about.



### Test environments



Vitest defaults to `node`. Files needing a DOM opt in with a

`// @vitest-environment jsdom` docblock on the first line. Keep the fast tests

fast.



---



## Temporary panel UI

The TASK section is a **conversation**: a transcript, one input that sends a goal
or answers an outstanding question, and a credential warning shown only while a
question is open. `messages` lives in the panel entry, NOT in `PanelState` -
`reducePanel` is a pure function of `PanelEvent` and a transcript mixes user text
with view-generated text. `tests/panel/chat.test.tsx` renders the real component;
note the buttons are gated on `canRun` (attached tab AND `state.host.modelLoaded`,
not `state.model`).


The sidebar is **SIGHTLINE dark** - the website's identity, applied to the
panel, and it is one theme on purpose. It still shows real runtime state and
nothing invented; the redesign changed how facts look, never which facts there
are. Four rules carry it, and they are the ones a future change must not undo:

- **Four semantic colours and only four**, the same key the site teaches:
  `--device` green (this side of the line), `--found` amber (detected and
  handled - a redaction is a FIND, not a fault), `--wire` cyan (crossed the
  line), `--refuse` red (a gate said no). Action buttons use `--accent`, which is
  deliberately NOT one of the four: colouring Send as wire would say it transmits
  when on-device planning transmits nothing.
- **A cloud send is WIRE, everywhere.** The panel coloured it green in four
  places - the Send dot, the proof row, the receipt SENT lines and the timeline
  delivery row - which made the one moment data crossed the line look identical
  to the moment it did not. `ShieldTone` and the timeline kind union each gained a
  `sent` member for this, and it rolls up exactly like `ok`: a different colour,
  not a lower grade. An off-device backend in Settings is wire too, not warn.
- **Three voices.** Inter Tight for headings, Inter for claims, JetBrains Mono
  for measurements. Mono is applied ONLY to strictly numeric elements (stats,
  latency values, timeline readings); a row mixing a number and a sentence stays
  in sans, because a claim is never set in mono. The model tag in the privacy
  strip is sans for a measured reason: mono is wider and clipped the strip
  sentence to `sanitized contex...`, losing exactly the wire fact.
- **Fonts are self-hosted** in `public/fonts/` (124 KB). An extension page may not
  fetch a remote font, and a webfont request from a privacy tool is a request the
  user did not make. Instrument Serif is absent: the site rations it to three
  pull-quotes and a sidebar has none.

The identity change lives in one appended block at the end of `style.css` so it
reads in one place and reverts by deleting it. `npm run panel:shots` renders the
real `App` with the real stylesheet - look at it after any UI change; that script
exists because two rounds of UI work once shipped with nobody looking.

The separation that lets it be swapped: the panel consumes `PanelEvent`, a
contract. It imports nothing from perception, orchestration, execution or the
server, and `reducePanel` is pure and tested independently of any view.

## The egress gate

Two checks, both fail-closed, run before any context can leave - **and both run
for every backend including `on-device`.** The requirement is not "check harder
when the destination is a cloud"; it is that the boundary does not move when the
destination does.

**`contracts/egress.ts` - shape.** Runs as the first statement of
`HttpAgentClient.plan`, before the endpoint is read. It exists because the
nominal type stops being a fact at the first message boundary: on Chrome the
context is built in the offscreen document and JSON-serialised back, where
`receiveSanitizedContext` RE-BRANDS a plain object. It refuses any key the
sanitizer does not emit (`ALLOWED_KEYS` is pinned), page text that is not a
`DataAtom`, a placeholder carrying a foreign nonce, and a screenshot missing the
`opsApplied`/`opsRequested`/`opsOutsideFrame` counters that only
`bakeRedactions()` produces. That last one is what closes `receiveBakedScreenshot`,
which will brand any object with the right seven fields on the sender's word.

**`redaction/egress.ts` - content.** Re-runs the PII detectors over the outbound
text at the SAME `minConfidence` the redactor used, so the two can only disagree
where the text they see differs. It needs `scanTextPatterns`, so it cannot live
in contracts and cannot run inside the client; `orchestrator/step.ts` calls it as
the `verify` stage. It does NOT scan `goal`/`clarifications` (user-authored),
`screenshot.base64` (noise), or redaction placeholders (stripped first - they
carry digit runs and would make the verifier fire hardest on the pages it
protected best).

Neither repairs a payload. A gate that stripped the offending field and sent the
rest would turn "we found a leak" into "we sent something".

---

## Known gaps

Written down so they are not rediscovered as surprises:

- **The analysis layer computes on the client and sends about forty numbers.**
  `analysis/` reads the REDACTED document that `DomPipeline` already retains -
  never the original, and there is no path by which it could reach the
  pre-redaction DOM, because that document does not exist on this side of the
  pipeline. `AnalysisResult` is nominal with a single minting site in
  `analyze.ts`, pinned by `boundaries.test.ts` exactly as `SanitizedContext` is.
  Measured over the generated datasets: 100 rows produced 9,059 bytes and 10,000
  rows produced 10,128 bytes. A hundred times the data for 1.1x the payload,
  because the payload is statistics and the row count is one of them.

- **A REDACTED CELL IS COUNTED, NEVER PARSED, and this is the whole feature.**
  `Number.parseFloat('[[PII:EMAIL:3:9f2a]]')` is `NaN`. Filter the NaNs out and
  the mean of a column that was 90% redacted is a real number computed from a
  tenth of the rows, reported as if it covered the column. `table.ts` checks
  `hasAnyPlaceholder` BEFORE any parse and counts the cell in `nRedacted`, which
  travels with the mean into the prompt as `[of 1000 rows: 3 redacted, 0
  missing]`. Note it must be `hasAnyPlaceholder` and not `ANY_PLACEHOLDER_RE`
  directly - that regex carries `/g` and alternates true/false across calls,
  which is already recorded above and this loop calls it once per cell.

- **`classify()` counted redacted cells against the numeric ratio, so the more
  PII a page had the less could be analysed.** Three numbers and one stripped
  email scored 3/4 = 0.75 against a 0.8 threshold, came back `unknown`, and the
  column's values were discarded. The denominator is `nonEmpty - redacted` - what
  was AVAILABLE to parse. A redacted cell is a known unknown; it is excluded from
  the judgement, not held against it.

- **Two quadratics, both invisible to 1112 passing tests.** Every fixture in this
  repo is a hand-written page of a few dozen elements, and at that size `n^2` and
  `n` are the same number. Against a generated 1,000-row table `redact()` took
  **378,745 ms** and the 10,000-row case never returned. Stage timings found
  both:

  | stage | 10,000 rows | 100,000 rows | growth |
  |---|---|---|---|
  | parse | 2,535 ms | 23,783 ms | 9.4x |
  | `scanDom` (before) | 3,021 ms | 29,788 ms | 9.9x |
  | `mergeDetections` (before) | 1,035 ms | **1,767,327 ms** | **1708x** |

  After both fixes, `mergeDetections` is 66 ms at 100,000 rows and whole-`redact`
  is 36,633 ms, down from 334,885 ms. `tests/redaction/dom-index.test.ts` pins
  both - the equivalence deterministically, the cost as a tripwire.

- **`DomIndex` is valid ONLY across a pass with no STRUCTURAL mutation, and a
  stale one is a wrong-element bug rather than a slow one.** Ordinals change when
  an element is added or removed, not when text or an attribute is rewritten. So
  it is never a module-level cache: each caller creates one and scopes it to a
  pass it can show is structural-mutation-free. `scanDom` qualifies
  (`stripForgeriesFromDoc` rewrites `Text.data` and attribute values and removes
  no node). `redact`'s span-rewrite loop qualifies; the removals loop after it
  does NOT and is passed no index - the same ordering that already existed for
  offset reasons, now doing a second job. Everything else passes nothing and gets
  an uncached `previousElementSibling` walk, which is still far cheaper than
  materialising `parent.children` per level per call.

- **`resolveDomPath` walks the path itself; `querySelector` was 307 ms per
  call.** A CSS engine handed `...>tr:nth-of-type(937)>td:nth-of-type(3)`
  evaluates `:nth-of-type` right-to-left across every cell in the table.
  `walkCanonical` returns `undefined` for "not the grammar `canonicalPath`
  emits" - distinct from `null`, "no such element" - and only the first falls
  back to the CSS engine. Confusing the two would send every MISS back through
  the 307 ms path and restore the quadratic on exactly the pages where paths stop
  resolving.

- **`INDEX_MIN_CHILDREN = 32`, because indexing every `<tr>` is what exhausted
  the heap.** The index turns an O(siblings) walk into a map lookup and pays with
  a Map, an array per tag and an ordinal per child. On a 100,000-row table the
  rows are ONE parent worth indexing and the cells are 100,000 parents of eight
  children each - indexing those allocated 100,000 Maps to save eight pointer
  steps apiece, and the verification died on `Mark-Compact ... allocation
  failure` at a 4 GB heap.

- **`mergeDetections` is indexed on BOTH predicates, and the hash still defers to
  the predicate.** `sameTarget` requires kind, domPath, attr and nodeIndex to be
  equal, which is a hash key; `overlapping` requires both rects and IoU >= 0.5,
  which is a spatial grid. Every hash hit is re-checked with `sameTarget` itself,
  so if the two ever drift the index can only MISS a merge, never invent one - an
  invented merge discards a real detection, and a discarded detection is a value
  that never gets redacted. A merged winner that GAINS a domPath or a rect from
  its candidate is re-indexed; the scan this replaced re-read every entry on
  every iteration and got that for free.

- **A refusal carries its evidence.** `refuse()` returned `columns: []`, which
  made the most important refusal unprovable: `all-columns-redacted` means the
  redactor removed every column - the privacy pipeline working - and the receipt
  rendered it as "Analysis blocked" above "0 column(s), 0 value(s) excluded". A
  claim with its own evidence zeroed out reads as a crash. `rowsAnalyzed` still
  reports 0 there, because nothing was computed from those rows; `cellsRead`
  carries what was actually looked at. They are different facts.

- **The prompt labels provenance because the model will otherwise blur three
  warranties into one.** OBSERVED is counted off the page, CALCULATED is exact
  arithmetic on those values, PREDICTED is an extrapolation with an interval.
  Rule 9 names them and forbids computing a new statistic - having been handed
  the answers, the failure mode inverts from "cannot average 100,000 numbers" to
  "produces a neighbouring number that was never computed, in the same voice as
  the real ones". The block sits INSIDE the fence (a derivation does not launder
  page provenance) and AFTER the element list (measured twice: a small model acts
  on what it reads last).

- **Analysis is ON by default and vision is OFF, and the difference is what each
  costs when unneeded.** Vision spends a forward pass whether or not the page has
  a face. The analysis engine spends one `querySelectorAll('table')` on a page
  with no table. Measured on the datasets: 8 ms at 100 rows, 64 ms at 1,000,
  651 ms at 10,000, bounded at 200,000 cells and a 2 s compute budget.

- **100,000 rows works and is not fast, and the numbers below are jsdom's.**
  `redact()` is 36.6 s and the heap peaks near 8.9 GB for a 17.7 MB page - that
  is jsdom materialising 1.1 M nodes in Node, and the extension does not parse
  anything (the browser's DOM already exists). The browser cost at that size has
  NOT been measured and should not be inferred from these. What IS established is
  that every stage is now linear, and that the analysis ceiling bites and REPORTS
  itself: both 100,000-row datasets came back `too-many-cells` having analysed
  20,000 and 28,571 rows, which is the ceiling working rather than silent
  truncation.

- **`test-site/data/` is gitignored and regenerable.** `node
  scripts/make-datasets.mjs` writes 100/1k/10k/100k rows of telemetry and sales
  from a seeded mulberry32 PRNG - 34 MB total, up to 17.7 MB per file. Every
  address is `@example.invalid`, every page carries a SYNTHETIC banner, and no
  value corresponds to a real person. The generator is the artefact worth
  versioning.

- **min and max ARE cell values, and that is the honest boundary of the claim.**
  The smallest observation in a column is an observation. No amount of care
  changes that while descriptive statistics are published at all, so the claim is
  "aggregates leave, and two of the aggregates coincide with real rows" rather
  than "no cell value leaves". What bounds it is `MIN_VALUES_TO_SUMMARISE = 5`:
  below five values every field of a `NumericSummary` IS the data - at n=1 all
  seven are the single cell - so no summary is emitted at all and the column is
  reported as present with too few values to describe. `recentHigh`/`recentLow`
  were REMOVED for the same reason and did worse: window extremes narrow the rows
  they could have come from to the last third of the table, and `movingAverage`
  plus `volatility` already carried the useful part.

- **An adversarial review of this layer found nine real defects that 1131 tests
  did not.** Three were disclosure - a data row promoted to column headers when a
  table had no `<th>` (labels are the ONE string the gate lets through, so real
  values left by the front door), a one-value "summary", and a `last-value`
  forecast that was the final cell copied out and labelled a prediction. The rest
  were honesty: an interval labelled 95% using the NORMAL quantile at n-2 degrees
  of freedom (12.71 at n=3, so it covered about 70%), a moving-average forecast
  carrying the r-squared of the linear fit it had just rejected, `confidence` as
  a name for r-squared, trend direction scaling a per-x-unit slope by the ROW
  COUNT, momentum comparing window LEVELS so every rising series read
  `accelerating`, a MAD=0 outlier fallback to stdDev that the outlier itself
  inflated (nothing found below n=13), and European decimals parsed 1000x wrong.
  `tests/analysis/disclosure.test.ts` pins every one.

- **`nUnparsed` exists because nothing counted it.** A cell that held text, was
  not redacted, was not a declared absence and was not a number was tallied
  nowhere: a 1,000-row column with 200 such cells reported `n=800, nMissing=0,
  nRedacted=0`, which states that every row parsed. `n` plus every exclusion must
  account for every row read, and now does. Separately, `MISSING_MARKERS` treats
  `N/A`, `-`, `null` and friends as MISSING rather than as categories - counting
  them as distinct values pushed mixed columns under the 0.8 numeric ratio and
  discarded their numbers entirely, the same shape as the `classify()` bug above.

- **A `DataAtom` may carry exactly four fields.** `isDataAtom` checks the four it
  needs are PRESENT, not that nothing else is, and `walkAnalysisValue`
  deliberately skips labels because a label is the one place text is allowed. So
  an atom-shaped object plus `{ raw: "<the whole row>" }` cleared both gates: the
  single legal text field was the single unchecked one. `checkAtom` now pins the
  key set.

- **The agent follows the active tab, and the ceiling on that is the browser's.**
  `tabs.onActivated` and `windows.onFocusChanged` fire with NO permission and
  carry only ids; `scripting.executeScript` works on a tab covered by an optional
  host permission granted EARLIER, with no gesture and no `activeTab`, and that
  grant survives navigation AND browser restart. So switching tabs reconnects
  silently on any site the user has enabled once. What is NOT possible, in either
  engine and by design: reaching a site the user has never approved.
  `permissions.request` requires a user gesture and the gesture dies at the first
  `await`, so the once-per-site approval cannot be automated. Checked against the
  Chrome and MDN references, not assumed.

- **A READABLE URL IS THE PERMISSION TEST.** `tab.url` is populated only under
  the `tabs` permission, a matching host permission, or a live `activeTab` grant.
  This extension declares no `tabs` permission - deliberately, it would expose
  every tab's address - so being able to READ a tab's url is the same fact as
  being allowed to INJECT into it. `followActiveTab` therefore never asks "may
  I?" separately. `hasSiteAccess` is consulted only to tell a DURABLE grant from
  a transient `activeTab` one, which changes what the panel may claim and not
  whether the agent may act.

- **`undefined` url means NO ACCESS and must not be softened.** The navigation
  handler used to fall back to the origin it REMEMBERED when the url came back
  undefined, ask whether that old origin was granted, and report "access
  retained" - for a page it could no longer read. A cross-origin hop is exactly
  when the url goes undefined, so the wrong answer arrived precisely when it
  mattered. `resolveTarget` now returns `unreadable` and the follower detaches.

- **Following is SUSPENDED while a task runs.** `runTask` destructures `tabId`
  once and `runAgentLoop` reuses it for every step, so a re-point mid-run would
  leave the loop driving the old page while the panel named a new one - and the
  capture adapter, the only thing that re-reads the attachment live, would throw
  on every later step with a message blaming navigation. Same rule the
  `deployment/*` commands already follow.

- **The decision lives in `orchestrator/attach.ts`, not in the entrypoint.**
  `resolveTarget` and `decideAttachment` are pure and pinned by
  `tests/orchestrator/attach.test.ts`; `background.ts` keeps the listeners,
  `tabs.query`, `permissions.contains` and injection. A rule about when the
  extension may touch a page does not belong in the one file that cannot be unit
  tested.

- **`allowedOrigins` was the AGENT SERVER's origin, which made `navigate`
  unreachable.** It is consumed in exactly one place - the `navigate` case of
  `validateAction`, where it decides where the PAGE may be sent - and it was
  filled from the endpoint the extension POSTs contexts to. Two unrelated things
  that are both origins. Every real navigation was refused `origin-not-allowed`,
  and this file recorded that as intentional. It is now the ATTACHED PAGE's
  origin and nothing else: that covers search -> product -> cart, while a
  compromised server still cannot steer the browser somewhere of its choosing.
  Other granted origins are deliberately excluded - enabling the agent on two
  sites is not authorising it to move between them.

- **The stale-target guard compared a `DataAtom` against a raw accessible name.**
  `content.ts` refused to execute when the live name differed from the sent one -
  but the sent one is `SanitizedElement.name.text`, which has been through
  `neutralize()` (whitespace collapsed), may carry `[[PII:...]]`, and may have
  been cut at the atom cap with `...` appended. The live one has been through
  none of that. So `"Laptop Pro Rs 49,999"` versus `"Laptop Pro
   Rs 49,999"` -
  one element, two spellings - killed the action, on essentially every anchor
  whose name comes from text content rather than an `aria-label`. `namesAgree`
  normalises both sides and falls back to the ROLE check when the name was
  redacted or truncated, because a comparison that cannot be made must not refuse
  work. The role check is not text-derived and is exactly as strong as before.

- **`sanitize` was the third stage carrying the same quadratic.** It calls
  `canonicalPath` once per interesting element and `extractRefPaths` calls it
  again for the same elements, both uncached - so on a page whose rows are
  siblings (a results list, a table) the pair is quadratic in the row count. It
  now takes a `DomIndex`, valid for the same reason `scanDom`'s is: the pass
  reads the document and never changes its shape. Measured on a 1,200-row flat
  page: 497 ms -> 84 ms, and linear thereafter. `nearbyGroupName` also gained a
  container-keyed cache and stops at the first named anchor instead of naming all
  of them, worth a further ~15%.

- **`max_tokens` bounds REASONING PLUS ANSWER, and 160 starved the answer.**
  The first real Gemini run on amazon.in reached the model, and the reply came
  back cut mid-string at 46 characters:
  `{"type":"type","ref":"e12","text":"macbook pro`. That is a JSON object, and
  the RIGHT one - correct ref, correct verb, correct search term. The default was
  sized on "one action is about 40 tokens, so 160 is generous", which is true for
  a model that answers directly and false for one with `reasoning_effort` set:
  the thinking comes out of the same budget. Now 1024, and `VLM_MAX_TOKENS`
  exists so a deployment can retune without a code change. Raise it BEFORE
  lowering `VLM_REASONING` - thinking is what picks the right element on a
  crowded page.

- **`finish_reason` was never read, so a truncation was reported as a prompt
  failure.** The panel said `unparseable action: no-json-found (no JSON object in
  the model output)` while the provider had already said `finish_reason:
  "length"` in the same response. Those send someone to two different places: one
  to rewrite the prompt, one to the token limit, and only the second was the
  fault. `TruncatedCompletionError` is a distinct error carrying the partial text
  and the remedy, and it is NOT retryable - the budget does not change between
  attempts, so a retryable truncation costs one wasted step per step until the
  loop ceiling and shows the user eight identical failures instead of one
  actionable one.

- **`npm ci` fails when `package-lock.json` is not regenerated.** Adding
  `pptxgenjs` to devDependencies without running `npm install` broke the Render
  build: `npm ci` refuses to install when the manifest and the lock disagree, and
  it names the missing transitive packages rather than the direct one. It is a
  lockfile problem every time, never a registry problem.

- **The agent completes a task on amazon.in, with Gemini, verified in Chrome.**
  The first real success on a commercial site. `add a laptop to the cart` ran
  `ask_user` -> (user answered "Legion 5 2025 ... RTX 5060 8GB") -> `click` ->
  `done`, two steps at 5.5 s and 3.3 s. A separate search run did `type` then
  `click` and the page-check confirmed the page changed. Five recorded amazon.in
  attempts before this one all failed; the difference was `max_tokens`.
  IMPORTANT: `done` is the MODEL reporting completion. The cart was not
  independently verified on this run, and the page check does not appear for the
  final step - treat the completion as a claim with two corroborating actions
  behind it, not as a confirmed purchase state.

- **A navigation needs a WAIT, not just a re-injection.** `contentRequest`
  already re-injected on "Receiving end does not exist", and on the real Amazon
  run the RETRY failed too - the task died at step 3 having completed steps 1 and
  2. The retry was not wrong, it was early: the click had begun a navigation that
  had not committed, so `executeScript` landed in a document about to be
  replaced. `waitForTabReady` polls `tabs.get().status` for `complete` (not one
  of the four properties Chrome gates behind the `tabs` permission) and the retry
  now runs twice, because a slow page can commit a second document between the
  wait and the send. Retrying is safe for `execute` on this path specifically: it
  is reached only when NOBODY received the message, and a message nobody received
  cannot have acted.

- **A clarification names what DIFFERS, not what the controls share.** On a real
  amazon.in cart the question ran to 445 characters and was ninety percent
  identical on both sides - "Delete <200-char product>" against "Increase
  quantity by one, Quantity is 1, <the same 200 chars>". The four words that
  decided it were four words in four hundred, and answering meant diffing two
  paragraphs by eye. On a shopping site EVERY control in a product row is named
  after the product, so that is the ordinary case there. `composeQuestion` strips
  the longest shared prefix and suffix, states the shared part once as context,
  and clips: 445 characters became 181. It falls back to the full names whenever
  trimming would leave an option empty - a question naming an empty choice is
  worse than a long one - and `tidy` removes the separator left dangling by the
  cut, which otherwise reads as the option itself having been truncated.

- **The analysis demo is LIVE and seeded from the clock, and that is the point.**
  `test-site/mission.html` + `mission.js` generate telemetry in the tab: frames
  arrive while the room watches, and the seed is printed so a surprising run can
  be reproduced. A static table is right for verification and wrong for a
  demonstration - shown a fixed page and a confident answer, the reasonable
  question is whether the two were arranged to match. The channels are the SAME
  ones `scripts/make-datasets.mjs` uses, so the demo and the offline verification
  are one claim measured twice.
  `npm run test-site:mission` drives the REAL page through the REAL redactor and
  engine and prints a capability checklist - a demo that silently stops
  triggering half of what it promises is worse than no demo. Measured at 60 /
  300 / 1,200 frames: every capability fires, gate OK, no planted literal in the
  outbound bytes, payload 8.7 KB -> 10.3 KB while the table grows past 1 MB.

- **The demo page carries THREE detectable PII kinds and one undetectable one,
  deliberately.** `contact` (email), `op_phone` (phone) and `station_ip`
  (ip-address) are removed - 180 cells excluded at 60 rows. `operator` is a plain
  NAME and is NOT removed, because this build has no NER. Showing only the three
  that work would make the demo a claim the code does not support; the fourth
  column is the documented gap, on screen. Both fake ranges are reserved by RFC
  and can never belong to anyone: `@example.invalid` (RFC 2606) and
  `198.51.100.x` (RFC 5737 TEST-NET-2).

- **The demo page runs the SHIPPED engines, not a copy of them.**
  `scripts/build-demo-engine.mjs` bundles `src/redaction` and `src/analysis` with
  esbuild into `test-site/demo-engine.js`, and the page calls the same
  `redact()` and `analyzeDocument()` the extension calls. Every figure in its
  privacy and analysis panels is computed by that code on the page's own table.
  A second implementation written to agree with the first would drift, and the
  first time it drifted the demo would quietly start proving something the
  product does not do. The bundle is gitignored and `npm run test-site` rebuilds
  it every time, so it cannot go stale against its source. What differs from an
  extension run is only where the input comes from - the extension snapshots the
  live page through its content script and its panel reports what IT measured -
  and the page says which is which rather than implying otherwise.

- **`Number('')` is ZERO, and it drew a chart full of cliffs.** One cell in forty
  is blank by design, and every one was plotted as a real reading of zero -
  vertical spikes to the baseline, visible in the first screenshot of the page
  and in no test. `Number.isFinite` does not catch it because zero is finite.
  Blank and `N/A` are ABSENT; the line lifts the pen instead.

- **Six channels cannot share a vertical axis.** Normalising each to its own
  min/max fixed the collapse-to-baseline problem and created a worse one: a
  pure-noise channel fills the full height and dominates everything. One primary
  chart plus a sparkline on each channel card is what actually reads - the card
  shapes answer "which channels move together" at a glance, and the large chart
  answers "what is this one doing".

- **The clarification chips carry a NEUTRAL accessible name.** The example
  questions are buttons, so they join the element list the model is shown - and a
  button named "What is the altitude trend?" is the closest thing on the page to
  that goal, so the agent clicks it instead of reading the table. `accessibleName`
  prefers `aria-label`, so the model sees "Copy example question 3" while a
  person reads the question. Same reasoning applies to the channel cards.

- **The analysis panel hides the INDEX columns from its highlights.** The engine
  correctly reports that `Frame` rises and that `Frame` correlates with `Time` at
  r = 1.000. Rendering that first opened the panel with arithmetic rather than a
  finding. The measurement channels are what gets shown; nothing is discarded and
  the payload is unchanged. Same for the excluded-values count, which summed to
  149 of 120 rows until it was restricted to numeric columns - almost all of it
  was the operator NAME column, which is text by design and not a gap in the data.

- **Three deployments, one boundary, and `on-device` is a fourth CHOICE.**
  `BackendKind` is `on-device | local | private | cloud`. The three off-device
  kinds are one `HttpAgentBackend` over one `HttpAgentClient` differing only in
  endpoint and token, so there is no second HTTP path for the gate to be
  forgotten in. `on-device` is selectable rather than a fallback: as a fallback,
  every failure of a real backend would silently become it and the panel would
  report a plan produced by a different agent. `deployment/select` in
  `background.ts` is the ONLY writer of the selection, and nothing in the failure
  path calls it - that is what makes "no silent cloud fallback" a guarantee
  rather than a policy.

- **`private` and `cloud` require https; `local` may use loopback http.**
  Enforced structurally in `deriveBackendOrigin`, on top of everything
  `deriveOriginPattern` already refuses. TLS verification is not adjustable
  anywhere in this codebase and no option to skip it is being added. Note the
  consequence for tests: neither kind can be pointed at a plaintext mock through
  the factory, so `tests/agent-server/backend.test.ts` constructs those two
  directly and asserts the policy separately.

- **`PlanError.kind` decides whether the user is offered a backend switch.**
  Only `transport` (not reached, or 5xx) raises the prompt. `refused` is our own
  egress gate - offering to switch providers because our redaction check fired
  would be the worst possible response. `protocol` covers 401/403: the server is
  UP and said no, and "private server unavailable, use cloud?" would be a wrong
  diagnosis attached to a data-sharing decision.

- **The access token is write-only, header-only, session-only.**
  `HttpClientOptions.authToken` is a FUNCTION read per request, so the token is
  never a field on the client and never appears if one is logged. It goes into an
  `authorization` header and nowhere else. `BackendDescriptor` carries
  `authenticated: boolean` and no field that could hold a secret - it is
  persisted, broadcast to the panel and stamped on every receipt. There is no
  read-path message; `deployment/get` answers with booleans. `storage.session`
  buys LIFETIME, not encryption: an extension is not a secret store, and the cost
  is re-entry after a browser restart.

- **`authorization` must stay in the server's CORS allow-headers.** It is not a
  safelisted request header, so a cross-origin POST carrying it triggers a
  preflight, and a preflight that does not name it FAILS - the extension sees a
  bare "Failed to fetch" and the server log stays empty, because the POST never
  arrives. Same silent shape as the private-network-access header.

- **No line of the privacy receipt may be a constant.** `EgressClaim` has
  `not-checked`, and it is used: a step that died at capture never ran a gate, and
  "RAW PII: NOT SENT" there is equally true of a step that did nothing.
  `verified-absent` carries `checkedFields` because a scanner that walked nothing
  also reports nothing found. `stayed-on-device` is separate from
  `verified-absent` - one means a check ran over an outbound payload, the other
  means there was no outbound payload. Page verification says
  `changed`/`unchanged`, never `verified`: a DOM fingerprint proves something
  moved, not that the right thing moved.

- **`receiveBakedScreenshot` and `receiveSanitizedContext` are still re-brands.**
  Both take a plain object across a transport hop and assert a nominal type on
  the sender's word. That is unavoidable for anything crossing a message
  boundary. What changed is that it is no longer the ONLY defence: the egress
  gate re-derives at runtime what the compiler can no longer see. The type system
  and the gate are now two independent checks rather than one with a hole.

- **Google AI Studio is reached through its OPENAI-COMPATIBLE surface**, at
  `generativelanguage.googleapis.com/v1beta/openai/chat/completions`. Same
  `Authorization: Bearer` header, same `messages` shape, same `image_url` parts
  with base64 data URLs, and a `/models/{id}` catalogue at exactly the sibling
  path `modelCatalogueUrl` already derives - so `VlmPlanner` needs no
  provider-specific code and `GEMINI_API_KEY` alone configures a deployment.
  `GOOGLE_API_KEY` is accepted as the same variable: the console calls it one
  thing and the ecosystem's tooling exports the other, and honouring only one
  yields a server that runs the heuristic baseline while looking configured.
  Gemini is checked BEFORE OpenAI when both keys exist; an explicit
  `VLM_ENDPOINT` beats both.

- **A 404 from a model catalogue is CORROBORATED, never believed.** Measured
  against the live host: unauthenticated, Google answers 404 to the catalogue
  list, to a real model id, and to `definitely-not-a-real-model-xyz` alike, all
  with the identical body `Requested entity was not found.` So a rejected key is
  indistinguishable from a missing model, and reporting `verified: false` would
  have told somebody to fix `VLM_MODEL` when the problem was their API key.
  `verifyModel` now asks the LIST after a 404: list 200 means the credential
  works and the id genuinely does not, anything else means unknown. One extra
  request, only on that path, only at startup.

- **The cloud model is `gpt-5.6-luna`, and it is CONFIGURATION.** Defaulted in
  `server/main.ts`, pinned in `render.yaml`, used verbatim with no substitution
  on any path. `verifyModel` asks the provider once at startup whether the id
  resolves and reports the answer on `/health` as `vlm.verified` - `true`,
  `false`, or `null` for "could not ask", which is NOT a synonym for fine. The
  probe never blocks startup and never picks a different model: a fallback would
  mean a typo produced a working demo powered by something nobody chose, with
  every receipt line naming the model wrong while looking right.

- **`server/main.ts` only listens when it is the ENTRY POINT.** `start()` is
  guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`. It used
  to `listen` at module scope, so a test importing `selectPlanner` bound port
  8787 and the second file to do so died with EADDRINUSE. Compared through
  `pathToFileURL` and not as strings - argv is a path, `import.meta.url` is a
  URL, and on Windows they differ in separator and drive-letter case, so a
  string compare works on Linux and silently never matches here.

- **`PlannerChoice` holds the model key in a CLOSURE, never a field.**
  `verify: (() => Promise<ModelVerification>) | null`. An `apiKey` field made
  `JSON.stringify(choice)` leak the credential and broke a property the object
  already had: that it is safe to log whole. The existing
  `NEVER puts the key in the description` test caught it. Same shape as
  `HttpClientOptions.authToken`, for the same reason.

- **The extension never names the model and has no OpenAI endpoint.** Zero
  occurrences of `api.openai.com`, `OPENAI_API_KEY`, a key shape, or the model
  id in either emitted bundle. Which model answered arrives as
  `PlanResponse.modelId` - a measurement, not a setting.

- **`AGENT_ORIGIN` is a BUILD input, and it is the whole of "zero config".**
  `AGENT_ORIGIN=https://... npm run build` bakes the origin into the bundle AND
  declares `host_permissions` for that one host, so a distribution build opens
  already on Cloud AI with nothing to type and no runtime prompt. An unset build
  is unchanged: nothing configured, on-device by default. It is validated in
  `wxt.config.ts` - https, no wildcard, real hostname - and anything else yields
  NO host permission rather than a broad one. A host permission for the agent
  server grants FETCH to that host and no page access whatsoever; page access is
  still `activeTab` plus a deliberate per-site grant. `manifest.test.ts` re-runs
  the config with the variable set and asserts at most one non-wildcard entry.
  It is seeded into the stored deployment on FIRST RUN ONLY - re-applying it on
  every service-worker wake would silently undo a user who switched to on-device.

- **The endpoint is baked; the TOKEN is not.** A credential in a bundle is a
  published credential. `AGENT_AUTH_TOKEN` is pasted into the panel once per
  browser session and lives in `storage.session`.

- **`OPENAI_API_KEY` and `AGENT_AUTH_TOKEN` are two secrets going opposite
  ways.** The first is what the SERVER presents to OpenAI; the second is what the
  server REQUIRES from the extension. Conflating them hands the model provider's
  key to every browser that connects. Neither ever appears on `/health`, in a log
  line, or in an error body - `maskCredentials` scrubs the provider's own error
  text before it is forwarded, because OpenAI happens to mask its key and that is
  OpenAI's courtesy rather than our guarantee.

- **The model load is NOT a prerequisite, and `retain`/`bake` never needed one.**
  `bake` is `applyPixelOps` over an RGBA buffer plus an encode - pure canvas. It
  called `#ready()` for no reason, and `retain` called it "because bake requires
  one", which was circular. Between them they made the weights a prerequisite for
  the DEFAULT configuration, which runs no model: every step refused until
  somebody pressed Load model and waited for a WebGPU adapter that then went
  unused. Only `detect` requires init now, and the load starts on its own when
  the panel opens WITH VISION ON. `ensureModelLoading` deliberately does not
  retry a FAILED load - it would fail again for the same reason - so the button
  survives as a retry.

- **A sleeping host and a dead one are different facts.** `BackendHealth.waking`
  splits them on the DOMException name `AbortSignal.timeout` produces. The panel
  says "Connecting to AI server..." for a timeout and "Unavailable" for a refused
  connection; reporting them identically tells a user their server is down at the
  moment it is coming up. Note the regex: a browser says `Failed to fetch`, undici
  says `fetch failed` - different word order, and matching only the first worked
  in every browser-shaped test.

- **An access token is bound to a HOST, not to a backend slot.** `backendTokens`
  is keyed by ORIGIN and resolved through the endpoint on every read. Keyed by
  KIND - the obvious-looking version - re-pointing the one `cloud` row at a
  different provider carried the previous provider's bearer token to it, and the
  panel's own post-save health check fired it before any step ran. A stored map
  keyed by kind is REFUSED on rehydration rather than migrated.

- **The deployment cannot change while a task is running.** `runTask` builds one
  backend and one `StepInput` and the loop reuses both for up to eight steps, so
  a mid-run switch changed nothing except the label - the panel and the receipt
  would say "On-device (no network)" over a run still POSTing to a cloud. The
  three `deployment/*` commands refuse while `loopRunning` and the panel disables
  the controls. Stop first.

- **`server/origin` is LOOPBACK ONLY, and must stay that way.** It used to guess
  the kind from the URL and the current selection, so pasting a vendor URL with
  `private` selected replaced the organization's endpoint, kept `private`
  selected, and sent every later context to a third party under the label
  "Private Organization Server". An https endpoint has to be filed under a kind
  the user names, through `deployment/configure`.

- **`ANY_PLACEHOLDER_RE` carries `/g`. Never call `.test()` or `.exec()` on it.**
  Both resume from `lastIndex`, so consecutive calls alternate true/false
  regardless of input - which is what `sanitize.ts` did three times per element,
  making `DataAtom.redacted` wrong for roughly half of them. Use
  `hasAnyPlaceholder`. `.replace()` and `.match()` are safe and rely on the `/g`.

- **The new integration suites run in `node`, NOT jsdom, and must stay that
  way.** Under jsdom the `AbortController` comes from jsdom while `fetch` comes
  from undici, which rejects the foreign signal - so every request fails as a
  TRANSPORT error, which is exactly the failure mode those files exist to
  distinguish from a real one. A leak test would pass because nothing was sent.
  `ensureDomParser()` supplies the one DOM API the pipeline needs.



- **The model loads, but has never been run in a browser.**
  `TransformersBackend` is implemented and covered by 32 tests against a fake
  library; `npm run vendor:model` puts the weights in `public/`; the panel's
  Load model button sends `host/init`. What has NOT happened is a real load in a
  real browser - no WebGPU adapter has been acquired, no forward pass has run
  through this code path, and the spike is the only place a real inference has
  ever happened. Treat "loaded" in the panel as the first thing to verify, not
  as established. `StubPerceptionEngine` still replays `*.vision.json` for the
  parts that do not need weights.

- **Verified against real weights.** Ollama 0.33.2 + `qwen2.5:3b` on an
  RTX 4050: a real context produced `{"type":"click","ref":"e2"}` in 237 ms
  server-side (~500 ms warm, 34 s cold load), parsed, validated, and resolved to
  a real `searchbox`. 3537 MiB VRAM resident, 46 C. The prompt needed a SHAPES
  block first - the model guessed `"element"` for the ref key, which the prompt
  named in prose but never showed.

- **The server exists and speaks to a real VLM.** `server/main.ts` +
  `server/agent-http.ts` (outside `src/`, because `node:*` is forbidden inside
  it) run `handlePlanRequest`. `VlmPlanner` calls any OpenAI-compatible endpoint
  - vLLM, Ollama, llama.cpp, Together, Groq - and sends the redacted screenshot
  as an image part when one is present. `npm run server`; set `VLM_ENDPOINT` and
  `VLM_MODEL` or it runs `HeuristicPlanner` and says so on `/health`. What has
  NOT happened is a run against real weights.

- **Person names in free prose are not detected.** Needs NER or

  OCR-plus-classification. Recorded as `mustRedact: false` in

  `profile-pii.truth.json` with a note. This means a display name on a profile

  page currently reaches the server.

- **The content script is registered nowhere.** It used to declare
  `matches: ['<all_urls>']`, which Chrome grants at install - the extension read
  every page from the moment it was installed, which is the wildcard this
  project says it refuses to ship. It is now `registration: 'runtime'` with no
  `matches`, so no manifest key grants page access. Nothing injects it yet: that
  needs `scripting.executeScript({ target: { tabId } })` behind a user gesture.
  Until then the content script does not run in any page.
- **The origin grant exists; the loop that would use it does not.**
  `agent-server/origin.ts` is the single pinned `permissions.request` call
  site (`boundaries.test.ts` enforces that). The sidebar has an input and a
  Grant access button, and the handler stays synchronous down to the request -
  the first `await` would forfeit user-gesture status and the prompt would
  never appear, with no error to notice. What is still missing is anything
  that USES the granted origin: `runAgentStep` is never called.
- **`optional_host_permissions` keeps `https://*/*` deliberately.** Chrome
  requires that any origin passed to `permissions.request()` already appear
  there, so "the user supplies any origin at runtime" forces a broad optional
  pattern. Narrowing is structural, in `deriveOriginPattern`, which refuses
  wildcards and non-loopback http - not cosmetic, in the manifest.
- **No programmatic close, and close behaviour differs.** Firefox `toggle()`
  closes on a second click; Chrome's `sidePanel.open()` has no counterpart, so
  Chrome users close via the panel's own control. `sidebarAction.close()` is
  itself gesture-gated, so auto-dismissing the panel at the end of an agent loop
  is not available on either browser.
- **No keyboard shortcut.** `commands` is undeclared; the toolbar button is the
  only way in.
- **Do not add `icon-light-*.png` / `icon-dark-*.png` to `public/`.** Now that
  `action` exists, WXT auto-injects Firefox `theme_icons` from those exact
  filenames with no config change and no build error. MDN's `light`/`dark`
  semantics are inverted from the intuitive reading (`light` = shown on a *dark*
  toolbar), so the realistic outcome is a button invisible on one theme.
- **The icons are placeholder art** -- procedurally generated two-tone PNGs from
  `scripts/make-icons.mjs`. Fine for a demo, not a designed mark.
- **`FirefoxBackgroundPageHost` is written but never constructed.**
  `perception/host/firefox-bgpage.ts` exists and is tree-shaken out of both
  bundles; `background.ts` uses `UnimplementedHost` instead. It is not a
  drop-in - `ensureStarted()` spawns no worker and the constructor wants a
  `dispatch` that does not exist. Zero tests cover the host layer.
- **Neither build ships an icon.** No `icons` key, no `action`, no
  `sidebar_action.default_icon`. Firefox needs the sidebar icon explicitly (it
  does not fall back to `icons`), and 128x128 PNG is a Chrome Web Store blocker.
- **Action execution is implemented but unverified in a browser.**
  `execution/actions.ts` performs click/type/select/scroll/key/navigate against
  the DOM and is covered by 18 jsdom tests. It has never run in a real page.
- **The ref -> element map is a client-side derivation, not a guarantee.**
  `extractRefPaths` walks the same elements `extractElements` numbers, but it
  walks the REDACTED document while the content script resolves against the
  LIVE one. Redaction can remove nodes, so a path may not resolve. That
  degrades to a reported miss in `executeAction`, never to a click on the wrong
  element - but a step can fail for a reason that looks like a stale page.

- **Two task shapes work end to end, verified in Chrome.** Text entry
  ("search for laptop") types, submits, then reports done. Click ("go to the
  profile") clicks once, then done. Both planners act on at most one candidate
  per score tier - a rule added after "Open Laptop Pro" opened five products and
  "search for laptop" filled a payment form's expiry date. Multi-step flows whose
  later steps share no words with the goal remain out of reach for the baseline;
  that is the VLM's job.

- **One task shape works end to end, verified in Chrome.** A text-entry goal
  ("search for laptop") types, submits, and reports `done` on the next step -
  two steps, page changed, no other field touched. Probed across goal shapes,
  only text-entry produces an action: `click` needs a literal word overlap with a
  control's accessible name, and no planner emits `select`, `scroll` or `key`.
  Two of the nine test-lab scenarios are reachable today.

- **The loop exists and is bounded.** `orchestrator/loop.ts` runs steps until
  one of seven stop conditions fires (done/abort/ask_user/error/cancelled/
  no-progress/max-steps, ceiling 8). The panel has Run task and Stop beside the
  single-step button. `done` is the only reason reported as success.

- **The agent loop has a caller, and it plans locally.** The panel's Run one
  step button sends `agent/step`; the background composes `runAgentStep` with
  `LocalPlannerClient` - an on-device baseline that reaches no network. Because
  `PlanOutcome` carries a raw string rather than a typed `Action`, its output
  still goes through `parseAction` + `validateAction` exactly as a hostile
  server's would. Swapping in `HttpAgentClient` is one line. What has NOT
  happened is a real step in a real browser.

- **`allowedOrigins` is empty for the local planner**, so a `navigate` action is
  refused by design. A baseline with no server has no business navigating; this
  becomes real only when a server origin is actually in use.

- **One tab, pinned at grant time.** `activeTab` is granted by the TOOLBAR click
  and only to the tab active at that moment, while the panel is per-window and
  outlives any tab. So the background records the tab on click and spends that
  grant later, rather than resolving "the active tab" when a step runs - which
  would drive whatever the user happened to be looking at, and fail. Navigation
  and tab close revoke the grant, and `tabs.onUpdated`/`onRemoved` clear it so
  the panel can say "page access lost" instead of leaking a raw Chromium
  host-permission string. **This is why an agent loop cannot run on `activeTab`
  alone: the loop's own clicks navigate, and each navigation revokes the access
  the next step needs.** Multi-step work needs `permissions.request` on the
  site, which the sidebar CAN do - unlike `activeTab`, that API accepts a
  gesture from any extension page.

- **`captureVisibleTab` is per-window, not per-tab.** It returns whatever tab is
  visible in the window it is given; the tabId is not a selector. If the user
  switches tabs mid-step the screenshot would show a different page than the DOM
  snapshot, and vision boxes would be merged against markup they do not belong
  to - plausible-looking and wrong. The capture wiring refuses unless the
  attached tab is the active one.

- **The package is 59.95 MB per browser.** 26 MB weights + 32 MB ORT wasm, the
  rest is code. Both wasm builds ship: `.jsep.` for WebGPU and the plain build
  for the fallback path, and dropping either removes a working configuration.
  `tests/built/bundle.test.ts` holds a 64 MB ceiling as a tripwire - if it
  fails, the question is what got added, not what the number should become.

- **The vision model cannot produce most of the PII kinds the pipeline
  handles.** `Xenova/yolos-tiny` emits COCO classes; of the ten labels
  `labelToPiiKind` understands, only `person` is one. `signature`,
  `id-document` and `credit-card` are unreachable through vision. On a real page
  it returned 0 boxes in 1626 ms - 96% of the step - while every detection and
  both redactions came from the DOM scan. Metrics 1 and 2 are currently carried
  entirely by `scanDom`. See DECISIONS.md; this is a model-selection question
  for `bench.ts`, not a bug.

- **Redaction runs in different places on the two browsers.** `redact()` needs a
  `DOMParser`, which Chrome's service worker does not have and Firefox's event
  page does. `DomPipeline` is the seam: `createInProcessDomPipeline()` on
  Firefox and in tests, `createRemoteDomPipeline()` on Chrome forwarding to the
  offscreen document. The redacted `Document` never crosses a boundary - it is
  retained on the far side and addressed by handle. `StepDeps.dom` is required
  precisely so a new call site cannot silently reintroduce the in-process path.

- **Cleared from the host/state sweep.** All five items are now closed:
  Firefox's event-page unload is reconciled the same way Chrome's teardown is
  (`hostStatusEvent` clears a stale `loaded` when the host is gone, and a step
  refuses up front rather than failing inside `detect`); retained frames are
  released explicitly by the step that captured them, on every path including
  failure; vision detections take the per-session salt through `init`; `e2eMs`
  is carried on a new `step/done` event instead of being summed from
  overlapping stages; and `answerOffscreen` moved into `perception` so a test
  drives both halves of the Chrome wire protocol against each other.

- **The screenshot is redacted to the same standard as the text, and refuses
  otherwise.** A real run sent an image with `0 pixel op(s)` while the text
  beside it had five values stripped. Three fixes: `pixelCoverAll` sweeps every
  applied detection rather than only vision-only ones; the content script stamps
  real `getBoundingClientRect()` geometry onto a CLONE before serialising,
  because a parsed document has no layout and `data-test-rect` exists only on
  fixtures; and `step.ts` now refuses to send an image when redactions applied
  but nothing covered them. The step still completes and still plans - it just
  goes text-only. See DECISIONS.md.

- **A frame that failed inference is still bakeable, and so is one that was
  never inferred.** Retention used to be a side effect of `detect`, so the vision
  breaker skipping detect meant the frame never reached the worker and `bake`
  died with "no retained frame ... It was never detected" - taking the whole
  step. Two changes: retained after decode rather than after the forward pass,
  and `retain` is now its own worker command that the skip path calls. Decode
  failure and size mismatch still refuse. A failed bake now costs the image
  only; it no longer ends the task.

- **The screenshot guard is PER DETECTION, and the geometry attribute is ours.**
  It was `appliedCount > 0 && pixelOps.length === 0` - an aggregate that ONE op
  disarms, so a page with one coverable and one uncoverable PII item sent the
  image. And `data-test-rect` was page-authored until `stampGeometry` began
  clearing it, so a hostile page could mint that one op itself. Both fixed
  together; either alone leaves the other exploitable. It refuses more often now,
  including on pages whose PII is genuinely unpainted - relaxing that needs a
  paint classifier this repo has no measurement for, and the obvious version is
  unsound (a selected `<option>` reports no client rects while being painted).
  ONE exemption exists, and it is spec-derived rather than layout-derived:
  `<input type="hidden">`, which the UA stylesheet sets `display: none
  !important`. `redact()` reports those as `unpaintable` and the guard skips
  exactly those ids. Without it, `glow-validation-token` withheld the screenshot
  on EVERY amazon.in page. Do not widen it to `data-sih-unrendered` - see
  `<option>`.

- **`renderElement` honours `geometryOmitted`.** It emitted `box=`
  unconditionally while the budget's first lever is to drop geometry, so every
  estimate after that lever fired overfilled the window. Note `.map(renderElement)`
  passes the array INDEX as the second argument - the call site must be an
  explicit arrow.

- **`bake 0 pixel op(s)` is not evidence of a leak.** A screenshot shows the
  VIEWPORT; the DOM scan reads the whole document. PII below the fold is redacted
  in the text and was never in the picture, so no pixel op can apply and none
  needs to. That reads identically to ops covering visible PII that failed to
  land, which IS a leak. `applyPixelOps` now counts `outsideFrame` separately,
  the counts travel to the panel (`9/15 pixel op(s), 3 off-screen`), and the step
  refuses to send when `opsRequested - opsOutsideFrame > opsApplied`.

- **The vision breaker resets at task start.** `resetVisionBreaker()` had ZERO
  call sites while its own comment and DECISIONS.md both claimed it ran on model
  load, so the breaker was a one-way latch for the life of the worker - three
  timeouts and every later step silently skipped vision while reporting ok. Model
  load is unreachable as a hook (the panel disables Load model once loaded), so
  `runAgentLoop` calls it instead. Single-step runs keep the latch deliberately.
  Both orchestrator test files now reset it in `beforeEach`: it is module-level
  state, and a tripped breaker used to leak between tests.

- **The context budget counts an image as TOKENS, never as base64 bytes.**
  Dividing 53 KB of base64 by the text bytes-per-token ratio valued one
  screenshot at ~26,500 tokens, so the budget shed 55 of 63 elements to its floor
  and still reported `27506/3400`. `imageTokens` is a flat reserve (~1200 for a
  768 px JPEG). The escalation drops names, then geometry, then the SCREENSHOT,
  then elements - the image goes before any element because it is worth about
  eighty of them and the benchmark scored screenshot-on and -off identically.

- **An `ask_user` question is neutralised and capped at PARSE, and refused if it
  solicits a credential.** It is the one server-authored string rendered to the
  user as prose, above the input box, and it arrived raw - no neutralisation, no
  cap, newlines intact. A hint line beside it is not a defence.

- **The agent CAN see its own typing - this entry was stale - but it acted as if
  it could not.** `copyLiveControlState` in the content script copies the live
  IDL `value` onto the clone before serialisation, so a filled field, a
  `<select>` and a checkbox all survive into the snapshot. Verified by running
  the real pipeline over an input carrying a typed value and reading the rendered
  row: `ref=e1 role=textbox name="Search Amazon.in" value="iPhone 17" TYPEABLE`.
  The value survives redaction, reaches `SanitizedElement.value`, and
  `renderElement` emits it. The last clause is now ALSO closed - see below.

- **`execute` reads the field back and says what actually landed.** It used to
  assign `.value` and return ok unconditionally, so typing "next Friday" into an
  `input[type=date]` - which the spec requires the browser to sanitise to "",
  synchronously, on assignment - was reported to the agent, the panel and the
  receipt as a completed step. `classifyFill` is adapted from ego-lite
  (citrolabs, MIT) `page-actions.ts`: `exact | equivalent | transformed |
  appended | unchanged`, of which the first three are SUCCESSES. Transformed
  being a success is what makes it usable - a field that reformats a card number
  or upper-cases a code did accept the input, and refusing those would fire on
  exactly the inputs most likely to have a formatter. Two differences from the
  original, both deliberate: a `<select>` is held to exact/equivalent, because its
  value comes from a closed set and an absent option yields "" which would
  otherwise read as an accepted `transformed`; and the read is SYNCHRONOUS
  (ego-lite polls 5x50 ms, which it can because its fill is async over CDP) - so
  this catches spec sanitisation and not a framework that resets the field in a
  later task.

- **A no-op retype is refused before the request leaves.** A real amazon.in run
  ended `repeating - planned {"type":"type","ref":"e4","text":"iPhone 17"} 3
  times in a row`. All three EXECUTED, and the model was shown `value="iPhone
  17"` on that element each time. Typing text a field already holds cannot change
  the page, so `ValidationContext.currentValues` carries what we sent and
  `validateAction` refuses with `already-typed` - which is CORRECTABLE, so the
  model gets one turn with the refusal in front of it. Three limits, all
  deliberate: values that were REDACTED or TRUNCATED are omitted (the model saw a
  placeholder, not the text, so typing the real thing is not a repeat), the
  compare is CASE-SENSITIVE (fixing capitalisation is a real edit), and it is
  checked AFTER `not-typeable`, which is the more useful thing to say.
  It does NOT fire when the retype carries `submit:true` - that submits, which is
  not a no-op - and its detail names that exact JSON. It used to fire regardless
  while telling the model to "submit it", so a model that obeyed was refused a
  second time and the real run aborted. Measured after the fix on the saved
  amazon.in page: retype -> refused -> re-plan `{"type":"type","ref":"e15",
  "text":"iPhone 17","submit":true}` -> accepted.

- **The panel timeline names what the model asked for.** `type e4 "iPhone 17"
  + submit`, `abort: <reason>`, `done: <summary>` - it used to print the verb
  alone, so a failed run could not say what was typed or why it stopped. The
  abort reason is neutralised and capped at PARSE, like an `ask_user` question,
  because it is now rendered to the user.

- **The server logs one line per plan, and never page text.** `[plan] 113 el,
  48.2 KB, no image -> type e4 +submit (1516 ms model, 1522 ms total)`. Verbs,
  refs and counts only - no typed text, summary, reason or element name, because
  on Render that line lands in a hosted log store. `AGENT_TRACE_DIR` is the full
  record (rendered prompt, raw reply, correction, timings, image SIZE only) as
  JSON lines, and is opt-in: the prompt is sanitized, but it is still a record of
  which pages a user visited. Leave it off on anything hosted.

- **The server keeps an Ollama model resident, because Ollama unloads it after
  five idle minutes.** The first plan after a user answered a question took
  8,227 ms against ~350-1,600 ms warm, and `/api/ps` listed nothing loaded.
  `start()` preloads via native `POST /api/generate` (model, `keep_alive`, no
  prompt) and repeats that after EVERY plan, because the OpenAI-compatible call
  resets the timer to Ollama's default. `VLM_KEEP_ALIVE`, default `30m`; `off`
  and `0` disable it (to Ollama, `0` means unload immediately). The cost is ~3 GB
  of VRAM held for the window, on the GPU the extension's WebGPU vision shares.
  The panel's slow-plan notice for `local` now says "loading the model", not "a
  free-tier server waking from sleep".

- **`verify:server` re-plans exactly as the extension does.** It imports
  `CORRECTABLE_REFUSALS` and `composeCorrection` from the orchestrator, so the
  CORRECTION it sends is the shipped wording - the thing being tuned. It used to
  stop at the first refusal and report FAIL on replies the extension recovers
  from. It also crashed once `ValidationContext` gained `currentValues`:
  `test-site/` is NOT typechecked, so it now calls `validationContextFor` instead
  of hand-building a copy.

- **The model omits `submit` on search boxes, and that costs a step.** Measured:
  `search for macbook air` -> `{"type":"type","ref":"e15","text":"macbook air"}`
  with no `submit`, although SHAPES shows `"submit":true`. The next step retypes,
  is refused `already-typed`, and the re-plan submits - a search converges in two
  steps instead of one. Defaulting `submit` for `role=searchbox` would save the
  step, and would be the client rewriting an action the model sent. Not done.

- **The model reads SANITIZED HTML and names elements by `target`, never by
  ref.** `extractPage` (sanitize.ts) adds each element's tag, a closed attribute
  set and its enclosing containers; `renderPageHtml` (prompt.ts) draws the
  outline; `resolveTarget` (contracts/target.ts) maps the model's `target` onto
  exactly the elements sent. Refs remain INTERNAL execution handles - the
  content script and its stale-target guard are unchanged - and the model is
  never shown one. Our own on-device planners still send `ref`.

- **`HTML_ATTR_NAMES` is closed, and the egress gate enforces it.** `id`,
  `name`, `type`, `placeholder`, `href`, `aria-label`. Anything else - `class`,
  `style`, `on*`, `data-*` - is refused by `inspectOutboundContext`, so "no CSS
  and no script leave" is a property of the payload. An attribute matching any
  PII pattern is DROPPED at extraction; `href` is origin + path only.

- **Several matches is a refusal; the client never picks.** `no-such-target`
  and `ambiguous-target` are correctable once, then the step ends and the loop
  re-observes. The one exception is several links to the same href. The
  refusal names attribute KEYS only ("they differ in: id") - it becomes the
  CORRECTION, outside the fence, and values are page text.

- **`box=` is written only when a screenshot is attached.** It was written on
  every row regardless, and the budget - which counts geometry only with an
  image - never paid for it. Tests look for it inside the page section only:
  rule 4b names `box="x,y,w,h"` in the instructions.

- **A small model copies example values.** `"name":"q"` in SHAPES came back on
  every search; a worked example's `"kw"` came back once. SHAPES now uses
  `<placeholders>`, followed by a worked example on a visibly different page -
  the example is what stopped premature `done`. Never put a realistic name in
  either.

- **The local 3B model composes targets worse than it picked refs.** Measured on
  amazon.in: the ref format clicked the right product and its Add to cart; the
  HTML format types a search on both goals. The format is designed for Gemini
  and has NOT been measured with it. See DECISIONS.md.

- **The TYPEABLE marker is gone.** The HTML tag says it - `<input>`,
  `<textarea>`, `<select>` - and a non-native field keeps its `role`. This
  supersedes the "typeability is a MARKER" entry above.

- **The screenshot is ON by default now**, as a design decision: HTML for
  structure, the redacted image for layout. The earlier measurement (a tie on
  text-rich pages) still stands, and the toggle still turns it off.

- **An unparseable reply gets one re-plan; it used to end the task.** Found on
  gemini-3.5-flash-lite: `{"type":"wait"}` with no `ms`, one step after reaching
  the right product. `wait` now defaults to 1,000 ms and SHAPES shows it. The
  correction repeats the parse detail only for codes built from our own key
  names (missing-field, bad-field-type, out-of-range); never the model's words.

- **The wake notice needs the endpoint to have been quiet for 5 minutes.** A
  cloud model routinely takes longer than the 2.5 s threshold, and "waking from
  sleep" on every step of an awake server is a wrong explanation.

- **The Render deployment serves whatever prompt it was last deployed with.**
  A client change reaches Gemini at once; a PROMPT change reaches it only on a
  server redeploy. Check `/health`'s `prompt` fingerprint against
  `promptFingerprint()` before reading a cloud run as evidence about a prompt.

- **A same-site link that asks for a new tab opens in the attached tab.** 62 of
  106 amazon.in product links carry `target="_blank"`; the new tab took focus,
  the capture guard refused the now-hidden tab, and the task died one step after
  succeeding. `target` is `_self` for the click only, then restored. Cross-site
  new tabs are untouched. And a task's end re-runs `followActiveTab`, because
  following is suspended while one runs.

- **`within` is exact-first.** A sponsored listing's title CONTAINS the organic
  one's, so "contains" matched both and the model looped on a correct target.

- **The execution ref-map anchors on a unique id/name, not only a positional path.**
  `canonicalPath` is a `tag:nth-of-type` chain from <html>; between the snapshot
  and the click (seconds later, on a live commercial page) any same-tag sibling
  the site inserts, or a node redaction removed, shifts it and it resolves to the
  wrong element or null. A real amazon.in run died on it: the model chose
  `input[name="proceedToRetailCheckout"]`, `resolveTarget` matched it, and every
  click reported `failed`, looping to `repeating`. `extractRefPaths` now emits
  `[id="..."]` / `tag[name="..."]` when unique in the walked set, else the
  positional path. EXECUTION MAP ONLY - `canonicalPath`, the fast walk and the
  `isSensitive` join are untouched; the stale-target guard still runs on whatever
  resolves. If a control resolves but a synthetic `.click()` still does not
  advance (a site demanding a trusted event), that is a DIFFERENT, unfixed
  problem - it reports ok with an unchanged page, not `failed`.

- **`detectAmbiguity` runs only for `local` and `on-device`.** It exists because
  qwen2.5vl never asks; on two Gemini runs it asked about "+1 other
  color/pattern" and Amazon's suggestion chips while Gemini asked a good
  question of its own. Hosted backends ask for themselves.

- **The loop settles before it judges.** After an executed action it waits for a
  navigation to begin and finish (`settle`: 600 ms, then tab `complete`, 8 s
  cap) BEFORE the page check. It used to check at once, report "did NOT
  change", and let the next step re-click on a page mid-navigation.

- **First end-to-end success on the HTML format**: Gemini on amazon.in searched,
  asked 14 vs 16 inch, opened the product, clicked `#add-to-cart-button`, done.

- **The local model is `qwen3-vl:4b-instruct`, pinned to 8k as `qwen3-vl-8k`.**
  On a replayed three-page amazon.in task qwen2.5vl-3b copied field names from
  the prompt's example and typed searches where a click was needed; qwen3-vl
  picked the product and targeted Add to cart. 3-7 s a step, 3.76 GB VRAM:
  keep vision off with it on a 6 GB GPU. `-instruct` has no thinking mode.

- **The 8k budget is where the local model loses information, so ranking and
  names matter there.** A text field keeps its +4 off screen (a scrolled
  search box was dropped); a short name made mostly of goal words gets +5 ("Add
  to cart" was outranked by links that merely say "MacBook"); and
  `accessibleName` clips long names in the MIDDLE, keeping the tail where a
  product title puts storage and colour - it was a silent `slice(0, 120)` that
  made three laptops identical.

- **`verify:server` has no layout, so hidden duplicates show up there.**
  Wikipedia's sticky search clone and Amazon's collapsed-accordion Add to cart
  are refused as ambiguous offline and are simply absent in a browser. Judge
  those steps in the extension.

- **The prompt budget is a QUALITY knob, not a capacity knob.** One model, one
  page, one goal, only the budget changed: 5,632 tokens sent 114 elements in
  691 ms and got the right element; 9,000 sent 197 in 1,377 ms and got the right
  element; 13,824 sent 335 in 2,023 ms and typed a page title into a footer link.
  Latency is linear in the prompt and accuracy is NOT monotonic - past roughly
  200 rows the extra elements are distractors, not information. So the clamp is a
  SAFETY limit that happens to land in the good zone, not an attempt to fill the
  window, and "as much as fits" is the wrong instinct. A 16k local model was
  built and measured (`qwen2.5vl-16k`, 101->249 elements on a real amazon.in
  page) and deliberately NOT made the default: it leaves ~310 MB of 6,141 MB
  VRAM, which starves the extension's own WebGPU vision context, and it measured
  worse on the page above. With vision OFF, 16k plus a ~9,000 budget was the best
  point measured.

- **Required-field detection does not work on real sites.** Measured: Google
  Flights, MakeMyTrip, Kayak and IndiGo all report zero `[required]`,
  `[aria-required]` and `input[type=date]`. Do not build a clarification feature
  on it.

- **The ANSWER constrains the element list; it does not instruct the model.**
  Measured: with the answer in the prompt, qwen2.5vl returned the identical ref
  whether the reply was "Gaming Laptop" or "Laptop Pro". `narrowByClarification`
  removes the candidates the user ruled out, matching on DISTINCTIVE words (every
  candidate shares the goal term, so raw overlap ties). It refuses to narrow when
  the answer matches none or all. Detection is restricted to ACTIONABLE roles and
  scoped to the candidates matching the goal best - asking about headings
  produced a question no answer could act on.

- **The agent asks when the goal is ambiguous, and the MODEL is not what
  decides.** qwen2.5vl never volunteers `ask_user` - same reply whether the rule
  sits in the RULES block or at the end of the prompt - so `detectAmbiguity`
  fires deterministically on the client, before the server call, when a goal term
  matches 2-4 distinctly-named candidates of one role and no other goal word
  picks between them. The panel warns that no legitimate question needs a
  password or OTP: a compromised server could otherwise ask for one inside our
  own UI.

- **`boundaries.test.ts` uses a lookbehind, and it must stay.** The scanner read
  the string literal `'from', 'into',` as an import. Worse, the first fix wrote
  `` as a literal backspace and the regex matched NOTHING - the guard passed
  vacuously. Verify both directions after touching it: a real `node:fs` import
  must fail it.

- **Duplicate rows are collapsed BEFORE ranking, capped at 3 per (role, name).**
  Measured on a 150-product storefront: 250 rows carrying 40 distinct names, 151
  of them the identical button "Add to basket" - the model cannot tell them apart,
  so they bought no choice while distinct product links were dropped for them.
  After: 110 rows, 106 distinct names, 0 unnamed. Order matters - ranking
  duplicates lower still lets 151 of them outrank a heading. Unnamed elements are
  penalised, not excluded.

- **Refs are positional ordinals, and the budget filters without renumbering.**
  `extractRefPaths` walks the unfiltered document, so a compacted `e17` would
  name one element to the model and resolve to a different one in the page -
  validated, executed, reported ok, wrong. `tests/contracts/budget.test.ts` pins
  the exact survivor list; a membership check is NOT enough, because e1..e9 all
  exist in e1..e10.

- **`ExecutedStep.name` is captured at execution time.** `renderPrompt` used to
  label history by looking an old ref up in the CURRENT element list, so any page
  change - a search inserting two results - made it print a truthful ref beside a
  different element's name. It now resolves no refs at all, which is also what
  lets the budget drop an element without orphaning the history that mentions it.

- **A clamp that never ran is worse than no clamp, and `lastHealth` had ONE
  writer.** `effectiveBudget()` reads the context window out of `lastHealth`,
  which only the `deployment/health` message writes - sent by the panel's "Check
  connection" button and after `deployment/configure`, and by nothing on the path
  a user actually takes. The loopback Grant form selects `local` without probing,
  so a real amazon.in run sent `~14781/30000 tok` to a model serving 8,192.
  `ensureBackendWindow()` now probes before the budget is built on both step
  paths: once per backend per session, 8 s cap, FAIL-OPEN, and a failed probe is
  NOT cached (caching it would poison the panel's status row and suppress the
  retry). `lastHealth` is keyed by KIND, so it is dropped whenever an endpoint
  changes - the same hazard `backendTokens` records for tokens keyed by kind.
  Note `missingTokenRefusal` reads the same Map and had never fired either.

- **The clarification conversation did not survive the service worker, so the
  agent re-asked forever.** `pendingQuestion`, `lastGoal` and `clarifications`
  were module state carrying a comment saying they were deliberately not
  persisted - true of a RELOAD, silent about the ~30 s idle teardown that this
  same file documents for the attachment. The gap they must survive is a human
  reading a question and typing a reply, which is reliably longer than that. Now
  in `storage.session`. Two companion defects made it invisible and permanent:
  `sendAnswer` called `.then()` without checking `ok`, and `task/answer` RESOLVES
  with `{ok:false}` rather than rejecting - so a refusal ran the success path and
  re-ran the goal. And "Run one step" never passed `clarifications` in nor
  recorded `pendingQuestion` out, so it could neither accept an answer nor use
  one.

- **A control nobody can see must not be offered as a choice.** On amazon.in the
  agent stopped to ask "Which one did you mean - Cart, shift, alt, c, or 1 item
  in cart?" - two candidates for one destination. Two mechanisms produce that and
  both are now handled, because which one the live site used cannot be settled
  from this repo. (1) `accessibleName` fell back to `el.textContent`, which
  swallows every descendant including visually-hidden helper spans;
  `visibleTextOf` replaces it, skips hidden subtrees, is ITERATIVE (depth is
  attacker-controlled), and inserts a space between element contributions the way
  a browser does - `<span>a</span><span>b</span>` was yielding `ab`. (2)
  `isHidden` saw only the element's own attributes, because extraction runs
  against a `DOMParser` document with no CSS. `stampGeometry` runs in the CONTENT
  SCRIPT where layout exists and now marks unrendered elements
  (`data-sih-unrendered`); `isHidden` reads that and the stamped rect. The
  off-screen test is **horizontal only** - a negative Y just means the page is
  scrolled, and below-fold content is reachable - and the threshold is **-5,000
  px, not 0**, because a horizontally scrolled carousel is real content at
  negative X while `left:-9999px` is an order of magnitude further out. It errs
  towards KEEPING: dropping a real control makes a task impossible, carrying a
  hidden one only makes a list longer. Both signals are read through the same
  attribute both extraction walks see, so they cannot disagree about MEMBERSHIP.

- **`isOnScreen` tested three edges out of four.** Both vertical, and only the
  RIGHT horizontal one - so an element parked at `left:-9999px` satisfied
  `x < cssWidth` trivially, scored as on screen, and collected the on-screen rank
  BONUS. The asymmetry did not merely fail to demote a hidden control, it
  promoted it above real ones.

- **A stored deployment used to be WIPED on every service-worker wake, by a
  dangling `else`.** `if (restored !== null) deployment = restored;` was
  unbraced, and the `else` meant for it sat two statements below - so it bound to
  the intent-adoption `if` and `deployment = seededDeployment()` ran whenever
  ADOPTION was skipped rather than whenever nothing was stored. Since
  `persistDeployment` writes intent alongside config, everyone who used the
  panel's radio buttons had a stored intent, which skipped adoption, which fired
  the seed. Chrome unloads an MV3 worker after ~30 s idle, so a local server URL
  had to be re-entered after nearly every pause and the run in between planned
  on-device while the panel said `local`. The decision is now the pure
  `restoreDeployment` in `contracts/deployment.ts` - moved there for the reason
  `orchestrator/attach.ts` was, that `background.ts` cannot be unit tested - and
  `tests/contracts/deployment-restore.test.ts` pins it. The permission-dependent
  DEMOTION stays in `background.ts`: asking the browser what is granted is not a
  pure question.

- **Intent is recorded in TWO places, not one.** `deployment/select` said it was
  "the ONE place", which was false for the `server/origin` loopback form - the
  path somebody setting up a local server actually takes. It set
  `backend: 'local'` without touching `intendedBackend`, so a user whose earlier
  intent was `cloud` got selection `local` against intent `cloud` and
  `backendMismatchRefusal` refused every run, advising them to "re-select cloud"
  - the opposite of what they had just chosen. Automatic writes to
  `deployment.backend` (demotions) still leave intent alone deliberately; that
  difference is what the guard reads.

- **The panel's site origin was cached at mount, and the agent follows tabs.**
  `grantSite()` read a module variable written only by `refreshStatus()`, which
  runs once when the panel opens, while `state.attachedTab.origin` updates on
  every attachment change. So the one in-UI route to the durable per-site grant
  that `runTask` requires refused outright on a panel opened before any tab was
  attached, and after a tab switch requested permission for the PREVIOUS site -
  granted by the user, leaving the site they were on unreachable. It now reads
  the live reducer state, which `apply()` assigns synchronously, so the user
  gesture still survives - the only reason the cache existed.

- **`maxPromptTokens` is a panel setting, defaulting to 30,000.**
  It was 3400, sized for Ollama's stock 4096 window, and this entry said so long
  after `DEFAULT_BUDGET_POLICY` moved. On a SEARCH page the budget is slack -
  measured on amazon.in, 337 available elements cost ~15.5k of 30k and dropped
  none, and the duplicate collapse is what removed rows. On a PRODUCT page it
  binds hard: 633 available, 520 sent, 53 dropped, ~30000/30000. An earlier note
  here said the clamp only binds past roughly 1,000 rows, measured on a synthetic
  storefront; a real product page reached it at 633. `MAX_PROMPT_TOKENS` is
  32,000 in `background.ts`, chosen for Qwen's window, so a model with a much
  larger context cannot currently be given one.
  The old note follows, and the Ollama reasoning still explains the LOWER bound: Raise it to match a bigger server and the `box=` geometry comes
  back - at the default a 63-element page with a screenshot reports `geometry
  omitted`, which is the escalation working, not a fault. Clamped
  1200-120000 in the background, not in the input.

- **The window IS discoverable now, but only by the SERVER, and the setting is
  clamped to it.** The line above used to end "it is NOT discoverable: the
  OpenAI-compatible body has no field reporting the window", which is still true
  of that surface - `GET /v1/models/<id>` on Ollama answers
  `{id, object, created, owned_by}`, verified. Ollama's NATIVE `/api/show`
  reports it, so `server/main.ts` asks once at startup exactly as `verifyModel`
  does, publishes it as `/health`'s `vlm.contextWindow`, and `effectiveBudget()`
  clamps the prompt to `window - 2560`. **This was not cosmetic.** The local
  model serves 8,192 against a 30,000 default, and Ollama TRUNCATES an over-long
  prompt rather than refusing it - dropping the tail, where the element list,
  ALREADY DONE and CORRECTION all live. Measured on one page and one goal:
  30,000 returned `{"type":"done","summary":"..."}` and 5,000 returned the
  correct `type` at that page's search box. Read `num_ctx`, NEVER
  `model_info["<arch>.context_length"]` - both are in the same response and on
  this machine they are 8,192 and 128,000. The clamp is only ever DOWNWARD, is
  announced to the panel, and `null` (a non-Ollama endpoint, or no pinned
  `num_ctx`) changes nothing: a fabricated ceiling would be believed.

- **`reasoning_effort` defaults to `low` and Ollama 400s on it.** Measured:
  `low` and `minimal` are refused with `"<model>" does not support thinking`,
  while `none` and OMITTING the field both succeed. The documented local recipe
  was therefore dead on arrival, with an error naming a parameter the operator
  never set. Two fixes: `VLM_REASONING=off` now reaches the planner as `null`,
  which omits the field - distinct from `none`, which is a VALUE the provider is
  asked to honour - and `VlmPlanner` retries ONCE without the field when the
  endpoint says it does not support thinking, remembering that for the life of
  the instance. Narrow on purpose: only a 4xx whose body names reasoning, so a
  400 about context length or a bad model id still fails as before.

- **The vision model is OpenCV YuNet, driven through ORT directly.** 232,589
  bytes and 30.3 ms p50, replacing yolos-tiny's 26,227,993 bytes and 1765.8 ms -
  which was over `DEFAULT_BUDGETS.inferMs` (1500 ms) and therefore scored zero on
  latency under this project's own budget. Package went 60.01 MB -> 33.54 MB.
  transformers.js cannot load it (seven dispatched architectures, none of them
  YuNet; no config.json), so `yunet-backend.ts` drives the session and
  `yunet-decode.ts` decodes the stride-8/16/32 head by hand. It emits the literal
  label `face`, which `LABEL_MAP` already had. **BGR CHW at raw 0-255** - RGB
  costs ~83% of detections silently, measured through this code: 66 faces vs 11,
  top score 0.918 vs 0.907.

- **YuNet is verified against real weights, and has now run in a browser.**
  `test-site/verify-vision.ts` drives the SHIPPED `YunetBackend` over the
  generated images: every planted face found (0.911-0.926), every control clean,
  32-53 ms, still 4/4 at 1920x1080 where faces are ~73 px in model space. In
  Chrome it reported `vision 0 box(es) via webgpu` in a 2042 ms step - correct,
  because that page had no faces, which is exactly why the test site now has
  some. Node-with-browser-wasm remains the caveat on the numbers; it rules out
  bad weights and undetectable images.

- **`contentRequest` re-injects the content script after a navigation.** The
  loop's own clicks replace the document and `ensureContentScript` ran only once,
  before the first step - so step 2 died on "Receiving end does not exist" while
  the permission itself survived. It retries ONCE and only for that error class:
  a content script that ran and reported a failure must not be re-sent, or
  `execute` could act twice.

- **The test site's product photos are face-detector controls.** A search for
  "laptop" must surface them and produce zero boxes; the headphones are
  deliberately adversarial (two dark ellipses over a curve) and measure 0. The
  reviewer pictures carry `alt="Verified buyer"`, which matches no
  `IMG_VISUAL_RULES` pattern - so a face reported on a laptop search came from
  the model and nowhere else. Faces are RENDERED procedurally by
  `make-images.mjs`, never photographs of real people.

- **Faces are all vision can reach.** `signature`, `id-document` and
  `credit-card` are unreachable through any model at this budget, as they were
  with yolos-tiny. `IMG_VISUAL_RULES` in `dom-scan.ts` covers them by regex over
  img alt/title/src/class, and now includes credit-card - one regex reaching a
  PII kind no model on the hub reaches, at zero bytes and zero ms.

- **`bench.ts` can now tell two models apart on quality, but not on cost.**
  `scoreFixture` used to `void visionDetections` and rescore from the recorded
  `*.vision.json`, so a model detecting NOTHING scored a perfect 1.000. Fixed and
  pinned by `tests/harness/bench-discrimination.test.ts`. Still broken:
  `makeEngine` builds a `StubPerceptionEngine` reporting `weightBytes: 0`, so
  `normaliseCost` returns a free 1.0 for every candidate. The `unlabelled-media`
  fixture is the only one where a model swap can move a score - every other
  fixture labels its images with alt text the DOM rules match without a model.

- **Vision is OFF by default, from measurement.** Steps ran 42-44 s with it and
  1.8 s without, both returning zero boxes, on a GPU where Ollama holds 2.9 GB of
  6 GB. `yolos-tiny` emits COCO classes `labelToPiiKind` mostly cannot use, so
  `scanDom` carries metrics 1 and 2 today. A panel toggle turns it on; it is
  default-off rather than removed because `bench.ts` exists to pick a better
  model and the toggle is how that comparison runs. Landing it required the
  `retain` command first - with vision off, `detect` never runs, so `retain` is
  the only path that puts a frame in the worker.

- **`renderPrompt` RUNS ON THE SERVER, not in the extension bundle.** Rebuilding
  the extension does not change the prompt; `server/main.ts` must be restarted.
  Two prompt fixes were evaluated against a stale server and both looked like
  they had failed. `/health` now reports `promptFingerprint()`, and the same
  function is exported from source - compare them before concluding a prompt
  change did nothing.

- **The full loop completes on a real page, verified in Chrome.** `add laptop pro
  to cart` finished in 4 steps at 2.2-3.7 s each, including a step where the
  planner emitted `type` at a button, was refused, re-planned, and executed the
  corrected `click`. `done` is the MODEL reporting completion; the test lab's
  console is the independent check that the page actually changed.

- **The heap is measured in the offscreen document, not the service worker.**
  `RuntimeStatus.heap` carries it, `sampleMemory` is async because reaching that
  context is a round trip, and `performance.memory` is JS-heap only so
  `jsHeapOnly: true` is set and the panel prints the source. Firefox reports
  null - "not measured", never zero.

- **Plan-only runs the whole pipeline and withholds the click.** For pointing the
  agent at a real logged-in page to verify redaction without letting it press
  anything. Wiring it revealed that the single-step path had been omitting
  `budget` and `screenshot` entirely, so "One step" and "Run task" were running
  different pipelines.

- **`test:built` mounts the emitted panel chunk.** v0.4.3 shipped a blank side
  panel - `let budgetTokens` declared below the `draw()` that referenced it, so
  first render threw a TDZ `ReferenceError`. `tsc` passes on that, there is no
  linter, and every other panel test exercises components rather than the
  entrypoint that mounts them, so 835 tests were green against a build that did
  not come up. `tests/built/sidepanel-smoke.test.ts` evaluates the real chunk
  against a stubbed extension API and asserts the root has content.

- **The IMAGE goes first in the multimodal request, the text last.** With
  `[text, image]` a real Amazon run came back with 621 characters describing the
  screenshot and no JSON - a vision model handed a UI screenshot as the last
  thing it reads captions it. The prompt also names that failure mode explicitly.
  Reasoned, not measured: two reproduction attempts with synthetic pages and
  images returned clean JSON, so the trigger seems to need a real screenshot of a
  real interface.

- **`promptFingerprint()` covers INSTRUCTIONS *and* `CLOSING`.** It originally
  hashed only the preamble, so an edit to the closing lines left the hash
  unchanged - a staleness guard that would have reported a stale server as
  current, which is the failure it exists to prevent.

- **Everything the model must ACT on goes AFTER the element list.** With history
  rendered above the elements, qwen2.5vl read `click e14 ("Add Laptop Pro to
  cart") ok` twice and clicked it a third time; the same text below the 69 rows
  produced `{"type":"done",...}`. `HISTORY` is now `ALREADY DONE`, placed after
  the data with the correction last. This also explains why the CORRECTION block
  worked when an identical history line did not - it was position, not channel.
  Rules, schema and the redaction scheme stay at the top, where one read is
  enough.

- **A correctable refusal is re-planned ONCE, with the refusal in front of the
  model.** Measured: qwen2.5vl at temperature 0 returns
  `{"type":"type","ref":"e14","text":"Add Laptop Pro to cart"}` at a BUTTON -
  right element, wrong verb - regardless of prompt wording, and returns
  `{"type":"click","ref":"e14"}` first try when handed a CORRECTION block naming
  the mistake. `PlanRequest.correction` is rendered LAST, after the element list;
  history was what the model had been ignoring. Bounded at one, and never for
  `unknown-ref` or `origin-not-allowed`. Carries ref/type/role only - never the
  element name, which is page-authored.

- **Ask the model directly before rewriting the prompt again.** Three rounds of
  wording changes were shipped before anyone POSTed the actual prompt to
  `/v1/chat/completions` and read the reply. It takes one request.

- **Typeability is a MARKER on the element, not a rule the model must apply.**
  Rule 6 always said `type` works only on a text field; a real run emitted
  `type` at a button, read "not a text field; use click for buttons and links"
  in HISTORY, and emitted the identical action again, ending on no-progress. The
  prose was correct and required the model to classify `role=` itself. Text
  fields now render `TYPEABLE`, exactly as `SENSITIVE` already worked, derived
  from the same `TYPEABLE_ROLES` set the validator uses - a test asserts the
  marker and the refusal agree element for element.

- **`type` at a non-typeable ref is refused before the request leaves.**
  The model picks the right element and the wrong verb - a real run emitted
  `{"type":"type","ref":"e41","text":"Submit Review"}` at a button, four times,
  ending in `no-progress`. `ValidationContext.typeableRefs` is built from the
  roles already sent, so the rule uses the same information the server was given.
  Prompt rule 6 states it too.

- **Running Ollama and the local vision model on one GPU starves both.**
  Measured on the RTX 4050: `qwen2.5vl:3b` holds 2.9 GB and total use sits at
  5376 of 6141 MiB, leaving ~765 MiB for the browser's WebGPU context. The
  170-230 ms forward pass recorded below was measured with no Ollama running.
  This is a deployment artifact of putting the "server" on the same laptop, not
  a bug - it disappears when `VLM_ENDPOINT` points elsewhere.

- **ONNX Runtime Web is ~21 MB of wasm + ~0.9 MB of JS** before any model

  weights. Measured while vendoring the spike. This is a direct hit on metric 4

  and is why `bench.ts` treats runtime size as a first-class axis.



---



## Measured on real hardware (do not re-derive these)

Spike, Chrome 151 / RTX 40-series / 16 cores. `Xenova/yolos-tiny`, WebGPU, fp32.
Full table, including one corrected measurement, in `DECISIONS.md`.

| | |
|---|---|
| Model size | **25 MB** (`onnx/model.onnx`) |
| Cold load | **116-205 s** - network-bound, not compute-bound |
| Forward pass p50 | **170-230 ms** across three runs, same GPU/dtype - see DECISIONS.md |
| `captureVisibleTab` | **23 ms warm**, 722 ms on the very first call |
| Capture quota | `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` = **2** |
| Peak JS heap | **100 MB**, excluding WebGPU buffers |

Three things follow:

1. **Bundle the weights.** 25 MB is small enough to ship inside the extension
   package, and the cold load is dominated by a slow network rather than by the
   model. Fetching from the hub costs a multi-minute first run for no benefit.
2. **Inference is the loop cost, not capture.** 168 ms forward pass against
   23 ms warm capture. The 2/sec capture quota is a real ceiling, but the loop
   will not get near it once a server round trip is included.
3. **Budgets in `bench.ts` are targets, not descriptions of reality.** They
   happen to be about right for this model. Do not widen one to make a number
   look better - `writeBudgets` is deliberately unwired from the test run to
   prevent exactly that.

**On trusting numbers in this file:** the first spike run recorded a 125 MB model
and it was wrong - a naive byte tally counted retries of a 25 MB file. Every
figure here is reproducible from `spike/`, and anything that surprises you should
be re-measured before it is designed around.
