/**
 * Entry point. Everything here degrades: if this file fails to parse, the page
 * is still complete prose with a CSS gradient hero and static figures. Nothing
 * below is required to understand the product.
 */

import { CLAIMS, GAPS, RETRACTIONS, STATE_LABEL } from './claims.js';
import { mountSilk } from './silk.js';
import { initGlass } from './glass.js';
import { initCorridor } from './corridor.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/* ───────────────────────────────────────────────────────── the gradient ── */
function initSilk() {
  const hero = document.getElementById('silk-hero');
  if (hero) mountSilk(hero);

  // The closing shader is the hero's palette with the ember crest raised and
  // the phase offset, so the loop closes without looking like a repeat.
  const foot = document.getElementById('silk-foot');
  if (foot) {
    mountSilk(foot, {
      colors: ['#0a0812', '#2a1450', '#8a4a9e', '#F2A070'],
      brightness: 1.06,
      specular: 0.46,
      vignette: 0.58,
      phase: 42,
    });
  }
}

/* ────────────────────────────────────────────────────────────── reveals ── */
function initReveals() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
  );

  document.querySelectorAll('.reveal').forEach((el, i) => {
    // A short stagger within a section, capped so a long list does not end up
    // waiting a second and a half for its last item.
    el.style.transitionDelay = `${Math.min(i % 6, 5) * 55}ms`;
    io.observe(el);
  });

  // Sections that drive their own animation from a class on themselves.
  const sectionIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        sectionIo.unobserve(e.target);
      }
    },
    { threshold: 0.25 },
  );
  ['.problem', '.corridor-intro', '[data-bar]', '[data-rules]'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) sectionIo.observe(el);
  });
}

/* ────────────────────────────────────────────────────────────────── nav ── */
function initNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  let ticking = false;
  const update = () => {
    nav.classList.toggle('is-stuck', scrollY > 120);
    ticking = false;
  };
  addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

/* ─────────────────────────────────────────────────── the claim ledger ──── */
/**
 * Stamps every figure from claims.js into the page.
 *
 * The HTML carries the same value as static text so the page is correct with
 * no JavaScript at all; this overwrites it from the ledger. `check-claims.mjs`
 * asserts the two agree, so the fallback cannot silently drift from the source
 * of truth.
 */
function stampFigures() {
  for (const el of document.querySelectorAll('[data-fig]')) {
    const claim = CLAIMS[el.dataset.fig];
    if (claim) el.textContent = claim.display;
  }
}

function renderGaps() {
  const list = document.querySelector('[data-gaps]');
  if (!list) return;
  for (const gap of GAPS) {
    const li = document.createElement('li');
    li.className = 'gap-item';

    const h = document.createElement('h3');
    h.className = 'gap-h';
    h.textContent = gap.title;

    const p = document.createElement('p');
    p.className = 'gap-b';
    p.textContent = gap.body;

    const s = document.createElement('p');
    s.className = 'gap-s';
    s.textContent = gap.source;

    li.append(h, p, s);
    list.append(li);
  }
}

function renderFigures() {
  const grid = document.querySelector('[data-figs]');
  if (!grid) return;

  // The seven a scanner or a journalist actually needs, in the order that tells
  // the story: what it is, what it costs, what was proved, what was run.
  const order = [
    'model.bytes',
    'model.ms',
    'pii.kinds',
    'tests.count',
    'leak.test',
    'fixtures.score',
    'run.testlab',
    'package.mb',
  ];

  for (const key of order) {
    const c = CLAIMS[key];
    if (!c) continue;

    const cell = document.createElement('div');
    cell.className = 'fig';
    cell.tabIndex = 0;

    const n = document.createElement('p');
    n.className = 'fig-n';
    n.textContent = c.display;

    const u = document.createElement('p');
    u.className = 'fig-u';
    u.textContent = c.unit;

    const l = document.createElement('p');
    l.className = 'fig-l';
    l.textContent = c.label;

    const chip = document.createElement('span');
    chip.className = `chip chip-${c.state}`;
    chip.textContent = STATE_LABEL[c.state] ?? c.state;

    const pop = document.createElement('div');
    pop.className = 'fig-pop';
    pop.textContent = c.caveat;
    const src = document.createElement('span');
    src.className = 'fig-pop-s';
    src.textContent = c.source;
    pop.append(src);

    cell.append(n, u, l, chip, pop);

    // Touch devices have no hover; a tap opens the caveat instead.
    cell.addEventListener('click', () => {
      const open = cell.classList.contains('is-open');
      grid.querySelectorAll('.fig.is-open').forEach((x) => x.classList.remove('is-open'));
      cell.classList.toggle('is-open', !open);
    });

    grid.append(cell);
  }
}

function renderRetractions() {
  const list = document.querySelector('[data-retractions]');
  if (!list) return;
  for (const r of RETRACTIONS) {
    const li = document.createElement('li');

    const w = document.createElement('span');
    w.className = 'rt-wrong';
    w.textContent = r.wrong;

    const c = document.createElement('span');
    c.className = 'rt-right';
    c.textContent = r.right;

    const y = document.createElement('span');
    y.className = 'rt-why';
    y.textContent = r.why;

    li.append(w, c, y);
    list.append(li);
  }
}

