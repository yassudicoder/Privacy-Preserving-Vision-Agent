import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value?.startsWith('--')) {
    const next = process.argv[i + 1];
    args.set(value.slice(2), next?.startsWith('--') ? 'true' : (next ?? 'true'));
  }
}

const url = args.get('url') ?? 'http://localhost:8080/index.html';
const outputDir = resolve(args.get('out') ?? 'artifacts/browser-benchmark');
const allowRemote = args.get('allow-remote') === 'true';
const width = Number(args.get('width') ?? 1280);
const height = Number(args.get('height') ?? 800);
const timeout = Number(args.get('timeout') ?? 20_000);
const executablePath = args.get('executable') ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH;

function isLoopback(target) {
  try {
    const host = new URL(target).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

if (!allowRemote && !isLoopback(url)) {
  throw new Error(`Refusing non-loopback URL: ${url}. Pass --allow-remote only for an explicitly approved site.`);
}
if (!Number.isInteger(width) || width < 320 || !Number.isInteger(height) || height < 240) {
  throw new Error('width and height must be sensible integer viewport dimensions');
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(timeout);

const started = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);

const map = await page.evaluate(() => {
  const interactive = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      rect.width > 0 && rect.height > 0;
  };
  const name = (el) => {
    const labelled = el.getAttribute('aria-label');
    if (labelled?.trim()) return labelled.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (text) return text;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();
    const alt = el.getAttribute('alt');
    if (alt?.trim()) return alt.trim();
    const text = el.textContent?.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 140) : null;
  };
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.matches('button')) return 'button';
    if (el.matches('a[href]')) return 'link';
    if (el.matches('textarea')) return 'textbox';
    if (el.matches('select')) return 'combobox';
    if (el.matches('input[type="search"]')) return 'searchbox';
    if (el.matches('input')) return 'textbox';
    return 'generic';
  };
  const elements = [...document.querySelectorAll(interactive)]
    .filter(visible)
    .map((el, index) => {
      const rect = el.getBoundingClientRect();
      const group = el.closest('article,li,section,[role="group"],[role="article"],.product-card,.product,.card,.result');
      const groupHeading = group?.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      return {
        ref: `b${index + 1}`,
        tag: el.tagName.toLowerCase(),
        role: role(el),
        name: name(el),
        groupName: groupHeading?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? null,
        disabled: el.matches(':disabled,[aria-disabled="true"]'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    elements,
    pageTextLength: document.body?.innerText?.length ?? 0,
  };
});

await page.evaluate((elements) => {
  const host = document.createElement('div');
  host.id = '__sih_benchmark_refs';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const item of elements) {
    const label = document.createElement('span');
    label.textContent = item.ref;
    label.style.cssText = `position:fixed;left:${item.rect.x}px;top:${item.rect.y}px;background:#d71920;color:white;font:700 11px/1.2 monospace;padding:2px 3px;border-radius:2px;box-shadow:0 0 0 1px white`;
    host.append(label);
  }
  document.documentElement.append(host);
}, map.elements);

const screenshotPath = resolve(outputDir, 'tagged-page.jpg');
await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 65, fullPage: false });
const metrics = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    domContentLoadedMs: Math.round(nav?.domContentLoadedEventEnd ?? 0),
    loadEventMs: Math.round(nav?.loadEventEnd ?? 0),
    resourceCount: performance.getEntriesByType('resource').length,
    jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  url,
  viewport: { width, height },
  elapsedMs: Date.now() - started,
  semanticMap: map,
  metrics,
  artifacts: { screenshot: screenshotPath },
};
await writeFile(resolve(outputDir, 'semantic-map.json'), JSON.stringify(map, null, 2));
await writeFile(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();

console.log(JSON.stringify({
  url,
  interactiveElements: map.elements.length,
  visibleElements: map.elements.filter((item) => item.rect.width > 0 && item.rect.height > 0).length,
  resources: metrics.resourceCount,
  elapsedMs: report.elapsedMs,
  screenshot: screenshotPath,
  report: resolve(outputDir, 'report.json'),
}, null, 2));
