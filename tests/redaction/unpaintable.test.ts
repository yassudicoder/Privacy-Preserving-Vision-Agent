// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markUntrusted } from '@/contracts/index.ts';
import { redact, resolveDomPath } from '@/redaction/index.ts';

/**
 * `<input type="hidden">` is owed no pixel op, and nothing else is.
 *
 * From a real amazon.in run: every step withheld the screenshot with
 * `1 of 3 applied redaction(s) produced no pixel op (api-key)`, and the api-key
 * was `<input type="hidden" name="glow-validation-token">`. Redacting its value
 * is right. Demanding that it also be blacked out of a picture it can never
 * appear in cost the model its image on every page of the site.
 *
 * The exemption rests on the HTML spec's rendering rules -
 * `input[type=hidden i] { display: none !important; }` in the user-agent sheet,
 * which no author style can override - and on nothing layout-derived.
 */
const PAGE = `<!doctype html><html><body><form action="/s">
  <input type="hidden" name="glow-validation-token" value="hNCcXIy2sgFF4XP2FHu2lcd7MbdOjzDra0r63mjm">
  <INPUT TYPE="HIDDEN" name="session-token" value="Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA">
  <label for="k">API key</label>
  <input id="k" name="api_key" type="text" value="sk-live-abcdef" data-test-rect="10,10,200,30">
</form></body></html>`;

describe('a hidden input is owed no pixel op, and nothing else is', () => {
  const result = redact(markUntrusted(PAGE), [], { pixelCoverAll: true });
  // Paths are recorded at scan time, before any edit, so resolve them against
  // an unedited parse of the same page.
  const doc = new DOMParser().parseFromString(PAGE, 'text/html');
  const nameOf = (id: string): string | null => {
    const det = result.detections.find((d) => String(d.id) === id);
    if (det === undefined || det.domPath === null) return null;
    return resolveDomPath(doc, det.domPath)?.getAttribute('name') ?? null;
  };

  it('lists every redacted hidden input, whatever the attribute case', () => {
    const names = result.unpaintable.map((id) => nameOf(String(id)));
    expect([...names].sort()).toEqual(['glow-validation-token', 'session-token']);
  });

  it('does not list a visible field, which gets a pixel op instead', () => {
    const visible = result.detections.find((d) => nameOf(String(d.id)) === 'api_key');
    expect(visible).toBeDefined();
    expect(result.unpaintable.map(String)).not.toContain(String(visible?.id));
    expect(result.pixelOps.map((o) => String(o.detectionId))).toContain(String(visible?.id));
  });
});
