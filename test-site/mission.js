/*
 * Live telemetry simulation for the SIH26171 analysis demo.
 *
 * WHY IT IS RANDOM PER RUN. A static table is the right thing for verification
 * and the wrong thing for a demonstration: shown a fixed page and a confident
 * answer, the reasonable question is whether the two were arranged to match.
 * The seed here is the clock. Nobody in the room - including whoever wrote this
 * - knows what the altitude will read when the agent is asked, and the seed is
 * printed so a run can be reproduced afterwards if it needs to be.
 *
 * WHY THE CHANNELS ARE THE SAME AS `scripts/make-datasets.mjs`. Each was chosen
 * there so that a different capability of the analysis engine has something to
 * find. Reusing them means the demo and the offline verification are the same
 * claim measured twice, rather than two unrelated exercises.
 *
 * NOTHING HERE IS REAL. Names are invented, addresses use `@example.invalid`
 * (RFC 2606, a TLD that can never be registered), the IPs are `198.51.100.x`
 * (RFC 5737 TEST-NET-2, reserved for documentation and not routable), and the
 * phone numbers are sequential placeholders carrying only the SHAPE the
 * detector looks for.
 */

/** mulberry32 - the same small PRNG the offline generator uses. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. Real instrument noise is Gaussian; uniform noise looks wrong. */
function gauss(r) {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/*
 * INVENTED OPERATORS. Deliberately ordinary-looking, because PII the redactor
 * can only catch when it is exotic proves nothing.
 */
const OPERATORS = [
  'A. Iyer',
  'M. Fernandes',
  'R. Bakshi',
  'S. Kulkarni',
  'D. Menon',
  'P. Raghavan',
];

/*
 * THREE KINDS OF PII, because one kind proves less than it looks like it does.
 *
 * A demo that removes only email addresses shows that the redactor knows one
 * regex. These are three different detectors on three different shapes, and two
 * of them are things a real ground-station log genuinely carries.
 *
 * Both ranges are RESERVED and can never belong to anyone:
 *   - `198.51.100.x` is TEST-NET-2, set aside by RFC 5737 for documentation.
 *     It is not routable and never will be.
 *   - The phone numbers are sequential placeholders in Indian mobile FORMAT so
 *     the detector sees the shape it looks for. They are not allocated and not
 *     dialled from anywhere in this project.
 *
 * `operator` stays a plain NAME on purpose, and it is the honest part of this
 * page: person names in free prose are NOT detected by this build - it needs
 * NER, which CLAUDE.md records as a known gap. So the demo shows a real
 * limitation next to three real detections rather than only the flattering half.
 */
const STATION_IPS = [
  '198.51.100.11',
  '198.51.100.12',
  '198.51.100.21',
  '198.51.100.22',
  '198.51.100.31',
  '198.51.100.32',
];

const OP_PHONES = [
  '9000000001',
  '9000000002',
  '9000000003',
  '9000000004',
  '9000000005',
  '9000000006',
];

const state = {
  seed: 0,
  r: null,
  frame: 0,
  rows: [],
  running: true,
  timer: null,
  intervalMs: 400,
  anomalyAt: -1,
};

const el = (id) => document.getElementById(id);

/**
 * One telemetry frame.
 *
 * `t` runs 0..1 across a nominal 1,200-frame ascent so the trends have a shape
 * rather than drifting forever; past that it holds at the top of the profile,
 * which is what a real ascent-then-coast looks like and keeps a long demo from
 * producing absurd altitudes.
 */
function frame(i) {
  const r = state.r;
  const t = Math.min(1, i / 1200);

  // Roughly one cell in forty is blank, so missing-value handling is exercised
  // rather than assumed. A few read "N/A", which is a different fact: a
  // declared absence rather than an empty cell.
  const missing = () => r() < 0.025;
  const na = () => r() < 0.012;
  const cell = (value) => (missing() ? '' : na() ? 'N/A' : value);

  // A spike the outlier detector should find. Injected on a schedule and also
  // on demand from the button, so the demo can produce one to order.
  const spike = i === state.anomalyAt || i % 97 === 13 ? 40 + r() * 12 : 0;

  return {
    frame: i + 1,
    time_s: (i * 0.5).toFixed(1),
    altitude_m: cell(String(Math.round(120 + t * 41800 + gauss(r) * 60))),
    velocity_ms: cell(String(Math.round(8 + t * 7600 + gauss(r) * 25))),
    pressure_kpa: cell((101.3 * Math.exp(-t * 4.2) + gauss(r) * 0.4).toFixed(2)),
    temperature_c: cell((21.5 + gauss(r) * 1.4 + spike).toFixed(2)),
    voltage_v: cell((28 + gauss(r) * 0.9).toFixed(3)),
    fuel_pct: cell(Math.max(0, 100 - t * 93 + gauss(r) * 0.8).toFixed(1)),
    operator: OPERATORS[i % OPERATORS.length],
    contact: `op${(i % 6) + 1}@example.invalid`,
    op_phone: OP_PHONES[i % OP_PHONES.length],
    station_ip: STATION_IPS[i % STATION_IPS.length],
  };
}

const NUMERIC = [
  'frame',
  'time_s',
  'altitude_m',
  'velocity_ms',
  'pressure_kpa',
  'temperature_c',
  'voltage_v',
  'fuel_pct',
];

function rowElement(row) {
  const tr = document.createElement('tr');
  for (const key of NUMERIC) {
    const td = document.createElement('td');
    td.className = 'num';
    td.textContent = String(row[key]);
    tr.appendChild(td);
  }
  for (const key of ['operator', 'contact', 'op_phone', 'station_ip']) {
    const td = document.createElement('td');
    td.className = 'pii';
    td.textContent = row[key];
    tr.appendChild(td);
  }
  return tr;
}

/*
 * A CAP, so a demo left running does not turn into a memory test.
 *
 * 4,000 rows is far more than the analysis ceiling needs to be interesting and
 * small enough that the tab stays responsive for as long as anyone will watch.
 * Oldest rows are dropped, which is what a real scrolling console does.
 */
const MAX_ROWS = 4000;

function append(count) {
  const body = el('downlink-body');
  const fragment = document.createDocumentFragment();
  for (let n = 0; n < count; n += 1) {
    const row = frame(state.frame);
    state.frame += 1;
    state.rows.push(row);
    fragment.appendChild(rowElement(row));
  }
  body.appendChild(fragment);

  while (state.rows.length > MAX_ROWS) {
    state.rows.shift();
    if (body.firstChild !== null) body.removeChild(body.firstChild);
  }

  const scroller = document.querySelector('.scroller');
  if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;

  render();
}

function render() {
  const last = state.rows[state.rows.length - 1];
  el('stat-rows').textContent = String(state.rows.length);
  el('stat-clock').textContent = last === undefined ? 'T+000.0 s' : `T+${last.time_s} s`;
  el('stat-state').textContent = state.running ? 'LIVE' : 'PAUSED';
  el('stat-seed').textContent = String(state.seed);

  /*
   * The size of the TABLE, not of the page, and it is a fact about this
   * document rather than a claim about the extension. The panel reports what
   * actually left the machine; the two are meant to be compared, and this page
   * is not entitled to state the second number.
   */
  const table = el('downlink');
  const bytes = table === null ? 0 : table.outerHTML.length;
  el('stat-bytes').textContent = `${(bytes / 1024).toFixed(1)} KB`;

  drawTrace();
}

/** Altitude and fuel, so the canvas shows the two trends the engine reports. */
function drawTrace() {
  const canvas = el('trace');
  if (canvas === null || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const series = state.rows.filter((row) => row.altitude_m !== '' && row.altitude_m !== 'N/A');
  if (series.length < 2) return;

  const step = Math.max(1, Math.floor(series.length / w));
  const points = [];
  for (let i = 0; i < series.length; i += step) points.push(series[i]);

  const alts = points.map((p) => Number(p.altitude_m)).filter((n) => Number.isFinite(n));
  const maxAlt = Math.max(...alts, 1);

  const line = (values, colour) => {
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    values.forEach((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * (w - 8) + 4;
      const y = h - 6 - (v / maxAlt) * (h - 14);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  line(alts, '#2563eb');
  const fuel = points
    .map((p) => Number(p.fuel_pct))
    .filter((n) => Number.isFinite(n))
    .map((n) => (n / 100) * maxAlt);
  line(fuel, '#d97706');
}

function tick() {
  if (!state.running) return;
  append(1);
}

function restart(seed) {
  if (state.timer !== null) clearInterval(state.timer);
  state.seed = seed;
  state.r = rng(seed);
  state.frame = 0;
  state.rows = [];
  state.anomalyAt = -1;
  el('downlink-body').textContent = '';
  // A demo that opens on an empty table has nothing to talk about, and the
  // engine needs a handful of rows before any statistic is honest anyway.
  append(60);
  state.timer = setInterval(tick, state.intervalMs);
  render();
}

el('btn-pause').addEventListener('click', () => {
  state.running = !state.running;
  el('btn-pause').textContent = state.running ? 'Pause downlink' : 'Resume downlink';
  render();
});

el('btn-anomaly').addEventListener('click', () => {
  // Fires on the NEXT frame, so the spike arrives while the page is watched
  // rather than being retro-fitted into rows already on screen.
  state.anomalyAt = state.frame;
  if (!state.running) append(1);
});

el('btn-burst').addEventListener('click', () => {
  append(500);
});

el('btn-reset').addEventListener('click', () => {
  restart((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
});

el('rate-select').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  state.intervalMs = value;
  if (state.timer !== null) clearInterval(state.timer);
  state.timer = setInterval(tick, state.intervalMs);
});

/*
 * SEEDED FROM THE CLOCK, and printed. Random enough that the answer cannot have
 * been prepared, recorded so a surprising run can be reproduced afterwards.
 */
restart((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
