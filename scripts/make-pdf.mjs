/**
 * Renders an HTML document in this repo to PDF.
 *
 * Uses the Playwright already installed for panel screenshots, so this costs no
 * new dependency. Chromium's print pipeline is what honours the `@page` rules
 * and the `break-inside: avoid` on each question block - which is the whole
 * reason this is a real print render rather than an HTML-to-PDF library.
 *
 *   node scripts/make-pdf.mjs SIH26171-QA-Prep.html
 *
 * Output: the same basename with a .pdf extension, in the repo root.
 */

import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const input = process.argv[2];
if (input === undefined) {
  console.error('usage: node scripts/make-pdf.mjs <file.html>');
  process.exit(1);
}

const src = join(process.cwd(), input);
if (!existsSync(src)) {
  console.error(`no such file: ${src}`);
  process.exit(1);
}
const out = join(process.cwd(), `${basename(input, extname(input))}.pdf`);

const browser = await chromium.launch();
const page = await browser.newPage();

/*
 * `networkidle` rather than `load`, because the document embeds images by
 * relative path and a PDF rendered before they resolve has blank boxes where
 * the logos should be - which prints fine and is only noticed on paper.
 */
await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle' });

/*
 * `printBackground` is off by default and every coloured panel in these
 * documents is a background. Without it the PDF is legible but loses the entire
 * visual hierarchy - the SAY THIS boxes stop being distinguishable from body
 * text, which is the one thing they exist to be.
 */
await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:7pt;color:#8a97a3;padding:0 13mm;' +
    'font-family:Segoe UI,sans-serif;display:flex;justify-content:space-between">' +
    '<span>SIH26171 &middot; Team REGEX &middot; Privacy-Preserving Vision Agent</span>' +
    '<span class="pageNumber"></span></div>',
  margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' },
});

await browser.close();

const kb = Math.round(statSync(out).size / 1024);
console.log(`\nwrote ${out}  (${String(kb)} KB)\n`);
