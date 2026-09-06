/**
 * DOMParser in plain Node.
 *
 * Vitest supplies a DOM to files carrying a `// @vitest-environment jsdom`
 * docblock, but standalone scripts like `npm run scorecard` run under bare Node
 * where `DOMParser` does not exist. Rather than have redaction/ carry a Node
 * fallback - which would drag jsdom into the extension bundle - the harness
 * installs one here, at the edge, and only when it is missing.
 */
export async function ensureDomParser(): Promise<void> {
  if (typeof globalThis.DOMParser !== 'undefined') return;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('');
  globalThis.DOMParser = dom.window.DOMParser as unknown as typeof globalThis.DOMParser;
}
