/*
 * Does this page still work with the extension?
 *
 * Runs index.html through the REAL pipeline - scanDom, redact, extractElements,
 * LocalPlannerClient - in jsdom, and asserts the invariants the agent depends
 * on. Fixture HTML in src/harness/fixtures is inert by rule (no <script>), so
 * this page cannot live there; this script is how it still gets checked.
 *
 * Run it:  npx tsx test-site/verify-pipeline.ts
 *
 * It is NOT part of `npm test`. tsconfig.json does not include test-site/**,
 * and vitest.config.ts only collects tests/ ** / *.test.ts, so nothing here can
 * change what the extension's own suite reports.
 *
 * The planner used is the on-device baseline. It is the floor a VLM has to
 * beat, so an action it cannot produce (`select` is the live example) is a fact
 * about the baseline, not a fault in the page.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_BUDGET_POLICY,
  markUntrusted,
  redactionNonce,
  type SanitizedElement,
} from '@/contracts/index.ts';
import { buildSanitizedContext, redact, scanDom, DEFAULT_VIEWPORT } from '@/redaction/index.ts';
import { LocalPlannerClient } from '@/agent-server/index.ts';
import { PROTOCOL_VERSION } from '@/agent-server/protocol.ts';

const HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url));
const PAGE_URL = 'http://localhost:8080/';

// redact() calls `new DOMParser()`. In the browser that is ambient; here it has
// to come from jsdom, alongside the Node/Element globals instanceof relies on.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: PAGE_URL });
const g = globalThis as unknown as Record<string, unknown>;
g['DOMParser'] = dom.window.DOMParser;
g['Node'] = dom.window.Node;
g['Element'] = dom.window.Element;
g['document'] = dom.window.document;

const html = readFileSync(HTML_PATH, 'utf8');

// No vision boxes: this checks the DOM half of the pipeline, which is what a
// static page can exercise without a model.
const result = redact(markUntrusted(html), [], {
  viewport: DEFAULT_VIEWPORT,
  nonce: redactionNonce('testlab1'),
});

const context = buildSanitizedContext({
  doc: result.doc,
  log: result.log,
  detections: result.detections,
  viewport: DEFAULT_VIEWPORT,
  url: PAGE_URL,
  taskId: 'verify',
  step: 0,
  goal: 'placeholder',
  screenshot: null,
  budget: DEFAULT_BUDGET_POLICY,
});

// ---------------------------------------------------------------- reporting

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}\n`);
}

/**
 * A known limitation of the extension that this page deliberately exercises.
 *
 * Not a failure - the point of planting it is to keep it visible. But if the
 * gap ever CLOSES the script says so, because a stale "known gap" is how a
 * fixed bug gets re-reported as a fact of life.
 */
function gap(label: string, stillOpen: boolean, detail: string): void {
  process.stdout.write(
    `${stillOpen ? 'GAP ' : 'GAP CLOSED'}  ${label}\n        ${detail}\n`,
  );
}

function nameOf(el: SanitizedElement): string {
  return el.name?.text ?? '(no accessible name)';
}

// ------------------------------------------------------------- what was found

const byKind = new Map<string, number>();
for (const d of result.detections) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);

process.stdout.write('\n=== PII detections (redaction/dom-scan.ts) ===\n');
for (const [kind, n] of [...byKind].sort()) {
  process.stdout.write(`  ${kind.padEnd(20)} ${String(n)}\n`);
}
process.stdout.write(
  `  ${'TOTAL'.padEnd(20)} ${String(result.detections.length)} detections, ` +
    `${String(result.log.entries.length)} redaction entries, ` +
    `${String(result.log.summary.forgeriesStripped)} forged placeholders\n`,
);

process.stdout.write('\n=== Sanitized elements the server would see ===\n');
for (const el of context.elements) {
  const flag = el.isSensitive ? ' [SENSITIVE]' : '';
  process.stdout.write(
    `  ${String(el.ref).padEnd(5)} ${el.role.padEnd(10)} ${nameOf(el).slice(0, 46).padEnd(46)}${flag}\n`,
  );
}

// -------------------------------------------------------------- invariants

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

const firstTypeable = context.elements.find(
  (el) =>
    TEXT_ROLES.has(el.role) &&
    !el.isSensitive &&
    !el.states.includes('disabled') &&
    !el.states.includes('readonly'),
);

process.stdout.write('\n=== Invariants ===\n');

