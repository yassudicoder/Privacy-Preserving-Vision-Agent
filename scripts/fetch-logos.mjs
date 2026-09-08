/**
 * Downloads the tech-stack logos used by the SIH presentation.
 *
 * WHY A SCRIPT AND NOT A FOLDER OF FILES. Brand logos are not ours to vendor
 * into the repository - they are trademarks, and several of the licences here
 * permit use but not redistribution. Fetching them on demand keeps the repo
 * clean, keeps `ppt-assets/` gitignored, and makes it obvious where each mark
 * actually came from.
 *
 * Two sources, and the difference matters:
 *   - Simple Icons (CC0) covers most of the stack and serves a single-colour
 *     SVG per brand at a slug. Single-colour means it takes the brand colour we
 *     pass, so it drops onto any slide background.
 *   - Anything Simple Icons does NOT carry gets a generated placeholder badge
 *     instead of a silent gap, because a missing logo on a slide is noticed at
 *     the worst possible moment.
 *
 *   node scripts/fetch-logos.mjs
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'ppt-assets', 'logos');

/**
 * The stack, in the order it appears on the Technical Approach slide.
 *
 * `slug` is the Simple Icons identifier. `hex` is the brand colour; passing it
 * explicitly rather than relying on the default means a logo that Simple Icons
 * recolours later does not silently change on our slide.
 */
const LOGOS = [
  // Frontend
  { name: 'typescript', slug: 'typescript', hex: '3178C6', label: 'TypeScript 5.9' },
  { name: 'preact', slug: 'preact', hex: '673AB8', label: 'Preact 10.27' },
  { name: 'vite', slug: 'vite', hex: '646CFF', label: 'Vite (via WXT)' },

  // Extension platform
  { name: 'chrome', slug: 'googlechrome', hex: '4285F4', label: 'Chrome MV3' },
  { name: 'firefox', slug: 'firefoxbrowser', hex: 'FF7139', label: 'Firefox MV3' },

  // On-device AI
  { name: 'onnx', slug: 'onnx', hex: '005CED', label: 'ONNX Runtime Web' },
  { name: 'opencv', slug: 'opencv', hex: '5C3EE8', label: 'OpenCV YuNet' },
  { name: 'webassembly', slug: 'webassembly', hex: '654FF0', label: 'WebAssembly SIMD' },

  // Backend
  { name: 'nodejs', slug: 'nodedotjs', hex: '5FA04E', label: 'Node.js 20+' },
  { name: 'render', slug: 'render', hex: '000000', label: 'Render' },

  // Cloud AI
  { name: 'gemini', slug: 'googlegemini', hex: '8E75B2', label: 'Google Gemini' },
  { name: 'ollama', slug: 'ollama', hex: '000000', label: 'Ollama' },

  // Testing / tooling
  { name: 'vitest', slug: 'vitest', hex: '6E9F18', label: 'Vitest 3.2' },
  { name: 'npm', slug: 'npm', hex: 'CB3837', label: 'npm' },
  { name: 'github', slug: 'github', hex: '181717', label: 'GitHub' },
];

/**
 * Marks with no Simple Icons entry, drawn here instead.
 *
 * WXT and WebGPU have no CC0 icon available, and ONNX Runtime Web is a
 * different thing from the ONNX format mark. A generated badge is honest about
 * being ours; a scaled-up screenshot of somebody's README banner would not be.
 */
const GENERATED = [
  { name: 'wxt', text: 'WXT', sub: '0.20', hex: '67D55E' },
  /*
   * OpenAI and Playwright were REMOVED from Simple Icons, which happens when a
   * rights holder asks. `openaigym` still resolves and is a DIFFERENT product;
   * dropping it in because the slug is close would put the wrong company's mark
   * on the slide. A wordmark we drew ourselves is the honest substitute, and the
   * official asset is a press-kit download away if you want the real thing.
   */
  { name: 'openai', text: 'OpenAI', sub: 'gpt-5.6-luna', hex: '412991' },
  { name: 'playwright', text: 'Playwright', sub: '1.62', hex: '2EAD33' },
  { name: 'webgpu', text: 'WebGPU', sub: 'GPU', hex: '005A9C' },
  { name: 'manifest-v3', text: 'MV3', sub: 'Manifest', hex: '4285F4' },
];

