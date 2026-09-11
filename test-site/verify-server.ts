/*
 * Does the LOCAL agent server plan on a real page?
 *
 * `verify-pipeline.ts` proves the redaction half against a page we wrote.
 * `verify-vision.ts` proves the model against images we generated. Neither
 * touches the server, and neither uses a page anyone else authored - so between
 * them they could both pass against a server that was never started and a model
 * that had never seen real markup.
 *
 * This closes that. It takes REAL HTML - fetched live, or read off disk - runs
 * it through the SHIPPED pipeline, and POSTs the result through the SHIPPED
 * `HttpAgentClient`, which means the egress gate runs exactly as it does in the
 * extension. What comes back is parsed and validated by the same two functions
 * the background uses. Nothing here is a re-implementation; if this passes, the
 * only thing between it and the extension is the browser.
 *
 * Run it:
 *   npx tsx test-site/verify-server.ts --url https://example.com --goal "search for laptop"
 *   npx tsx test-site/verify-server.ts --file test-site/index.html
 *   npm run verify:server -- --url https://www.amazon.in/ --goal "add a laptop to the cart"
 *
 * It is NOT part of `npm test`: it needs a server on the other end, and a test
 * that fails when a process is not running is a test that fails for a reason
 * nobody wants reported as a regression.
 *
 * WHAT IT IS FOR, stated plainly. The thing that breaks a local deployment is
 * never the code path this repo has 1100 tests over - it is the prompt arriving
 * at a model whose context window is smaller than the prompt, an endpoint that
 * answers but is running the baseline, or a page whose element count is thirty
 * times the fixtures'. All three are invisible to the suite and all three are
 * measured here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_BUDGET_POLICY,
  defaultDeployment,
  markUntrusted,
  redactionNonce,
  type BackendKind,
  type ElementBudgetPolicy,
  type ExecutedStep,
  type SanitizedContext,
} from '@/contracts/index.ts';
import { buildSanitizedContext, redact, validationContextFor, DEFAULT_VIEWPORT } from '@/redaction/index.ts';
import { createAgentBackend, parseAction, parseAndValidate } from '@/agent-server/index.ts';
import { PROTOCOL_VERSION } from '@/agent-server/protocol.ts';
import { CORRECTABLE_REFUSALS, completionVerdict, composeCorrection } from '@/orchestrator/index.ts';

// ------------------------------------------------------------------ arguments

interface Args {
  readonly url: string | null;
  readonly file: string | null;
  readonly goal: string;
  readonly endpoint: string;
  readonly kind: BackendKind;
  readonly token: string | null;
  readonly maxPromptTokens: number;
  /**
   * Steps already taken, as the loop carries them, so a later page of a task can
   * be probed in context: `--history '[{"actionType":"type","name":"Search"}]'`.
   */
  readonly history: readonly ExecutedStep[];
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at < 0 ? null : (argv[at + 1] ?? null);
  };
  const tokens = get('--max-prompt-tokens');
  return {
    url: get('--url'),
    file: get('--file'),
    goal: get('--goal') ?? 'search for laptop',
    endpoint: get('--endpoint') ?? 'http://127.0.0.1:8787',
    /*
     * `local` by default, and the kind is not cosmetic here.
     *
     * `deriveBackendOrigin` enforces a different rule per kind - loopback http
     * is permitted for `local` and refused for `private` and `cloud`, which
     * require https. Passing the kind through means this probe exercises that
     * policy rather than routing around it, so pointing it at a plaintext
     * endpoint with `--kind cloud` fails HERE, the same way the extension would.
     */
    kind: (get('--kind') ?? 'local') as BackendKind,
    token: get('--token'),
    maxPromptTokens: tokens === null ? DEFAULT_BUDGET_POLICY.maxPromptTokens : Number(tokens),
    history: (JSON.parse(get('--history') ?? '[]') as Partial<ExecutedStep>[]).map((h, i) => ({
      step: i + 1,
      actionType: h.actionType ?? 'click',
      ref: null,
      name: h.name ?? null,
      ok: h.ok ?? true,
      note: h.note ?? '',
    })),
  };
}

const args = parseArgs(process.argv.slice(2));

/*
 * A default that is a REAL page rather than one of ours.
 *
 * test-site/index.html is available and is the wrong default for this script:
 * it was written to exercise the pipeline, so it exercises the pipeline. The
 * whole question here is what happens to markup nobody on this project wrote.
 */