check(
  'the first typeable non-sensitive element is the search box',
  firstTypeable !== undefined && nameOf(firstTypeable).toLowerCase().includes('search'),
  firstTypeable === undefined
    ? 'no typeable element at all - "search for laptop" cannot work'
    : `${String(firstTypeable.ref)} = "${nameOf(firstTypeable)}"`,
);

for (const [label, id] of [
  ['password', 'login-password'],
  ['card number', 'card-number'],
  ['CVV', 'card-cvv'],
] as const) {
  const el = result.doc.getElementById(id);
  const path = el === null ? null : el;
  const marked =
    path !== null &&
    result.detections.some((d) => {
      const found = d.domPath === null ? null : result.doc.querySelector(String(d.domPath));
      return found === path;
    });
  check(`the ${label} field is detected as PII`, marked, marked ? `#${id}` : `#${id} was missed`);
}

for (const [label, needle] of [
  ['plain-text email', 'yash@example.com'],
  ['plain-text phone', '+91 9876543210'],
  ['card number value', '4111 1111 1111 1111'],
] as const) {
  const leaked = String(result.html).includes(needle);
  check(
    `${label} is gone from the redacted HTML`,
    !leaked,
    leaked ? `"${needle}" survived redaction` : `"${needle}" removed`,
  );
}

