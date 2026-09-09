/**
 * THE CLAIM LEDGER - the single source of truth for every factual statement on
 * this website.
 *
 * WHY THIS FILE EXISTS. A site whose entire argument is "other people overclaim"
 * cannot itself carry a number nobody can trace. Every figure rendered anywhere
 * on this page comes from here, carries a state, and carries the file or command
 * that produced it. Nothing is typed twice.
 *
 * THE FOUR STATES, and the difference between them is the whole point:
 *
 *   measured   Someone ran something and read the number off the output. The
 *              `source` says what was run and under what conditions.
 *   tested     An automated test asserts it. It has not necessarily been
 *              observed in a real browser.
 *   unverified Implemented, believed correct, never confirmed by observation.
 *   gap        A known limitation. Written down so it is not discovered later.
 *
 * `caveat` is not optional decoration. Several of these numbers are actively
 * misleading without it - the big-table timings are Node+jsdom, the vision
 * latency is the shipped runtime rather than a browser, and the 100% fixture
 * scores are on six pages this project wrote itself. A figure whose caveat does
 * not fit on the page is a figure that does not go on the page.
 *
 * `site/check-claims.mjs` asserts that the static fallback text in index.html
 * matches the `display` value here, so the two cannot drift.
 */

export const CLAIMS = {
  // ---------------------------------------------------------------- the model
  'model.bytes': {
    display: '232,589',
    unit: 'bytes',
    label: 'On-device vision model',
    state: 'measured',
    source: 'public/models/vendored.json',
    caveat:
      'OpenCV YuNet. It replaced a 26,227,993-byte model - 113x smaller. It emits exactly one label: face.',
  },
  'model.ms': {
    display: '30.3',
    unit: 'ms',
    label: 'Median forward pass',
    state: 'measured',
    source: 'DECISIONS.md - bench, 640x640, single thread',
    caveat:
      'Timed in the shipped ONNX runtime under Node, not inside a browser offscreen document. The comparable figure for the model it replaced was 1,765.8 ms in the same harness.',
  },
  'model.faces': {
    display: '0.911–0.926',
    unit: 'confidence',
    label: 'Every planted face found',
    state: 'measured',
    source: 'test-site/verify-vision.ts',
    caveat:
      'Against the shipped weights, 32-53 ms, still 4 of 4 at 1920x1080, every control image clean. The faces are drawn procedurally by a script - no photograph of a real person ships with this project.',
  },

  // ------------------------------------------------------------- the pipeline
  'pii.kinds': {
    display: '21',
    unit: 'kinds',
    label: 'Categories of sensitive data',
    state: 'tested',
    source: 'src/contracts/detection.ts',
    caveat:
      'Passwords, OTPs, API keys, cards, CVVs, bank accounts, IFSC, Aadhaar, PAN, passport, SSN, email, phone, names, addresses, dates of birth, IP addresses, faces, signatures, ID documents, and a catch-all.',
  },
  'pii.patterns': {
    display: '13',
    unit: 'validated patterns',
    label: 'Checksummed, not just shaped',
    state: 'tested',
    source: 'src/redaction/patterns.ts',
    caveat:
      'Luhn for card numbers, Verhoeff for Aadhaar, holder-type validation for PAN, allocated ranges for SSN. A pattern that only counts digits flags every order number on the page.',
  },
  'egress.fields': {
    display: '15',
    unit: 'permitted fields',
    label: 'Everything else is refused',
    state: 'tested',
    source: 'src/contracts/egress.ts',
    caveat:
      'The outbound gate refuses any key the sanitizer does not emit, rather than removing it. A gate that stripped the offending field and sent the rest would turn "we found a leak" into "we sent something".',
  },
  'nonce.bytes': {
    display: '16',
    unit: 'random bytes',
    label: 'Per-session redaction nonce',
    state: 'tested',
    source: 'src/entrypoints/background.ts',
    caveat:
      'Minted from the CSPRNG once per session. Without it a hostile page could print a redaction marker of its own and make the server believe a field was protected when it was not.',
  },

  // --------------------------------------------------------------- the proofs
  'tests.count': {
    display: '1,169',
    unit: 'automated tests',
    label: 'Across 61 files',
    state: 'measured',
    source: 'npx vitest run - 61 files passed, exit 0',
    caveat:
      'Including architecture tests that fail the build when a module imports what it should not, and type-level tests that fail the build if forbidden code ever starts compiling. This is engineering rigour, not proof of correctness - this project has twice shipped real defects through a fully green suite.',
  },
  'fixtures.score': {
    display: '100%',
    unit: 'on six pages',
    label: 'Detection and redaction precision',
    state: 'measured',
    source: 'npx tsx src/harness/report.ts - 6 fixtures, 0 leaks',
    caveat:
      'Nineteen planted values across six pages this project wrote itself, scored against ground truth it also wrote. It is a regression signal, not an accuracy benchmark, and it is not a measurement against real websites.',
  },
  'leak.test': {
    display: '0',
    unit: 'leaks',
    label: 'Raw values found in the request body',
    state: 'tested',
    source: 'tests/integration/backend-privacy.test.ts',
    caveat:
      'A real HTTP listener is stood up, the real client is driven through it, and the raw bytes the server received are searched for the exact planted identifiers - across three deployment modes and three pages.',
  },

  // ----------------------------------------------------------------- real runs
  'run.testlab': {
    display: '2.2–3.7',
    unit: 's per step',
    label: 'Four-step task, confirmed by the page',
    state: 'measured',
    source: 'DECISIONS.md - Chrome, project test site',
    caveat:
      'The page’s own console printed "Cart: 1 item(s)" - one item, the right one. That is an independent check, not the agent grading itself.',
  },
  'run.amazon': {
    display: '5.5 + 3.3',
    unit: 's',
    label: 'Two steps on amazon.in',
    state: 'measured',
    source: 'CLAUDE.md - Chrome, Gemini',
    caveat:
      'The agent asked which laptop, took the answer, clicked, and reported done. "Done" is the MODEL reporting completion - the cart state was never independently verified on that run. Five earlier attempts on the same site failed.',
  },
  'run.ollama': {
    display: '237',
    unit: 'ms',
    label: 'Plan returned by a local open-weights model',
    state: 'measured',
    source: 'DECISIONS.md - Ollama 0.33.2, qwen2.5:3b, RTX 4050',
    caveat:
      'Server-side, roughly 500 ms warm. The reply parsed, validated, and resolved to a real search box on the page.',
  },
  'capture.ms': {
    display: '23–26',
    unit: 'ms',
    label: 'Screen capture, warm',
    state: 'measured',
    source: 'spike/ - Chrome',
    caveat: 'Capture is not the cost of a step. The model thinking is.',
  },

  // ---------------------------------------------------------------- the build
  'package.mb': {
    display: '33.6',
    unit: 'MB',
    label: 'Extension package, per browser',
    state: 'measured',
    source: 'wxt build - Chrome MV3 and Firefox MV3',
    caveat:
      'Mostly the ONNX runtime. Both WebAssembly builds ship - one for WebGPU and one for the fallback path - because dropping either removes a working configuration.',
  },
  'steps.max': {
    display: '8',
    unit: 'steps',
    label: 'Hard ceiling on a task',
    state: 'tested',
    source: 'src/orchestrator/loop.ts',
    caveat:
      'One of eight stop conditions. An agent that cannot finish in eight steps stops and says why, rather than continuing to act on a page it is not making progress on.',
  },
  'backends.count': {
    display: '4',
    unit: 'places the AI can live',
    label: 'One privacy boundary',
    state: 'tested',
    source: 'src/contracts/deployment.ts',
    caveat:
      'A test asserts the three networked ones send a byte-identical request body for the same page. The fourth performs no request at all.',
  },

  // ------------------------------------------------------- perf, with its trap
  'redact.speedup': {
    display: '1,032x',
    unit: 'faster',
    label: 'Redaction on a 1,000-row table',
    state: 'measured',
    source: 'DECISIONS.md - 378,745 ms to 367 ms after two quadratic fixes',
    caveat:
      'Node with jsdom, not a browser. Every fixture in the test suite is a few dozen elements, where n-squared and n are the same number - 1,169 passing tests saw none of this. The browser cost at that size has deliberately not been inferred.',
  },
};