const DEFAULT_URL = 'https://en.wikipedia.org/wiki/Special:Search';

// --------------------------------------------------------------------- output

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}\n`);
}

function note(label: string, detail: string): void {
  process.stdout.write(`NOTE  ${label}\n        ${detail}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// ------------------------------------------------------------------ the page

async function loadHtml(): Promise<{ html: string; pageUrl: string; source: string }> {
  if (args.file !== null) {
    const path = fileURLToPath(new URL(args.file, `file:///${process.cwd().replace(/\\/g, '/')}/`));
    return {
      html: readFileSync(path, 'utf8'),
      // A file has no origin, and `navigate` validation is origin-based, so one
      // is supplied rather than left as `file://` - which no allowlist can match
      // and which would make every navigate refusal look like a policy failure.
      pageUrl: 'http://localhost:8080/',
      source: `file ${args.file}`,
    };
  }

  const url = args.url ?? DEFAULT_URL;
  /*
   * A BROWSER user agent, and it is not a trick.
   *
   * Several large sites answer a default Node fetch with a consent interstitial
   * or a 503, and the page that comes back is then forty elements of cookie
   * banner. Measuring the pipeline against that would produce a number about
   * the interstitial. This asks for what a browser would be given.
   *
   * It is still SERVER-RENDERED HTML: no JavaScript runs, so a site that builds
   * its DOM on the client will look emptier here than in the extension. That is
   * a limit of this script and it is reported below rather than hidden.
   */
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fetching ${url} returned ${String(res.status)}`);
  return { html: await res.text(), pageUrl: url, source: `live ${url}` };
}

const { html, pageUrl, source } = await loadHtml();

// `redact()` calls `new DOMParser()`; in the browser that is ambient. jsdom
// supplies it here, along with the globals `instanceof` relies on.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: pageUrl });
const g = globalThis as unknown as Record<string, unknown>;
g['DOMParser'] = dom.window.DOMParser;
g['Node'] = dom.window.Node;
g['Element'] = dom.window.Element;
g['document'] = dom.window.document;

section('Input');
process.stdout.write(`  source        ${source}\n`);
process.stdout.write(`  html bytes    ${String(new TextEncoder().encode(html).length)}\n`);
process.stdout.write(`  goal          ${args.goal}\n`);
process.stdout.write(`  endpoint      ${args.endpoint}\n`);

// ------------------------------------------------ what the server is running

section('Server');

/*
 * THE REAL DEPLOYMENT LAYER, deliberately.
 *
 * Not a hand-rolled fetch and not a bare `HttpAgentClient`. `createAgentBackend`
 * is what `background.ts` calls, so this probe goes through
 * `deriveBackendOrigin` - which is where the loopback-http-for-local-only policy
 * lives - and then through the same `HttpAgentBackend` whose `plan` starts with
 * the egress gate. Anything this script gets past, the extension gets past for
 * the same reasons.
 *
 * It also means `/plan` and `/health` are appended HERE rather than typed,
 * which is the mistake this file made on its first run: `HttpAgentClient` takes
 * a full `/plan` URL while everything a user types is an origin, and pointing
 * the client at the origin produced a 404 that read as a broken server.
 */
const deployment = {
  ...defaultDeployment(),
  backend: args.kind,
  [args.kind]: { endpoint: args.endpoint, model: '' },
};

let backend;
try {
  backend = createAgentBackend(deployment, {
    clientVersion: 'verify-server',
    ...(args.token === null ? {} : { authTokenFor: (): string => args.token as string }),
  });
} catch (err) {
  process.stdout.write(
    `FAIL  the ${args.kind} backend accepts this endpoint\n        ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  process.exit(1);
}

process.stdout.write(`  kind          ${backend.descriptor.kind}\n`);
process.stdout.write(`  endpoint      ${String(backend.descriptor.endpoint)}\n`);
process.stdout.write(`  encrypted     ${String(backend.descriptor.encrypted)}\n`);

const health = await backend.health(AbortSignal.timeout(60_000));

check(
  'the agent server is reachable',
  health.reachable,
  health.reachable
    ? `planner "${String(health.plannerId)}" - ${String(health.description)}`
    : health.waking
      ? `no answer within the timeout - ${String(health.error)} (a sleeping host looks like this)`
      : `${String(health.error)}`,
);

