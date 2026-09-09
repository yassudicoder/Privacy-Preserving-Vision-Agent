/**
 * Asserts the website cannot drift from its own claim ledger.
 *
 *   node site/check-claims.mjs
 *
 * WHY. Every figure on the page exists twice: once in `assets/claims.js`, which
 * is the source of truth, and once as static text inside the matching
 * `<span data-fig="...">` so the page reads correctly with JavaScript disabled.
 * Two copies of a fact is how they come to disagree, and a site whose whole
 * argument is that other people publish unverified numbers cannot be the site
 * where the headline says one thing and the tooltip says another.
 *
 * This also refuses a `data-fig` naming a key that does not exist, which would
 * silently render an empty span.
 *
 * Exits non-zero on any mismatch, so it can be wired into CI later.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const { CLAIMS } = await import(new URL('assets/claims.js', here).href);
const html = await readFile(fileURLToPath(new URL('index.html', here)), 'utf8');

const problems = [];
const seen = new Set();

const re = /<span[^>]*data-fig="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g;
let m;
while ((m = re.exec(html)) !== null) {
  const [, key, rawText] = m;
  seen.add(key);

  const claim = CLAIMS[key];
  if (!claim) {
    problems.push(`data-fig="${key}" has no entry in claims.js`);
    continue;
  }

  const text = rawText.replace(/\s+/g, ' ').trim();
  if (text !== claim.display) {
    problems.push(
      `data-fig="${key}": index.html says "${text}", claims.js says "${claim.display}"`,
    );
  }
}

// Every claim should also carry the two things that make it checkable. A figure
// with no source is a figure nobody can verify, and several of these are
// actively misleading without their conditions attached.
for (const [key, c] of Object.entries(CLAIMS)) {
  if (!c.source) problems.push(`claims.js "${key}" has no source`);
  if (!c.caveat) problems.push(`claims.js "${key}" has no caveat`);
  if (!['measured', 'tested', 'unverified', 'gap'].includes(c.state)) {
    problems.push(`claims.js "${key}" has an unknown state "${c.state}"`);
  }
}

if (problems.length > 0) {
  console.error('claim ledger and page disagree:\n');
  for (const p of problems) console.error('  x ' + p);
  console.error('');
  process.exit(1);
}

console.log(
  `ok - ${seen.size} figures in index.html match claims.js ` +
    `(${Object.keys(CLAIMS).length} claims defined, all sourced and caveated)`,
);
