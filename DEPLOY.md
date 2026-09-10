# Deploying the agent server to Render

The extension can talk to any server that speaks `POST /plan`. This is how to
put **this repo's** server — `server/main.ts`, unchanged — on Render's free tier
and point a build of the extension at it.

**What Render receives.** A `SanitizedContext`, and only after the extension's
two fail-closed egress gates have passed *in the browser*. Perception, PII
detection, redaction, pixel-coverage verification and the outbound checks all
run on the client, before anything is written to a socket. Hosting the planner
does not move any part of that — the privacy boundary is a property of the client
pipeline, not of where the model runs. Nothing below changes it.

---

## Before you start

**You need a Git remote.** Render deploys from GitHub/GitLab/Bitbucket. This
working copy is not a repository yet:

```bash
git init
git add -A
git commit -m "SIH26171 privacy-preserving vision agent"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.output/`, `node_modules/` and the vendored model
binaries, so nothing large or secret goes up. **Check that before pushing**:

```bash
git ls-files | grep -iE "\.env|key|secret" || echo "clean"
```

You also need a **Google AI Studio API key** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
It goes into Render's dashboard and nowhere else — not into this repo, not into
the extension, not into a build command.

---

## 1. Create the service

Render Dashboard → **New** → **Blueprint** → connect the repository.

Render reads [`render.yaml`](render.yaml) and pre-fills everything:

| Setting | Value | Why |
|---|---|---|
| Runtime | Node | |
| Plan | Free | |
| Build command | `npm ci` | Installs from the lockfile. `tsx` is a **runtime** dependency, so a production install still has what the start command needs. |
| Start command | `npm run start` | Runs `tsx server/main.ts` — the same process `npm run server` starts locally. |
| Health check path | `/health` | Render polls this to decide the deploy succeeded. |

If you would rather not use a Blueprint: **New → Web Service**, pick the repo,
and enter the build/start commands above by hand.

## 2. Set the environment variables

In the service's **Environment** tab:

| Variable | Required | Value |
|---|---|---|
| `GEMINI_API_KEY` | **yes** | Your Google AI Studio key. `GOOGLE_API_KEY` works too. Render stores it encrypted and it is never written to this repo. |
| `VLM_MODEL` | no | Defaults to `gemini-3.5-flash-lite`, and `render.yaml` pins it. **Must be vision-capable** — the client sends the verified redacted screenshot as an image part when one survives the pixel-coverage check, and a text-only model rejects that request. |
| `VLM_REASONING` | no | `none`/`minimal`/`low`/`medium`/`high`. Defaults to `low`. Reasoning bills as **output**, which costs several times input — this is the largest single lever on cost per step. |
| `AGENT_AUTH_TOKEN` | strongly recommended | The token the extension must present. `render.yaml` generates one; read it from the dashboard. Without it your URL is public and anyone who finds it spends your OpenAI quota. |
| `PORT` | no | **Render sets this.** Do not add it. |

`OPENAI_API_KEY` still works and is used when no Google key is present.
`VLM_ENDPOINT` + `VLM_MODEL` beat both — that is the path for pointing this at
vLLM, Ollama, Together or Groq. The startup log and `/health` always name which
provider actually answered, so the choice is never a guess.

**Nothing in `VlmPlanner` is provider-specific.** Google AI Studio is reached
through its OpenAI-compatible surface at
`generativelanguage.googleapis.com/v1beta/openai/` — same bearer header, same
`messages` shape, same `image_url` parts with base64 data URLs.

## 3. Get the URL

After the first deploy, the service page shows something like

```
https://sih26171-agent-server.onrender.com
```

That is your `AGENT_ORIGIN`.

## 4. Check the server before touching the extension

```bash
curl https://YOUR-SERVICE.onrender.com/health
```

```json
{
  "ok": true,
  "server": "ok",
  "planner": "gemini-3.5-flash-lite",
  "vlm": { "configured": true, "model": "gemini-3.5-flash-lite", "verified": true },
  "auth": true,
  "prompt": "9d979c53",
  "uptimeMs": 4494
}
```

Read it as three facts:

- `server: "ok"` — the process is up.
- `vlm.configured: true` — a real model is wired in. **If this is `false`, every
  plan comes from the dependency-free baseline**: the server answers, returns
  valid actions, and none of them came from a model. It is the most likely
  first-run mistake and the least visible one.
- `vlm.verified: true` — the provider was asked whether the model id resolves and
  said yes. `false` means it said **no**, and every plan will fail with a
  model-not-found; fix `VLM_MODEL`. `null` means the question could not be asked
  (no `/v1/models` catalogue, unreachable, or a rejected key) — **not** a synonym
  for fine. The probe never blocks startup and never substitutes another model.
  Note for Google specifically: it answers **404 to every catalogue path when
  unauthenticated** — a real id, a fake id and the list are indistinguishable —
  so a bare 404 is corroborated against the list before it is ever reported as
  `false`. A bad key reports `null`, not "model not found".