/*
 * THE FAILURE A FRESH LOCAL DEPLOYMENT ACTUALLY HAS, and it does not look like
 * a failure.
 *
 * With no model configured the server starts, answers /health, and returns
 * valid actions - produced by the dependency-free baseline. Every indicator is
 * green and nothing is using a model. So this is a CHECK rather than a note:
 * running this probe against the baseline and reading a passing result as "the
 * local server works on real websites" is precisely the wrong conclusion, and
 * it is an easy one to reach.
 *
 * `BackendHealth` carries no `vlm` field - it is the shape the panel renders -
 * so the raw /health body is read for this one question.
 */
interface HealthBody {
  readonly prompt?: string;
  readonly vlm?: { configured?: boolean; model?: string | null; verified?: boolean | null };
  readonly uptimeMs?: number;
}

let body: HealthBody = {};
if (health.reachable) {
  try {
    const res = await fetch(`${String(backend.descriptor.endpoint)}/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    body = (await res.json()) as HealthBody;
  } catch {
    // Already reported by the probe above; this is only the extra detail.
  }
  process.stdout.write(`  prompt hash   ${body.prompt ?? '?'}\n`);
  process.stdout.write(`  uptime        ${String(Math.round((body.uptimeMs ?? 0) / 1000))} s\n`);

  check(
    'a real model is wired up, not the baseline',
    body.vlm?.configured === true,
    body.vlm?.configured === true
      ? `model ${String(body.vlm.model)}`
      : 'HeuristicPlanner - set VLM_ENDPOINT + VLM_MODEL (or a provider key) and restart the server',
  );

  if (body.vlm?.configured === true) {
    check(
      'the provider confirms the model id resolves',
      body.vlm.verified !== false,
      body.vlm.verified === true
        ? 'the provider lists it'
        : body.vlm.verified === false
          ? `the provider does not list "${String(body.vlm.model)}"`
          : 'could not ask - the endpoint exposes no /v1/models catalogue, or the key was rejected',
    );
  }

  check(
    'the token this script carries matches what the server expects',
    !health.authRequired || args.token !== null,
    health.authRequired && args.token === null
      ? 'the server requires a bearer token; pass --token'
      : 'ok',
  );
}

// --------------------------------------------------------------- the pipeline

const redactStart = performance.now();
const result = redact(markUntrusted(html), [], {
  viewport: DEFAULT_VIEWPORT,
  nonce: redactionNonce('verifysrv'),
});
const redactMs = performance.now() - redactStart;

/*
 * THE SAME CLAMP THE BACKGROUND APPLIES, for the same reason and with the same
 * numbers - see `effectiveBudget` in `entrypoints/background.ts`.
 *
 * Duplicated rather than imported: that function reads the background's own
 * module state, and a probe that reached into it would be testing the wiring
 * instead of the behaviour. What matters is that a run here and a run in the
 * extension send the same size of prompt to the same server, and the reserve
 * below is the one the extension uses.
 */
const COMPLETION_RESERVE_TOKENS = 2560;
const reportedWindow = health.contextWindow;
const clamped =
  reportedWindow === null
    ? args.maxPromptTokens
    : Math.min(args.maxPromptTokens, Math.max(1200, reportedWindow - COMPLETION_RESERVE_TOKENS));

if (clamped < args.maxPromptTokens) {
  note(
    'prompt budget clamped to the model context window',
    `${String(reportedWindow)}-token window minus a ${String(COMPLETION_RESERVE_TOKENS)}-token ` +
      `completion reserve, so ${String(clamped)} rather than ${String(args.maxPromptTokens)}. ` +
      'The extension does this automatically from the same /health field.',
  );
} else if (reportedWindow === null) {
  note(
    'the server did not report a context window',
    'so the budget is unchanged. Only an Ollama endpoint with a pinned num_ctx can be asked; ' +
      'everything else is UNKNOWN, and a guessed ceiling would be worse than none.',
  );
}

const policy: ElementBudgetPolicy = {
  ...DEFAULT_BUDGET_POLICY,
  maxPromptTokens: clamped,
};

const context: SanitizedContext = buildSanitizedContext({
  doc: result.doc,
  log: result.log,
  detections: result.detections,
  viewport: DEFAULT_VIEWPORT,
  url: pageUrl,
  taskId: 'verify-server',
  step: 0,
  goal: args.goal,
  screenshot: null,
  budget: policy,
  history: args.history,
});

section('Redaction');
const byKind = new Map<string, number>();
for (const d of result.detections) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
for (const [kind, n] of [...byKind].sort()) {
  process.stdout.write(`  ${kind.padEnd(20)} ${String(n)}\n`);
}
process.stdout.write(
  `  ${'TOTAL'.padEnd(20)} ${String(result.detections.length)} detections, ` +
    `${String(result.log.entries.length)} applied, ` +
    `${String(result.log.summary.forgeriesStripped)} forged placeholders stripped ` +
    `(${redactMs.toFixed(0)} ms)\n`,
);

section('Budget');
const b = context.budget;
process.stdout.write(`  available     ${String(b.available)}\n`);
process.stdout.write(`  sent          ${String(b.sent)}\n`);
process.stdout.write(`  dropped       ${String(b.dropped.length)}\n`);
process.stdout.write(`  duplicates    ${String(b.duplicatesCollapsed)} collapsed\n`);
process.stdout.write(
  `  tokens        ~${String(b.estimatedTokens)} / ${String(b.tokenBudget)}` +
    `${b.geometryOmitted ? '  (geometry omitted)' : ''}` +
    `${b.screenshotDropped ? '  (screenshot dropped)' : ''}\n`,
);

const payloadBytes = new TextEncoder().encode(JSON.stringify(context)).length;
process.stdout.write(`  payload       ${String(payloadBytes)} bytes\n`);

check(
  'the page produced elements to act on',
  context.elements.length > 0,
  context.elements.length === 0
    ? 'zero elements - a client-rendered page fetched without JavaScript looks like this'
    : `${String(context.elements.length)} elements sent`,
);

// --------------------------------------------------------------- the request

section('Plan');

/*
 * `plan` on the BACKEND, which is `HttpAgentClient.plan` one call down - and
 * that begins with `assertOutboundContext`. So the egress gate runs here exactly
 * as it does in the extension, including the re-derivation that catches a
 * context whose nominal type survived a message hop it should not have.
 */
const planStart = performance.now();
const outcome = await backend.plan(
  { protocolVersion: PROTOCOL_VERSION, context, clientVersion: 'verify-server' },
  AbortSignal.timeout(120_000),
);
const planMs = performance.now() - planStart;

if (!outcome.ok) {
  check(
    'the server returned a plan',
    false,
    `${outcome.error.error} (retryable: ${String(outcome.error.retryable)})`,
  );
} else {
  process.stdout.write(`  model         ${outcome.response.modelId}\n`);
  process.stdout.write(
    `  latency       ${planMs.toFixed(0)} ms round trip, ${String(outcome.response.serverMs)} ms server-side\n`,
  );
  process.stdout.write(`  raw           ${JSON.stringify(outcome.response.raw).slice(0, 300)}\n`);

  /*
   * THE SAME CONTEXT THE BACKGROUND BUILDS, not a hand-made copy of it. This
   * used to assemble the sets itself and crashed with a TypeError the first
   * time `ValidationContext` gained a field (`currentValues`) - test-site/ is
   * not typechecked, so the drift arrived at run time instead of compile time.
   *
   * The origin is the ATTACHED PAGE's, which is what `validateAction` means by
   * it - not the agent server's. Getting that backwards is a bug this project
   * has already had once.
   */
  const vctx = validationContextFor(context, [new URL(pageUrl).origin]);
  /*
   * `done` on an action goal before anything has been done is refused by the
   * step as `unverified-completion`, and re-planned. Reproduced here, so this
   * probe does not report as a failure a reply the extension recovers from -
   * and does not report as a PASS a completion nobody performed.
   */
  const judge = (raw: string): ReturnType<typeof parseAndValidate> => {
    const v = parseAndValidate(raw, vctx, parseAction);
    if (!v.ok) return v;
    const c = completionVerdict(
      v.value,
      { goal: args.goal, step: args.history.length + 1, history: args.history } as never,
    );
    return c.ok ? v : (c as ReturnType<typeof parseAndValidate>);
  };
  let validated = judge(outcome.response.raw);

  /*
   * THE EXTENSION'S ONE RE-PLAN, reproduced - with its own words.
   *
   * `step.ts` gives a correctable refusal (`not-typeable`, `already-typed`, ...)
   * exactly one more turn with a CORRECTION block in front of the model. This
   * probe used to stop at the first refusal, so it reported FAIL on replies the
   * extension recovers from, and it could not measure the correction wording at
   * all - which is the part that gets tuned. `composeCorrection` and
   * `CORRECTABLE_REFUSALS` are imported from the orchestrator, not copied.
   */
  if (!validated.ok && CORRECTABLE_REFUSALS.has(validated.error.code)) {
    const first = parseAction(outcome.response.raw);
    note('refused - re-planning once, as the extension does', `${validated.error.code}: ${validated.error.detail}`);
    if (first.ok) {
      const retry = await backend.plan(
        {
          protocolVersion: PROTOCOL_VERSION,
          context,
          clientVersion: 'verify-server',
          correction: composeCorrection(first.value, validated.error.detail, context.elements),
        },
        AbortSignal.timeout(120_000),
      );
      if (retry.ok) {
        process.stdout.write(`  re-plan raw   ${JSON.stringify(retry.response.raw).slice(0, 300)}\n`);
        validated = judge(retry.response.raw);
      } else {
        process.stdout.write(`  re-plan       failed: ${retry.error.error}\n`);
      }
    }
  }

  check(
    'the reply parses and validates as an action',
    validated.ok,
    validated.ok
      ? JSON.stringify(validated.value)
      : `${validated.error.code}: ${validated.error.detail}`,
  );

  if (validated.ok && 'ref' in validated.value) {
    const target = context.elements.find((el) => el.ref === validated.value.ref);
    note(
      'the action names a real element',
      target === undefined
        ? 'ref not found - which validateAction should have refused'
        : `${String(target.ref)} ${target.role} "${target.name?.text ?? '(no accessible name)'}"`,
    );
  }
}

// --------------------------------------------------- what this cannot tell you

section('Limits of this run');

if (args.file === null) {
  note(
    'no JavaScript ran',
    'this is server-rendered HTML. A client-rendered page has more elements in the ' +
      'extension than it does here, so the budget numbers above are a floor, not the browser figure.',
  );
}
note(
  'no screenshot',
  'the context carries no image, so the vision path and the pixel-coverage refusal are untested here. ' +
    'That also means the token estimate omits the ~1200-token image reserve.',
);
if (reportedWindow !== null && b.dropped.length > 0 && b.estimatedTokens > clamped - 200) {
  /*
   * The clamp bound AND the page still filled it. Worth naming separately,
   * because the dropped-element count is then a fact about the MODEL rather
   * than about the page or the setting - raising `--max-prompt-tokens` cannot
   * help, and serving a larger `num_ctx` is the only thing that will.
   */
  note(
    'the page filled the clamped budget',
    `${String(b.dropped.length)} element(s) dropped to fit a ${String(reportedWindow)}-token model. ` +
      'Raising --max-prompt-tokens cannot help; a larger num_ctx is the only thing that changes it.',
  );
}
if (body.vlm?.configured === true && reportedWindow === null && b.estimatedTokens > 7000) {
  /*
   * THE ONE THAT BITES LOCALLY, and it is silent on both sides.
   *
   * Ollama's default context window is 4096 and a laptop-sized custom model is
   * typically 8192. The OpenAI-compatible body has no field reporting the
   * window, so the client cannot discover it and the server does not refuse -
   * llama.cpp simply drops tokens until the prompt fits. What it drops is the
   * END of this prompt, which is where the element list, ALREADY DONE and
   * CORRECTION all live. The model then answers confidently about a page it was
   * shown half of.
   *
   * Only when the window is UNKNOWN: a server that reported one has already had
   * the budget clamped to it above, and repeating the warning there would
   * describe a problem that was just solved.
   */
  note(
    'check the model context window',
    `this prompt is ~${String(b.estimatedTokens)} tokens and the server did not report a window. ` +
      'A local model served with num_ctx 4096 or 8192 will SILENTLY drop the tail of it - the ' +
      'element list and the correction block - and answer anyway. Pin num_ctx in a Modelfile so ' +
      'it can be reported, or lower --max-prompt-tokens to fit.',
  );
}

process.stdout.write(
  `\n${failures === 0 ? 'OK' : 'FAILURES'}: ${String(failures)} failing check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
