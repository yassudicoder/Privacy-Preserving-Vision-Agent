/**
 * Builds the tech-stack logo reference: labelled PNGs, and a PDF sheet.
 *
 * TWO OUTPUTS, BECAUSE "COPY THE LOGO AND ITS NAME" HAS TWO ANSWERS.
 *
 *   ppt-assets/labelled/*.png   ONE image per technology, logo above its name,
 *                               transparent, 640x760. Drag one into PowerPoint
 *                               and you get the mark and the caption together,
 *                               already aligned, at full resolution.
 *
 *   SIH26171-Logo-Sheet.pdf     All twenty on a page, each with its filename.
 *                               A reference for finding the right file, and a
 *                               fallback if you only have the PDF to hand.
 *
 * The PDF is the WORSE of the two for actually pasting, and it is worth knowing
 * why: copying an image region out of a PDF hands the clipboard a bitmap at
 * whatever resolution the viewer happened to render, not the original asset. On
 * a projector that shows. The labelled PNGs exist so nobody has to.
 *
 *   node scripts/make-logo-sheet.mjs
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'ppt-assets', 'logos');
const OUT = join(ROOT, 'ppt-assets', 'labelled');
const SHEET_HTML = join(ROOT, 'SIH26171-Logo-Sheet.html');

/**
 * The stack, grouped exactly as the Technical Approach slide groups it.
 *
 * `note` is the version or the role - the thing a judge's eye needs beside the
 * mark. It is kept in this file rather than typed onto each slide so the deck
 * and the sheet cannot drift apart.
 */