// The password is a field VALUE, so it is dropped by the drop-attribute /
// placeholder strategy rather than by a text rewrite. Check it where it lives.
const passwordValue = result.doc.getElementById('login-password')?.getAttribute('value');
check(
  'the password field value is emptied in the redacted document',
  passwordValue === '' || passwordValue === null || /^\[\[PII:/.test(passwordValue),
  `#login-password value=${JSON.stringify(passwordValue)}`,
);

const serialised = JSON.stringify(context);
for (const needle of ['yash@example.com', 'TestPass123!', '4111 1111 1111 1111', '9876543210']) {
  check(
    `outgoing context does not contain ${needle}`,
    !serialised.includes(needle),
    serialised.includes(needle) ? 'LEAK' : 'absent',
  );
}

// ------------------------------------------------------------- known gaps

process.stdout.write('\n=== Known gaps this page is planted to expose ===\n');

/*
 * date-dmy carries confidence 0.45 in redaction/patterns.ts, and both
 * orchestrator/step.ts and redact() gate at minConfidence 0.5. So a date of
 * birth is DETECTED and then dropped before anything is rewritten. Re-running
 * this file's redact() with minConfidence 0.4 redacts it, which is what
 * identifies the threshold rather than the pattern as the cause.
 */
const dobText = result.doc.getElementById('profile-dob')?.textContent ?? '';
gap(
  'a date of birth reaches the redacted document intact',
  dobText.includes('14/08/1998'),
  `#profile-dob = ${JSON.stringify(dobText)} - date-dmy scores 0.45, the runtime gate is 0.5`,
);

/*
 * An arbitrary password string in prose matches no pattern and sits in no
 * password field, so nothing can find it. The planted copy is in the "Detected
 * Test PII" table. It never reaches the server - a <td> is role generic and is
 * not an element the context carries - but it does survive in the page HTML.
 */
gap(
  'a password written as prose is undetectable',
  String(result.html).includes('TestPass123!'),
  'the copy in the Detected Test PII table survives; the #login-password value does not',
);

/*
 * scanDom has no rule for a card expiry: cc-exp is absent from AUTOCOMPLETE_PII
 * and "card expiry" matches none of the KEYWORD_RULES.
 */
const expiryValue = result.doc.getElementById('card-expiry')?.getAttribute('value') ?? '';
gap(
  'the card expiry field is not recognised as sensitive',
  expiryValue === '12/28',
  `#card-expiry value=${JSON.stringify(expiryValue)} - no cc-exp autocomplete rule, no keyword rule`,
);

// ------------------------------------------- vision.html: the falsifiability pin

/*
 * The whole YuNet test rests on one property: the three neutral portraits must
 * trip NO DOM rule, so that a `face` detection can only have come from the
 * model.
 *
 * IMG_VISUAL_RULES joins alt + title + src + class into one haystack, so a
 * rename to `avatar-1.png` or an alt of "headshot" would fire `img-face` at
 * confidence 0.65 - over the 0.5 gate - and produce a panel row identical to a
 * real detection, with the model switched off. That is a silently unfalsifiable
 * experiment, so it is pinned here rather than left to a comment.
 */
process.stdout.write('\n=== vision.html: which images trip a DOM rule ===\n');

const visionHtml = readFileSync(fileURLToPath(new URL('./vision.html', import.meta.url)), 'utf8');
const visionDom = new JSDOM(visionHtml, { url: `${PAGE_URL}vision.html` });
const visionScan = scanDom(visionDom.window.document, { salt: 'verify' });

/** DOM detections attributed to one <img>, by src. */
function detectionsFor(src: string): { kind: string; rule: string; confidence: number }[] {
  const doc = visionDom.window.document;
  const img = doc.querySelector(`img[src="${src}"]`);
  if (img === null) return [];
  return visionScan.detections
    .filter((d) => d.domPath !== null && doc.querySelector(String(d.domPath)) === img)
    .map((d) => ({ kind: d.kind, rule: d.evidence.rule, confidence: d.confidence }));
}

const VISION_EXPECT: readonly { src: string; kinds: readonly string[]; why: string }[] = [
  { src: 'images/portrait-a.png', kinds: [], why: 'a face here can only be YuNet' },
  { src: 'images/portrait-b.png', kinds: [], why: 'a face here can only be YuNet' },
  { src: 'images/portrait-c.png', kinds: [], why: 'a face here can only be YuNet' },
  { src: 'images/labelled-portrait.png', kinds: ['face'], why: 'alt says "Profile photo" on purpose' },
  { src: 'images/landscape.png', kinds: [], why: 'control' },
  { src: 'images/chart.png', kinds: [], why: 'control' },
  { src: 'images/id-card-scan.png', kinds: ['id-document'], why: 'alt fires the id rule; no face in pixels' },
  { src: 'images/signature-sample.png', kinds: ['signature'], why: 'alt fires the signature rule' },
];

for (const e of VISION_EXPECT) {
  const got = detectionsFor(e.src);
  const kinds = [...new Set(got.map((d) => d.kind))].sort();
  const want = [...e.kinds].sort();
  const same = kinds.length === want.length && kinds.every((k, i) => k === want[i]);
  const shown = kinds.length === 0 ? 'none' : got.map((d) => `${d.kind}/${d.rule}@${d.confidence}`).join(', ');
  check(
    `${e.src.replace('images/', '')} trips ${want.length === 0 ? 'no DOM rule' : want.join(', ')}`,
    same,
    `${shown} - ${e.why}`,
  );
}

// -------------------------------------------------- what the baseline plans

const planner = new LocalPlannerClient();
const GOALS = [
  'Search for laptop',
  'Open Laptop Pro',
  'Add Laptop Pro to cart',
  'Select India as country',
  'Write a review saying Great laptop',
  'Login with the test account',
  'Enable the terms checkbox',
  'Go to the profile',
  'Search for headphones',
];

process.stdout.write('\n=== What the baseline planner does with each suggested goal ===\n');

for (const goal of GOALS) {
  const ctx = buildSanitizedContext({
    doc: result.doc,
    log: result.log,
    detections: result.detections,
    viewport: DEFAULT_VIEWPORT,
    url: PAGE_URL,
    taskId: 'verify',
    step: 0,
    goal,
    screenshot: null,
    budget: DEFAULT_BUDGET_POLICY,
  });

  const outcome = await planner.plan(
    { protocolVersion: PROTOCOL_VERSION, context: ctx, clientVersion: 'verify' },
    new AbortController().signal,
  );

  if (!outcome.ok) {
    process.stdout.write(`  ${goal.padEnd(36)} ERROR ${outcome.error.error}\n`);
    failures += 1;
    continue;
  }

  const action = JSON.parse(outcome.response.raw) as { type: string; ref?: string; text?: string };
  const target =
    action.ref === undefined
      ? ''
      : ` ${action.ref} = "${nameOf(ctx.elements.find((e) => String(e.ref) === action.ref) ?? ctx.elements[0]!)}"`;
  const typed = action.text === undefined ? '' : ` text="${action.text}"`;
  process.stdout.write(`  ${goal.padEnd(36)} ${action.type}${target}${typed}\n`);
}

process.stdout.write(
  failures === 0
    ? '\nAll invariants hold.\n'
    : `\n${String(failures)} invariant(s) failed.\n`,
);

process.exit(failures === 0 ? 0 : 1);
