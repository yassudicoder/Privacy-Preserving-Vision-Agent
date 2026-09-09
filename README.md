# SIH26171 — Privacy-Preserving Vision Agent

A browser extension where a local vision model reads the screen, PII is redacted
on-device, and only sanitized context reaches a server running an open-weights
VLM, which returns one action for the client to execute.

The model can run in four places. The privacy boundary does not move when it
does:

```
                      the page
                          v
   +--------------------------------------------------+
   |  ON-DEVICE PRIVACY - always, whatever is selected |
   |  DOM perception, screenshot capture, PII          |
   |  detection, redaction, pixel bake, egress check   |
   +--------------------------------------------------+
                          v
                 SanitizedContext only
                          v
      on-device  |  local  |  private  |  cloud
      (no net)   | Ollama  |  org GPU  |  hosted
                          v
                  action proposal
                          v
      local parse -> local validate -> execute -> verify
```

The four differ in one field: where the request goes. `local`, `private` and
`cloud` are three instances of the same HTTP client, so there is no second code
path in which the redaction could be skipped - and a test asserts the three send
a **byte-identical body** for the same page.

**Status: scaffold.** Interfaces and tests are complete and verified. No model is
loaded and the server is not built — see *Known gaps* in [CLAUDE.md](CLAUDE.md).

## Quick start

```bash
npm install && npm test
```

Build both browsers:

```bash
npm run build
```

Load unpacked from `.output/chrome-mv3/`, or run `npm run dev` / `npm run dev:firefox`.

See the per-fixture rubric numbers:

```bash
npm run scorecard
```

Run the local real-browser benchmark (loopback-only by default):

```bash
npx playwright install chromium
npm run benchmark:browser
```

It writes `artifacts/browser-benchmark/report.json`,
`semantic-map.json`, and a low-resolution `tagged-page.jpg`. Use
`--url http://localhost:8080/search.html?q=macbook%20pro` to test another local
route. Remote URLs require an explicit `--allow-remote` flag and should only be
used with permission; production sites may block automation or show captchas.
If Playwright's browser binary is not installed yet, pass an existing Chrome
executable with `--executable "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`.

## Layout

```
src/
  contracts/     shared types, zero runtime deps
  perception/    model hosting, capture, postprocess, model benchmark
  redaction/     PII detection, HTML + pixel redaction, sanitized context
  panel/         redaction + metrics UI (pure reducer)
  agent-server/  sanitized context in, one action out; backend.ts selects
                 on-device / local / private / cloud
  harness/       fixtures, scoring, timing, resource budgets
  entrypoints/   thin WXT wiring
tests/           unit, architecture, and negative type tests
spike/           throwaway offscreen model probe (delete once measured)
```

## The three pure functions

Everything load-bearing runs in Node under jsdom, no browser:

```ts
redact(html, visionBoxes)            // -> { html, log, detections, pixelOps }
parseAction(rawModelOutput)          // -> ParseResult<Action>
scoreDetections(found, groundTruth)  // -> { precision, recall, f1, ... }
```

Plus the two scorers the SIH rubric needs and pixel redaction:

```ts
scoreScreenContext(elements, expected)   // metric 1, 25%
measureResources(label, fn)              // metric 4, 20%
bakeRedactions(image, ops, encode)       // the only producer of BakedScreenshot
```

## The egress gate

Nothing leaves without passing two fail-closed checks, and they run for **every**
backend including the on-device one:

```ts
assertOutboundContext(ctx)                     // shape: contracts/egress.ts
assertNoLeak(ctx, { minConfidence })           // content: redaction/egress.ts
```

The first runs as the very first statement of `HttpAgentClient.plan`, before the
endpoint is read - the last code before a socket write. It refuses any key the
sanitizer does not emit, page text that never passed `toDataAtom`, a placeholder
carrying a foreign nonce, and a screenshot missing the counters only
`bakeRedactions()` produces. The second re-runs the PII detectors over the text
about to be sent, at the same threshold the redactor used.

Neither repairs a payload. A blocked context fails the step and says which check
fired; the run does not quietly continue with something nobody verified.

## Deploying

[DEPLOY.md](DEPLOY.md) has step-by-step instructions for putting the agent
server on Render's free tier and building an extension that connects to it with
no configuration:

```bash
AGENT_ORIGIN=https://your-service.onrender.com npm run build
```

That one variable bakes the origin into the bundle and declares a host
permission for that single host, so the extension opens already on Cloud AI. A
build without it behaves exactly as before - nothing configured, on-device by
default. The OpenAI key stays on the server; the extension only ever speaks
`/plan`.

## Running the agent server

```bash
npm run server                                   # heuristic baseline, no model
GEMINI_API_KEY=... npm run server                # Google AI Studio (gemini-3.5-flash-lite default)
OPENAI_API_KEY=... npm run server                # OpenAI (gpt-5.6-luna default)
VLM_ENDPOINT=... VLM_MODEL=qwen2.5vl:3b npm run server   # any OpenAI-compatible endpoint
AGENT_AUTH_TOKEN=... npm run server              # require a bearer from clients
```

`npm run start` is the same file under the name a host expects, and reads
Render's `PORT`.

Three environment variables, two of them secrets pointing in opposite
directions: `VLM_API_KEY` is what the **server presents to the model**;
`AGENT_AUTH_TOKEN` is what the **server requires from the extension**. Neither is
ever echoed on `/health` or in an error body.

## The website

A public site explaining the extension lives in [site/](site/). Static, no build
step, no dependencies, no third-party requests.

```bash
npm run site          # http://localhost:5173
npm run site:check    # assert the page has not drifted from its claim ledger
```

Every figure it shows comes from `site/assets/claims.js`, carries a state
(measured / test-asserted / unverified / known gap) and the command or file that
produced it. `site:check` runs as the deploy's build command, so a figure cannot
change in one place and not the other.

## Read next

- [DEPLOY.md](DEPLOY.md) — putting the server on Render and pointing a build at it.
- [CLAUDE.md](CLAUDE.md) — constraints, module boundaries, fixture conventions,
  the untrusted-data rule. Read before changing anything.
- [DECISIONS.md](DECISIONS.md) — every fork taken and why.
- [spike/README.md](spike/README.md) — how to get the load-time / latency /
  memory numbers off your own machine.