- `auth: true` — a token is required.

No secret appears in that response, and `/health` is deliberately
unauthenticated: requiring a token to ask "are you alive" would make an
unavailable service indistinguishable from a misconfigured one.

Then check `/plan` rejects an unauthenticated caller:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H 'content-type: application/json' -d '{"protocolVersion":1}' \
  https://YOUR-SERVICE.onrender.com/plan
# 401

curl -s -X POST \
  -H 'content-type: application/json' \
  -H "authorization: Bearer YOUR_AGENT_AUTH_TOKEN" \
  -d '{"protocolVersion":1}' \
  https://YOUR-SERVICE.onrender.com/plan
# 200 with {"ok":false,...,"error":"missing context"} - it got past auth and
# refused the malformed body, which is the correct answer.
```

**The first request after idle takes 30–60 seconds.** Free instances sleep after
about 15 minutes. That is handled, not hidden — see below.

## 5. Build the extension against it

```bash
AGENT_ORIGIN=https://YOUR-SERVICE.onrender.com npm run build
```

On Windows PowerShell:

```powershell
$env:AGENT_ORIGIN="https://YOUR-SERVICE.onrender.com"; npm run build
```

That one variable does three things:

1. Bakes the origin into the bundle, so the extension opens already configured
   on **Cloud AI** with nothing to type.
2. Adds `host_permissions: ["https://YOUR-SERVICE.onrender.com/*"]` to both
   manifests, so the browser grants network access to that one host at install
   time and no permission prompt appears at runtime.
3. Leaves everything else untouched. A build **without** `AGENT_ORIGIN` behaves
   exactly as before: nothing configured, on-device by default.

A host permission for the agent server grants **fetch to that one host**. It
grants no access to any page you visit — page access is still `activeTab` plus a
per-site grant you make deliberately. `tests/architecture/manifest.test.ts`
asserts the key is at most one entry and never a wildcard.

Load `.output/chrome-mv3/` via `chrome://extensions` → Developer mode → Load
unpacked.

## 6. Paste the token into the extension, once

The endpoint is baked in; the **token is not** — a credential in a bundle is a
published credential.

Open the panel → **AI backend** → the token field under Cloud AI → paste the
`AGENT_AUTH_TOKEN` from Render → **Set**.

It is kept in `storage.session`: in memory, cleared when the browser closes, and
re-entered next session. That is deliberate. An extension is not a secret store;
what session storage buys is that a bearer credential is not left on disk in the
profile directory.

Then press **Check connection**. It should report
`Connected — gemini-3.5-flash-lite`.

## 7. Verify the whole flow

1. Open any page you are willing to let an agent click on. `npm run test-site`
   serves a local one built for this.
2. Click the extension's toolbar button — that grants `activeTab` and opens the
   panel.
3. Click **Grant page access for this site** so the run survives its own
   navigation.
4. Type a goal and press Send.

Watch the **Privacy receipt** card. Every line is a measurement:

```
Raw DOM              NOT SENT (31 field(s) checked)
Raw PII              NOT SENT (31 field(s) checked)
Raw screenshot       NOT SENT (1 field(s) checked)
Sanitized context    SENT (12480 bytes)
Redacted screenshot  SENT (5012 bytes)
```

`NOT CHECKED` means the step failed before reaching the gate — it is not a
synonym for safe, and the card says so.

---

## The free tier sleeps

After ~15 minutes idle, the instance is stopped and the next request wakes it.
That takes tens of seconds.

The extension handles it by **saying so**:

- The health probe distinguishes *timed out* from *refused*. A timeout renders
  as **"Connecting to AI server..."**; a refused connection renders as
  **"Unavailable"**. They are different facts and reporting them identically
  would tell you your server is down at the exact moment it is coming up.
- A plan taking longer than 2.5 seconds emits a notice naming the endpoint and
  the wake-up, so a slow first step reads as a wait rather than a hang.
- The step timeout is 60 seconds, which is long enough for a cold start.

**It never switches backends on its own.** If the server genuinely cannot be
reached, the step fails and the panel offers Retry and the alternatives as
buttons — a switch is always a click. Silently sending an organisation's
sanitized context somewhere it did not choose is the failure this design exists
to prevent.

To avoid cold starts during a demo, hit `/health` a minute beforehand, or point
an uptime pinger at it.

---

## Local development, and the Ollama recipe in full

Put the configuration in `.env` once - `npm run server` reads it, and a shell
variable still wins over the file. `cp .env.example .env` and edit.

```bash
npm run server                    # whatever .env says; baseline if it says nothing
OPENAI_API_KEY=... npm run server # a shell variable still overrides the file
```

### Ollama, in full

Write a two-line `Modelfile`:

```
FROM qwen2.5vl:3b
PARAMETER num_ctx 8192
```

then:

```bash
ollama pull qwen2.5vl:3b
ollama create qwen2.5vl-8k -f Modelfile
```

`-f -` (a Modelfile on stdin) is NOT accepted - Ollama 0.33 answers
`Error: no Modelfile or safetensors files found`. It has to be a real file.

