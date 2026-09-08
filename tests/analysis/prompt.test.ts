// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FENCE_CLOSE, FENCE_OPEN, renderPrompt } from '@/agent-server/index.ts';
import { runPipeline } from '@/harness/index.ts';
import { analyzeDocument } from '@/analysis/index.ts';
import { redact } from '@/redaction/index.ts';
import { markUntrusted, redactionNonce, type SanitizedContext } from '@/contracts/index.ts';

/**
 * What the analysis block looks like by the time the model reads it.
 *
 * Three separate claims, and the third is the one that is easy to get wrong.
 *
 *   1. It is INSIDE the data fence. These numbers are derived from page content
 *      and a derivation does not launder provenance.
 *   2. It is AFTER the element list, because this codebase has measured twice
 *      that a small model acts on what it reads last.
 *   3. Every line says WHERE ITS NUMBER CAME FROM. A model handed a mean, a
 *      slope and a forecast in one undifferentiated list presents all three with
 *      the same confidence - and one of them is an extrapolation.
 */

const NONCE = redactionNonce('a1b2c3d4');

function telemetryPage(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_, i) =>
      `<tr><td>${String(i)}</td><td>${String(1000 + i * 13)}</td>` +
      `<td>op${String(i)}@example.invalid</td></tr>`,
  ).join('');
  return `<!doctype html><html><body><table>
    <thead><tr><th>sample</th><th>altitude</th><th>contact</th></tr></thead>
    <tbody>${body}</tbody></table></body></html>`;
}

/** A real context from a real fixture, with a real analysis attached. */
function contextWithAnalysis(rows: number): SanitizedContext {
  const doc = redact(markUntrusted(telemetryPage(rows)), [], {
    viewport: { cssWidth: 900, cssHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'test-salt',
    nonce: NONCE,
    minConfidence: 0.5,
    frameId: 'f1',
    url: 'https://synthetic.invalid/data',
    now: 1_700_000_000_000,
  }).doc;
  const base = runPipeline('login-form', { goal: 'what is the altitude trend?' }).context;
  return { ...base, analysis: analyzeDocument(doc) } as SanitizedContext;
}

describe('the analysis block in the prompt', () => {
  it('renders inside the fence and after the element list', () => {
    const prompt = renderPrompt(contextWithAnalysis(60));
    const open = prompt.indexOf(FENCE_OPEN);
    const close = prompt.indexOf(FENCE_CLOSE);
    const block = prompt.indexOf('ANALYSIS - computed on the client');
    const elements = prompt.indexOf('ELEMENTS');

    expect(block).toBeGreaterThan(open);
    expect(block).toBeLessThan(close);
    expect(block).toBeGreaterThan(elements);
  });

  it('labels every figure with its provenance', () => {
    const prompt = renderPrompt(contextWithAnalysis(60));
    expect(prompt).toContain('OBSERVED');
    expect(prompt).toContain('CALCULATED');
    expect(prompt).toContain('PREDICTED');
    // And the rule that tells the model the three are not interchangeable.
    expect(prompt).toMatch(/PREDICTED = an extrapolation with an interval, not a fact/);
    expect(prompt).toMatch(/raw table was NEVER sent to you/);
  });

  it('names the redacted column instead of silently omitting it', () => {
    /*
     * A column the redactor emptied has to appear as REDACTED. Omitted, the
     * model sees a table with one fewer column and has no way to know a quantity
     * existed - so "I do not have that" stops being an available answer and a
     * guess assembled from the surviving columns takes its place.
     */
    const prompt = renderPrompt(contextWithAnalysis(60));
    expect(prompt).toMatch(/OBSERVED contact: REDACTED, 60 personal values excluded/);
  });

  it('contains no cell value from the table', () => {
    /*
     * THE ASSERTION THAT MATTERS, made against the exact string that would be
     * transmitted rather than against the object that produced it.
     *
     * `1039` is row 3's altitude and `op7@example.invalid` is row 7's contact.
     * Neither may appear anywhere in the prompt - not in a statistic, not in an
     * outlier, not in an example row.
     */
    const prompt = renderPrompt(contextWithAnalysis(60));
    expect(prompt).not.toContain('op7@example.invalid');
    expect(prompt).not.toContain('example.invalid');
    expect(prompt).not.toContain('1039');
  });

  it('renders nothing at all when there is no analysis', () => {
    // The field is nullable and the common case on a normal web page is null.
    // A heading with no rows under it would spend tokens to say nothing.
    const prompt = renderPrompt(runPipeline('login-form').context);
    expect(prompt).not.toContain('ANALYSIS - computed on the client');
  });

  it('states the reason when the engine refused, rather than going quiet', () => {
    const doc = redact(
      markUntrusted(
        `<!doctype html><html><body><table><thead><tr><th>who</th></tr></thead><tbody>${Array.from(
          { length: 8 },
          (_, i) => `<tr><td>u${String(i)}@example.invalid</td></tr>`,
        ).join('')}</tbody></table></body></html>`,
      ),
      [],
      {
        viewport: { cssWidth: 900, cssHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
        salt: 'test-salt',
        nonce: NONCE,
        minConfidence: 0.5,
        frameId: 'f1',
        url: 'https://synthetic.invalid/data',
        now: 0,
      },
    ).doc;
    const base = runPipeline('login-form').context;
    const prompt = renderPrompt({ ...base, analysis: analyzeDocument(doc) } as SanitizedContext);

    // Not "no analysis available" - the specific fact, which is the only thing
    // that lets the model decline instead of improvising.
    expect(prompt).toContain('every column was personal data and was removed before analysis');
  });

  it('marks a truncated read as PARTIAL', () => {
    const doc = redact(markUntrusted(telemetryPage(400)), [], {
      viewport: { cssWidth: 900, cssHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      salt: 's',
      nonce: NONCE,
      minConfidence: 0.5,
      frameId: 'f',
      url: 'https://x.invalid/',
      now: 0,
    }).doc;
    const analysis = analyzeDocument(doc, {
      limits: {
        maxCells: 90,
        maxRows: 100_000,
        maxColumns: 64,
        timeoutMs: 2_000,
        minPointsForTrend: 3,
      },
    });
    const base = runPipeline('login-form').context;
    const prompt = renderPrompt({ ...base, analysis } as SanitizedContext);
    expect(prompt).toContain('PARTIAL');
    expect(prompt).toContain('cell ceiling');
  });
});