/**
 * KNOWN GAPS. These are not failures of the write-up; they are the write-up.
 * A privacy product that lists no limitations is either new or lying, and this
 * section is what makes every other claim on the page believable.
 */
export const GAPS = [
  {
    title: 'A person’s name in ordinary prose is not detected',
    body:
      'Structured fields, checksummed identifiers and labelled inputs are caught. A display name sitting in a paragraph is not — that needs named-entity recognition this build does not ship. So a name on a profile page currently reaches the server. It is recorded in the test fixtures as a documented gap, excluded from the recall denominator rather than quietly counted as a pass.',
    source: 'src/harness/fixtures/profile-pii.truth.json',
  },
  {
    title: 'The camera only knows what a face is',
    body:
      'The on-device model emits one label. Signatures, ID documents and credit cards in images are reached by rules over the image’s alt text, filename and class — not by any model, because no model at this size budget reaches them. Nearly all detection on a real page is deterministic rules and checksums, not machine vision, and the vision model is off by default.',
    source: 'src/perception/worker/yunet-decode.ts',
  },
  {
    title: 'The agent cannot read back what it typed',
    body:
      'Typing sets a property the page snapshot does not serialise, so a filled field reads back empty and the action is reported as successful regardless. Type a date a browser rejects and you are told it worked. The page check afterwards reports “changed” or “did not change” — never that the right thing changed.',
    source: 'src/execution/actions.ts',
  },
  {
    title: 'With no network at all, the agent is much simpler',
    body:
      'The fully offline planner is a keyword-overlap heuristic, not a language model. Measured, it handles typing into a field and clicking a control whose name literally shares a word with your goal. Multi-step work is out of its reach. It is a real fallback and it is not feature parity.',
    source: 'src/agent-server/local-planner.ts',
  },
  {
    title: 'It is not in any extension store',
    body:
      'There is no listing, no signed build and no one-click install. You build it and load it unpacked with developer mode on. The icons are procedurally generated placeholders, and there is no keyboard shortcut.',
    source: 'README.md',
  },
  {
    title: 'Nobody outside this project has audited it',
    body:
      'No third-party penetration test, no certification, no compliance status. The adversarial reviews were run by this project against its own code — rigorous, and self-administered. The evidence offered here is a test suite and a set of measurements you can reproduce, which is not the same as an external audit and should not be read as one.',
    source: 'DECISIONS.md',
  },
];

/**
 * RETRACTIONS. Figures this project published to itself and later found were
 * wrong. They are struck through in the record rather than deleted, because a
 * number that quietly disappears is indistinguishable from one that was never
 * checked.
 */
export const RETRACTIONS = [
  {
    wrong: '125 MB model',
    right: '25 MB',
    why: 'A byte tally that had summed five retries of the same file.',
  },
  {
    wrong: '1,037.7 ms to capture the screen',
    right: '23–26 ms',
    why: 'The harness was timing a permission rejection, not a capture.',
  },
  {
    wrong: '42 faces redacted by the current model',
    right: 'that run used the previous one',
    why: 'The measurement was real; the attribution was not.',
  },
];

/** Human labels for the four states. Used by the chips. */
export const STATE_LABEL = {
  measured: 'Measured',
  tested: 'Test-asserted',
  unverified: 'Unverified',
  gap: 'Known gap',
};