Then in `.env`:

```
VLM_ENDPOINT=http://127.0.0.1:11434/v1/chat/completions
VLM_MODEL=qwen2.5vl-8k:latest
VLM_REASONING=off
```

**Why a custom model rather than stock `qwen2.5vl:3b`.** Ollama serves a model at
the `num_ctx` its Modelfile pins, and the stock image pins none - so it runs at
Ollama's default of 4096. The extension budgets 30,000 prompt tokens by default,
and Ollama does not REFUSE an over-long prompt: it truncates it and the model
answers. What gets cut is the END of the prompt, where the element list and the
correction block live. Measured on one page and one goal, the 30,000-token
version replied `{"type":"done","summary":"..."}` and the 5,000-token version
replied with the correct `type` at that page's search box.

The server now asks the endpoint for its window at startup, reports it on
`/health` as `vlm.contextWindow`, and the extension clamps its budget to it
automatically - so pinning `num_ctx` is what makes the window KNOWABLE, which is
what makes the clamp possible. A model pinning nothing reports `null` and gets no
clamp.

**Why `VLM_REASONING=off`.** `reasoning_effort` defaults to `low`, and Ollama
answers `400 "<model>" does not support thinking` for any model without a
thinking mode. The server notices that specific refusal and retries once without
the field, so leaving it unset does work - this just skips the wasted round trip.

**Why the model stays loaded.** Ollama unloads an idle model after five minutes,
and the next plan pays the load - 8.2 s on a real run. The server preloads the
model at startup and asks Ollama to keep it for `VLM_KEEP_ALIVE` (default `30m`)
after every plan. Set it shorter, or `off`, to give the VRAM back sooner; the
extension's WebGPU vision model shares that GPU.

**Seeing what the model did.** Every plan prints one line with verbs and refs
only, for example
`[plan] 113 el, 48.2 KB, no image -> type e4 +submit (1516 ms model, 1522 ms total)`.
For the full prompt and reply, set `AGENT_TRACE_DIR=./traces`; each day's plans
are appended to `plans-YYYY-MM-DD.jsonl`. Leave it unset on anything hosted.

### Checking it

```bash
npm run verify:server -- --url https://en.wikipedia.org/wiki/Web_browser --goal "search for privacy"
```

Runs real page HTML through the real pipeline into the running server, through
the same `createAgentBackend` the extension uses, and prints the budget, the
clamp, the latency and the element the returned action names.

`npm run start` and `npm run server` run the same file; `start` exists because
that is the script name Render expects, and it deliberately does NOT read `.env`
- on Render the configuration comes from the dashboard, and a `.env` in the image
would be a credential in the image. Build the extension with no `AGENT_ORIGIN`
and use the panel's **Local agent server** box, or pick **Local AI** under
Advanced.

---

## Environment variables, in full

### Server (Render)

| Variable | Direction | Notes |
|---|---|---|
| `GEMINI_API_KEY` | server → Google | The model credential. `GOOGLE_API_KEY` is the same field. Never leaves the server. |
| `OPENAI_API_KEY` | server → OpenAI | Used when no Google key is set. |
| `VLM_API_KEY` | server → model | Same field, older name. Takes precedence. |
| `VLM_ENDPOINT` | — | Any OpenAI-compatible chat-completions URL. Overrides the OpenAI default. |
| `VLM_MODEL` | — | Model id. Reported on `/health`. |
| `AGENT_AUTH_TOKEN` | extension → server | The token the extension presents. A **different** secret from the one above, travelling the other way. |
| `PORT` | — | Set by Render. |
| `HOST` | — | Defaults to `0.0.0.0`. |

### Extension (build time)

| Variable | Notes |
|---|---|
| `AGENT_ORIGIN` | The Render URL. Origin only, https, no wildcard — anything else is refused and produces a build with no baked endpoint rather than a broad permission. |

**Two secrets, opposite directions.** `OPENAI_API_KEY` is what the server
presents to OpenAI. `AGENT_AUTH_TOKEN` is what the server requires from the
extension. Conflating them would hand the model provider's key to every browser
that connects.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/health` shows `vlm.configured: false` | `OPENAI_API_KEY` is unset or empty. Every plan is the baseline. |
| `server returned 404 ... does not serve /plan` | The origin is not the agent server. Pointing the extension at an OpenAI URL does this — the extension must never call OpenAI directly. |
| `the server rejected the access token` | `AGENT_AUTH_TOKEN` in the panel does not match Render's. |
| `the server requires authentication and no access token is set` | Token set on Render, not in the panel. |
| First step takes ~45 s | Cold start. Expected on the free tier. |
| `model endpoint returned 401` | The OpenAI key is wrong. Non-retryable, so the loop stops rather than spending eight steps on it. Any credential-shaped text in the provider's reply is masked before it reaches the browser. |
| Panel says "Connecting to AI server..." forever | The host accepts connections and never answers. Check the Render logs. |
