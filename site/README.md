# The website

A marketing site for the extension. Static, dependency-free, zero build step.

```bash
npm run site          # http://localhost:5173
npm run site:check    # assert the page has not drifted from the claim ledger
```

Deploy by serving this folder. There is nothing to compile.

---

## What it is for

Three audiences on one page: individuals who want an agent that does not send
their screen to a company, private companies handling customer data, and
government organisations such as ISRO handling confidential work.

They are **not** split with a persona switcher. A segmentation control at the
top would fragment the one explanatory device the site is built on, and would
ask visitors to classify themselves before they understand the product. Instead
everyone walks the same corridor, and exactly one section — *Where the AI
lives* — splits them, along the product's own real axis (`BackendKind`) rather
than along invented marketing tiers. Institutional depth is a slab in that
section, not a separate site and not a Contact Sales form.

---

## The rule that governs the copy

**Nothing on this page may claim more than the repository supports.**

The research behind this site found that both of the project's own top-level
documents contain statements that are now false in *both* directions —
`README.md` still says "Status: scaffold", while the tail of CLAUDE.md's
known-gaps log is superseded history. Anyone writing marketing copy from the
docs alone will publish false statements. Every figure here was therefore taken
from code, from a command that was actually run, or from a live probe.

Specifically, and these are the ones a reviewer will reach for first:

- **The on-device planner is a keyword heuristic, not a language model.** The
  only model that runs on the device is a 232 KB face detector. "Runs an AI
  model on your device" is the most tempting and most false claim available
  here, and it does not appear.
- **"No personal data ever leaves your device" is not said**, because it is not
  true. A redacted, structurally checked payload leaves. A person's name in
  ordinary prose is not detected and reaches the server today — that is gap 01
  in the limits section.
- **The 100% fixture score always carries its denominator.** Nineteen planted
  values on six pages this project wrote itself. It is a regression signal, not
  an accuracy benchmark.
- **`done` on amazon.in is the model reporting completion.** The cart was never
  independently verified. The site renders that claim in grey, beside the
  test-lab run in green where the page's own console printed the result. The
  whole epistemic argument is carried by the colour difference between two
  adjacent plates, and that is deliberate.
- **No audit, certification or compliance status is claimed**, and no ISRO
  endorsement is implied. SIH26171 is an ISRO-authored problem statement for a
  hackathon.

### The claim ledger

`assets/claims.js` is the single source of truth. Every figure carries a
`state` (`measured` / `tested` / `unverified` / `gap`), a `source`, and a
`caveat` — several of these numbers are actively misleading without their
conditions attached, so the caveat travels with the number instead of living in
a footnote.

Each figure also appears as static text in `index.html` so the page is correct
with JavaScript disabled. Two copies of a fact is how they come to disagree, so
`check-claims.mjs` asserts they match and refuses a `data-fig` naming a key that
does not exist. Run it before publishing.

---

## Why there is no React, no three.js and no library

The brief named `liquid-glass-js`, `shadergradient` and `react-three-fiber` as
visual references. All three were studied and none is used. Measured, not
assumed:

| approach | gzipped |
|---|---|
| hand-written WebGL2, gradient + one lit object | **2.8 KB** |
| three.js, fullscreen shader only | 134 KB |
| the r3f stack (three + r3f + react + react-dom) | 313 KB |
| + `drei` | 338–367 KB |

**react-three-fiber** is a 112x cost multiplier for two effects that need
neither a scene graph nor a reconciler, and it would force React 19 into a
Preact repository — `preact/compat` cannot satisfy it, because r3f reads React's
private reconciler internals. `drei` would also make a *privacy* site fetch an
HDRI from a GitHub CDN proxy and a Draco decoder from Google, by default.
Someone will open devtools on this page precisely because of what it claims.

**shadergradient** is React-only with three.js as a hard peer dependency, so it
was never adoptable. Its look is reproduced directly in `silk.js`: the mesh in
shadergradient exists only to turn one noise value into a surface a light can
hit, and a fragment shader gets there without geometry, lights or an
environment map.

**liquid-glass-js** solves a different problem. It rasterises the whole page
with `html2canvas` and refracts that bitmap — a **one-time snapshot** that never
re-runs. This page's backdrop is a moving gradient, so every panel would show a
still frame of it. It also composites its contents in a shader, so real HTML
cannot live inside a panel and stay selectable and accessible. `glass.js` uses
`backdrop-filter: url(#…)` on the genuinely live backdrop instead.

The site therefore makes **zero third-party requests**. The footer says so and
invites you to check, which is the only kind of privacy claim worth making here.
Fonts are self-hosted (148 KB, latin subset, variable) for the same reason.

---

## Files

```
index.html          the page. All copy lives here.
check-claims.mjs    asserts index.html matches the claim ledger
serve.mjs           local static server, no dependencies
assets/
  claims.js         SINGLE SOURCE OF TRUTH for every figure, gap and retraction
  styles.css        design system + every section
  site.js           entry point: reveals, nav, ledger rendering, hero demo
  corridor.js       the five-station stage, and the Luhn checksum
  silk.js           WebGL2 gradient
  glass.js          liquid-glass refraction, Chromium-gated
  fonts/            4 woff2 files, self-hosted
```

---

## Three things that will look like details and are not

**1. The refraction is gated by ENGINE, never by `@supports`.**
`CSS.supports('backdrop-filter', 'url(#x)')` returns **true in Chrome, Firefox
and Safari** — all three parse the declaration, only Chromium applies it. So
`@supports` is a guard that always passes. Firefox is excluded because it drops
the filter (and in some older builds made the element vanish, taking its text
with it); Safari is excluded because the open WebKit bug reports the GPU process
crashing repeatedly for as long as the page is open.

Related: the blur and the `url()` are never in the same declaration. A filter
list is one value, so an engine that cannot honour the `url()` discards the
whole list and takes the blur with it. Blur is in the base rule; the refraction
is a separate, JS-added override.

**2. The Luhn checksum in the corridor is computed, not re-enacted.**
Hardcoding the sums would have been less work than `luhnSteps()` and would also
have been the single most checkable falsehood on a site whose argument is that
other people publish figures nobody verified. The readout ticks from a real
accumulator and lands wherever the arithmetic lands: `4111 1111 1111 1111` sums
to 30, `1234 5678 9012 3456` sums to 64.

**3. Station 3 performs a real substitution.**
An earlier version only recoloured the values, leaving the card number legible
on screen while the caption above it said the value had been removed. That is
exactly the overclaim the rest of the site exists to argue against, and it
survived two rounds of screenshots before being caught.

---

## Degradation, verified

Every row below was checked in a real browser, not reasoned about:

| condition | result |
|---|---|
| no JavaScript | 13,363 characters of readable prose; headline, figures and all five station cards present |
| no WebGL | canvas stays hidden, the CSS gradient carries the hero, no errors |
| `prefers-reduced-motion` | nothing hidden, one still shader frame, travel becomes instant state change |
| `prefers-reduced-transparency` | solid panels, no blur, no shader |
| 390 px viewport | no horizontal overflow, sticky stage replaced by stacked cards, refraction off |
| keyboard only | skip link first, then nav, CTAs, the four deployment tabs (arrow-key navigable) |

The scrollytelling never intercepts scroll. It is native scroll plus sticky
positioning, with one IntersectionObserver per station setting a class.