const GROUPS = [
  {
    group: 'Frontend',
    items: [
      { file: 'typescript', name: 'TypeScript', note: '5.9.3 · strict' },
      { file: 'preact', name: 'Preact', note: '10.27.2 · UI' },
      { file: 'wxt', name: 'WXT', note: '0.20.13 · build' },
      { file: 'vite', name: 'Vite', note: 'bundler, via WXT' },
    ],
  },
  {
    group: 'Extension platform',
    items: [
      { file: 'chrome', name: 'Chrome', note: 'Manifest V3' },
      { file: 'firefox', name: 'Firefox', note: 'Manifest V3' },
      { file: 'manifest-v3', name: 'Manifest V3', note: 'both browsers' },
    ],
  },
  {
    group: 'On-device AI',
    items: [
      { file: 'onnx', name: 'ONNX Runtime Web', note: 'in-browser inference' },
      { file: 'opencv', name: 'OpenCV YuNet', note: '232 KB · 30.3 ms' },
      { file: 'webgpu', name: 'WebGPU', note: 'GPU execution provider' },
      { file: 'webassembly', name: 'WebAssembly', note: 'SIMD fallback' },
    ],
  },
  {
    group: 'Backend',
    items: [
      { file: 'nodejs', name: 'Node.js', note: '20+ · native HTTP' },
      { file: 'render', name: 'Render', note: 'hosting' },
      { file: 'npm', name: 'npm', note: 'packages' },
    ],
  },
  {
    group: 'Cloud AI',
    items: [
      { file: 'gemini', name: 'Google Gemini', note: 'cloud planner' },
      { file: 'openai', name: 'OpenAI', note: 'alternative planner' },
      { file: 'ollama', name: 'Ollama', note: 'local planner' },
    ],
  },
  {
    group: 'Testing & tooling',
    items: [
      { file: 'vitest', name: 'Vitest', note: '3.2.4 · 1,169 tests' },
      { file: 'playwright', name: 'Playwright', note: '1.62.1 · rendering' },
      { file: 'github', name: 'GitHub', note: 'source' },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));

/**
 * Dark text on a transparent ground.
 *
 * The deck's stack panel is white, so dark is right there. It is stated because
 * a transparent PNG with dark lettering is invisible on a dark slide, and that
 * is the kind of thing discovered in the room rather than at the desk.
 */
const INK = '#16202b';
const MUTED = '#5d6b79';

async function labelled(page) {
  await mkdir(OUT, { recursive: true });
  let n = 0;

  for (const item of ALL) {
    const src = join(SRC, `${item.file}.png`);
    if (!existsSync(src)) {
      console.log(`  MISSING  ${item.file}.png`);
      continue;
    }
    const b64 = (await readFile(src)).toString('base64');

    await page.setViewportSize({ width: 640, height: 760 });
    await page.setContent(`<body style="margin:0;width:640px;height:760px;background:transparent;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;
        font-family:'Segoe UI',Arial,sans-serif">
      <img src="data:image/png;base64,${b64}" style="width:420px;height:420px;object-fit:contain">
      <div style="text-align:center">
        <div style="font-size:56px;font-weight:700;color:${INK};line-height:1.1">${item.name}</div>
        <div style="font-size:32px;color:${MUTED};margin-top:12px">${item.note}</div>
      </div>
    </body>`);
    await page.screenshot({ path: join(OUT, `${item.file}.png`), omitBackground: true });
    n += 1;
  }
  return n;
}

/*
 * THE SHEET USES THE PLAIN MARKS, NOT THE LABELLED ONES.
 *
 * The labelled PNGs already carry their caption, so embedding them here printed
 * every name TWICE - once as a real caption and once as illegible four-point
 * lettering inside the image. The sheet supplies its own caption; the labelled
 * files are the separate deliverable and this page is the index to them.
 */
function sheetHtml() {
  const cards = GROUPS.map(
    (g) => `
    <h2>${g.group}</h2>
    <div class="row">
      ${g.items
        .map(
          (i) => `<figure>
        <img src="ppt-assets/logos/${i.file}.png" alt="">
        <figcaption><b>${i.name}</b><span>${i.note}</span>
        <code>${i.file}.png</code></figcaption>
      </figure>`,
        )
        .join('')}
    </div>`,
  ).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SIH26171 Tech Stack Logos</title>
<style>
@page{size:A4;margin:12mm}
body{margin:0;font:10pt/1.45 "Segoe UI",Arial,sans-serif;color:#26333f}
h1{font-size:22pt;color:#12405c;margin:0 0 4pt}
.sub{color:#5d6b79;margin:0 0 12pt;font-size:10.5pt}
.note{background:#fdf6e9;border-left:4pt solid #9a5b0c;padding:8pt 11pt;margin:0 0 14pt;border-radius:0 3pt 3pt 0;font-size:9.5pt}
.note b{color:#9a5b0c}
h2{font-size:11pt;color:#0a7f74;text-transform:uppercase;letter-spacing:1pt;
   margin:14pt 0 6pt;border-bottom:1.5pt solid #e9f4f2;padding-bottom:3pt;break-after:avoid}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:10pt;break-inside:avoid}
figure{margin:0;border:1px solid #d5dde4;border-radius:4pt;padding:9pt 6pt;text-align:center;background:#fff;break-inside:avoid}
figure img{width:52pt;height:52pt;object-fit:contain}
figcaption{margin-top:5pt;line-height:1.3}
figcaption b{display:block;font-size:9.5pt;color:#16202b}
figcaption span{display:block;font-size:8pt;color:#5d6b79;margin-top:1pt}
figcaption code{display:block;font-family:Consolas,monospace;font-size:7pt;color:#0a7f74;margin-top:4pt}
footer{margin-top:16pt;padding-top:8pt;border-top:1.5pt solid #d5dde4;color:#5d6b79;font-size:8.5pt}
</style></head><body>
<h1>Tech Stack Logos</h1>
<p class="sub"><b>SIH26171 &mdash; Privacy-Preserving Vision Agent</b> &nbsp;|&nbsp; Team REGEX &nbsp;|&nbsp; 20 marks, grouped as on the Technical Approach slide</p>

<div class="note"><b>For the best result, use the PNG files rather than copying from this page.</b>
Each image below is <code>ppt-assets/labelled/&lt;name&gt;.png</code> &mdash; a single transparent
640&times;760 file with the logo above its caption, so dragging one into PowerPoint gives you both,
already aligned, at full resolution. Copying a region out of a PDF gives a screen-resolution
bitmap instead, which shows on a projector. Plain unlabelled marks are in
<code>ppt-assets/logos/</code> as PNG and SVG.<br><br>
The captions are <b>dark text on transparency</b>, sized for a light slide. On a dark background
use the unlabelled marks and set your own caption colour.</div>
${cards}
<footer>Regenerate with <code>node scripts/make-logo-sheet.mjs</code>.
Marks are their owners' trademarks, used to identify the technologies this project builds on.
<b>OpenAI, Playwright, WXT, WebGPU and Manifest V3 are our own lettering</b>, not official artwork &mdash;
no free mark exists for them, and substituting a lookalike would put the wrong company's logo on a slide.</footer>
</body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();

const n = await labelled(page);
console.log(`\n${String(n)} labelled PNGs -> ppt-assets/labelled/`);

await writeFile(SHEET_HTML, sheetHtml(), 'utf8');
await browser.close();
console.log(`wrote ${SHEET_HTML}`);
console.log('now: node scripts/make-pdf.mjs SIH26171-Logo-Sheet.html\n');