/* ───────────────────────────────────────────────────────── the hero demo ── */
/**
 * The three-second demonstration: a filled payment form, held long enough to
 * read and feel exposed, then wiped value by value into markers.
 *
 * It is labelled as a demonstration in the caption beside it, because it is
 * page JavaScript and not the shipped detector. On a site whose argument is
 * that other people overclaim, an unlabelled re-enactment is the first thing a
 * hostile reader would find.
 */
function initHeroDemo() {
  const form = document.querySelector('[data-demo-form]');
  if (!form) return;

  const badge = document.querySelector('[data-demo-badge]');
  const fields = [...form.querySelectorAll('.ff-value[data-pii]')];
  const payBtn = form.querySelector('.ff-btn');

  const ORDINAL = { 'person-name': 1, 'credit-card': 2, dob: 3, cvv: 4, email: 5 };
  const KIND = {
    'person-name': 'PERSON_NAME',
    'credit-card': 'CREDIT_CARD',
    dob: 'DOB',
    cvv: 'CVV',
    email: 'EMAIL',
  };

  for (const f of fields) {
    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = `[[PII:${KIND[f.dataset.pii]}:${ORDINAL[f.dataset.pii]}:9f2a]]`;
    f.append(marker);
  }

  const run = () => {
    fields.forEach((f, i) => {
      setTimeout(() => f.classList.add('is-wiped'), i * 90);
    });
    setTimeout(() => {
      badge?.classList.add('is-sent');
      if (badge) badge.textContent = 'sanitized · sent';
      payBtn?.classList.add('is-target');
    }, fields.length * 90 + 420);
  };

  if (reduced.matches) {
    fields.forEach((f) => f.classList.add('is-wiped'));
    badge?.classList.add('is-sent');
    if (badge) badge.textContent = 'sanitized · sent';
    payBtn?.classList.add('is-target');
    return;
  }

  // 900 ms of hold before the wipes. Long enough to actually read the card
  // number, which is the point — the relief only lands if the exposure did.
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      setTimeout(run, 1500);
    },
    { threshold: 0.4 },
  );
  io.observe(form);
}

/* ────────────────────────────────────────────────────────── deployments ── */
/**
 * Selecting a destination moves the boundary line and relabels the network
 * side. The payload block beside it does not change, because in the product it
 * does not change. The argument is made by the interaction, not by a sentence.
 */
function initTiers() {
  const wrap = document.querySelector('[data-tiers]');
  if (!wrap) return;

  const line = document.querySelector('[data-mini-line]');
  const dest = document.querySelector('[data-mini-dest]');
  const tiers = [...wrap.querySelectorAll('.tier')];

  const select = (btn) => {
    tiers.forEach((t) => {
      const on = t === btn;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (line) line.style.left = `${btn.dataset.pos}%`;
    if (dest) dest.textContent = btn.dataset.dest;
  };

  tiers.forEach((t) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const i = tiers.indexOf(t);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = tiers[(i + 1) % tiers.length];
        next.focus();
        select(next);
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = tiers[(i - 1 + tiers.length) % tiers.length];
        prev.focus();
        select(prev);
      }
    });
  });
}

/* ────────────────────────────────────────────── the live network count ── */
/**
 * Counts requests this page makes after load, in the visitor's own browser.
 *
 * It should stay at zero: the fonts are self-hosted and preloaded, there is no
 * analytics, no CDN and no third-party script. This is a claim the reader can
 * check in four seconds with devtools, which is the only kind of privacy claim
 * worth making on a page like this.
 *
 * Note it counts honestly. If something ever does fire, the number goes up and
 * turns amber — it is not clamped, and a counter that could only ever read zero
 * would be a picture of a zero rather than a measurement.
 */
function initNetCount() {
  const el = document.querySelector('[data-netcount]');
  const n = document.querySelector('[data-netcount-n]');
  if (!el || !n || typeof PerformanceObserver === 'undefined') return;

  let count = 0;
  const armed = { yes: false };

  const bump = (entries) => {
    if (!armed.yes) return;
    for (const entry of entries) {
      // Ignore the browser's own bookkeeping; count real fetches.
      if (entry.entryType !== 'resource') continue;
      count += 1;
    }
    n.textContent = String(count);
    el.classList.toggle('is-nonzero', count > 0);
  };

  try {
    const po = new PerformanceObserver((list) => bump(list.getEntries()));
    po.observe({ type: 'resource', buffered: false });
  } catch {
    return;
  }

  // Arm only once everything the document declared has finished, so preloaded
  // fonts and the module graph are not counted as things the page went and
  // fetched afterwards.
  if (document.readyState === 'complete') armed.yes = true;
  else addEventListener('load', () => setTimeout(() => { armed.yes = true; }, 400));
}

/* ──────────────────────────────────────────────────────────────── start ── */
function start() {
  stampFigures();
  renderGaps();
  renderFigures();
  renderRetractions();
  initNav();
  initReveals();
  initHeroDemo();
  initTiers();
  initCorridor();
  initNetCount();

  // The gradient and the refraction go last: they are the only two things here
  // that touch the GPU, and neither is needed for the page to be finished.
  initSilk();
  initGlass();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
