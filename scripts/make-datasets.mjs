import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Synthetic datasets for the analysis engine.
 *
 * EVERY VALUE HERE IS FABRICATED, and deliberately unmistakably so: names come
 * from a fixed list of obvious placeholders, the emails are all `@example.invalid`
 * (an RFC 2606 reserved TLD that cannot resolve), and every page carries a
 * SYNTHETIC banner. Nothing in this file is derived from a real person, a real
 * mission, or a real dataset.
 *
 * WHY IT IS GENERATED RATHER THAN COMMITTED at the large sizes. `src/harness/
 * fixtures/*.html` is globbed by `allFixtureIds()`, and every fixture there is
 * parsed and redacted by eight test files on every `npm test`. A 100,000-row
 * fixture in that directory would add minutes to every run for no coverage the
 * 100-row one does not already give. So: small sizes as fixtures, large sizes
 * here, gitignored, regenerated on demand.
 *
 *   node scripts/make-datasets.mjs            # 100, 1k, 10k, 100k
 *   node scripts/make-datasets.mjs 1000       # one size
 *
 * DETERMINISTIC. A seeded PRNG, not Math.random - a dataset that differs
 * between runs makes a failing statistic impossible to reproduce, and this
 * whole feature is about numbers being checkable.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test-site', 'data');

/** mulberry32. Small, fast, and identical on every platform. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so noise is normal rather than uniform. Real sensors are normal. */
function gauss(r) {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const FAKE_NAMES = [
  'Test Subject Alpha', 'Test Subject Bravo', 'Test Subject Charlie',
  'Sample Person Delta', 'Sample Person Echo', 'Demo User Foxtrot',
];

/**
 * ISRO-STYLE telemetry - the shape, not the data.
 *
 * Each channel carries a different, deliberately chosen behaviour so a test can
 * assert the engine distinguishes them:
 *
 *   altitude  strong linear climb        -> trend rising, high r2, forecastable
 *   velocity  climbs WITH altitude       -> strong positive correlation
 *   fuel      strong linear fall         -> trend falling
 *   temp      flat + noise + 3 spikes    -> flat trend, detectable outliers
 *   pressure  falls with altitude        -> strong NEGATIVE correlation
 *   voltage   pure noise, no trend       -> must NOT produce a confident forecast
 *
 * `operator` and `contact` are fake PII: the redactor must strip them, and the
 * analysis must report those columns as `redacted` rather than analysing them.
 */
function telemetry(rows, seed = 42) {
  const r = rng(seed);
  const out = [];
  // Roughly 1 in 40 cells is blank, so missing-value handling is exercised.
  const missing = () => r() < 0.025;
  for (let i = 0; i < rows; i += 1) {
    const t = i / Math.max(1, rows - 1);
    const spike = i % Math.max(97, Math.floor(rows / 3)) === 13 ? 45 : 0;
    out.push({
      sample: i + 1,
      time_s: (i * 0.5).toFixed(1),
      altitude_m: missing() ? '' : Math.round(120 + t * 41800 + gauss(r) * 60),
      velocity_ms: missing() ? '' : Math.round(8 + t * 7600 + gauss(r) * 25),
      pressure_kpa: missing() ? '' : (101.3 * Math.exp(-t * 4.2) + gauss(r) * 0.4).toFixed(2),
      temperature_c: missing() ? '' : (21.5 + gauss(r) * 1.4 + spike).toFixed(2),
      voltage_v: missing() ? '' : (28 + gauss(r) * 0.9).toFixed(3),
      fuel_pct: missing() ? '' : Math.max(0, 100 - t * 93 + gauss(r) * 0.8).toFixed(1),
      operator: FAKE_NAMES[i % FAKE_NAMES.length],
      contact: `subject${(i % 6) + 1}@example.invalid`,
    });
  }
  return out;
}

/** Sales: seasonal + growth, with a plausible currency format and a PII column. */
function sales(rows, seed = 7) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const season = 1 + 0.35 * Math.sin((i / 30) * Math.PI * 2);
    const revenue = (1800 + i * 3.1) * season * (1 + gauss(r) * 0.06);
    out.push({
      day: i + 1,
      region: ['North', 'South', 'East', 'West'][i % 4],
      units: Math.max(0, Math.round(revenue / 42 + gauss(r) * 3)),
      revenue_inr: `₹${revenue.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`,
      returns: Math.max(0, Math.round(gauss(r) * 2 + 3)),
      rep_email: `rep${(i % 8) + 1}@example.invalid`,
      rep_phone: `+91 98${String(76543210 + (i % 50)).slice(0, 8)}`,
    });
  }
  return out;
}

const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function table(rowsData) {
  if (rowsData.length === 0) return '<table></table>';
  const cols = Object.keys(rowsData[0]);
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rowsData
    .map((row) => `<tr>${cols.map((c) => `<td>${esc(row[c])}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

/**
 * A page. Inert by the same rule the harness fixtures follow: no script, no
 * iframe, no on* handler, no remote src - so it is safe to point a browser
 * agent at and impossible for it to do anything on its own.
 */
function page(title, intro, rowsData) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#14181f}
.warn{background:#fdf3e0;border-left:4px solid #8a5a00;padding:10px 14px;margin-bottom:16px}
table{border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px}
th,td{border:1px solid #e4e7ec;padding:4px 8px;text-align:right}
th{background:#f1f3f7;text-align:left}
td:first-child,th:first-child{text-align:left}
</style></head>
<body>
<p class="warn"><strong>SYNTHETIC TEST DATA.</strong> Every value on this page is
fabricated by <code>scripts/make-datasets.mjs</code>. The names are placeholders,
the addresses use the reserved <code>example.invalid</code> domain, and none of it
describes a real person, mission or measurement.</p>
<h1>${esc(title)}</h1>
<p>${esc(intro)} <strong>${rowsData.length.toLocaleString('en-US')}</strong> rows.</p>
${table(rowsData)}
</body></html>`;
}

const SIZES = process.argv[2] ? [Number(process.argv[2])] : [100, 1000, 10000, 100000];

mkdirSync(OUT, { recursive: true });
for (const n of SIZES) {
  const specs = [
    ['telemetry', 'Launch Telemetry (synthetic)', 'Simulated vehicle channels.', telemetry(n)],
    ['sales', 'Regional Sales (synthetic)', 'Simulated daily revenue.', sales(n)],
  ];
  for (const [stem, title, intro, data] of specs) {
    const file = join(OUT, `${stem}-${n}.html`);
    const html = page(title, intro, data);
    writeFileSync(file, html);
    console.log(
      `  ${stem.padEnd(10)} ${String(n).padStart(7)} rows  ${(html.length / 1024).toFixed(0).padStart(6)} KB  ${file}`,
    );
  }
}
console.log(`\nServe with: npm run test-site  ->  http://localhost:8080/data/telemetry-1000.html`);