function badge({ text, sub, hex }) {
  // Deliberately plain: a slide gets its styling from the slide, and a badge
  // with its own gradient fights whatever theme it lands on.
  const size = 240;
  const fs = text.length > 5 ? 44 : 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="28" fill="#${hex}"/>
  <text x="50%" y="47%" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="700"
        fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${text}</text>
  <text x="50%" y="70%" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="500"
        fill="#ffffffcc" text-anchor="middle" dominant-baseline="middle">${sub}</text>
</svg>`;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const ok = [];
  const failed = [];

  for (const logo of LOGOS) {
    const url = `https://cdn.simpleicons.org/${logo.slug}/${logo.hex}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        failed.push({ ...logo, reason: `HTTP ${String(res.status)}` });
        continue;
      }
      const svg = await res.text();
      // A CDN that answers 200 with an HTML error page would otherwise write a
      // file named .svg that PowerPoint refuses to place, with no clue why.
      if (!svg.trimStart().startsWith('<svg')) {
        failed.push({ ...logo, reason: 'response was not an SVG' });
        continue;
      }
      await writeFile(join(OUT, `${logo.name}.svg`), svg, 'utf8');
      ok.push({ ...logo, bytes: svg.length });
    } catch (err) {
      failed.push({ ...logo, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const g of GENERATED) {
    await writeFile(join(OUT, `${g.name}.svg`), badge(g), 'utf8');
    ok.push({ ...g, label: `${g.text} (generated)`, bytes: badge(g).length });
  }

  console.log(`\nlogos -> ppt-assets/logos/\n`);
  for (const o of ok) console.log(`  OK    ${o.name.padEnd(14)} ${String(o.bytes).padStart(6)} B   ${o.label}`);
  for (const f of failed) console.log(`  MISS  ${f.name.padEnd(14)}        ${f.reason}`);
  console.log(`\n${String(ok.length)} written, ${String(failed.length)} missing\n`);

  if (failed.length > 0) {
    console.log('Missing marks must be sourced by hand from the vendor press kit.');
    console.log('Do not substitute a lookalike - a wrong logo is worse than none.\n');
  }
}

/**
 * Also write PNGs, because PowerPoint only reads SVG from 2016 onwards.
 *
 * A deck built on a machine running 365 and opened on a lab PC running 2013
 * shows an empty box where each logo was, and nobody finds out until the room
 * is full. PNG at 512 px covers every version and still looks clean on a
 * projector. Transparent background, so a mark drops onto any slide colour.
 *
 * Playwright is already a devDependency - it renders the panel for screenshots
 * - so this costs no new install. If it is missing the SVGs are still written
 * and this says so, rather than failing the whole run over a nicety.
 */
async function rasterise() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('playwright unavailable - SVGs written, PNGs skipped\n');
    return;
  }

  const SIZE = 512;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });

  const files = (await readdir(OUT)).filter((f) => f.endsWith('.svg'));
  let n = 0;
  for (const file of files) {
    const svg = await readFile(join(OUT, file), 'utf8');
    /*
     * The SVG is INLINED rather than opened by URL. A file:// navigation per
     * logo is slower and, on Windows, needs path escaping that is easy to get
     * subtly wrong for one filename out of twenty - and a logo that silently
     * renders blank is exactly the failure this function exists to prevent.
     */
    const scaled = svg
      .replace(/width="[^"]*"/, `width="${String(SIZE)}"`)
      .replace(/height="[^"]*"/, `height="${String(SIZE)}"`);
    await page.setContent(
      `<body style="margin:0;background:transparent">${scaled}</body>`,
    );
    await page.screenshot({
      path: join(OUT, file.replace(/\.svg$/, '.png')),
      omitBackground: true,
    });
    n += 1;
  }
  await browser.close();
  console.log(`${String(n)} PNGs written at ${String(SIZE)}x${String(SIZE)}, transparent\n`);
}

await main();
await rasterise();
