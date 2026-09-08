// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  markUntrusted,
  redactionNonce,
  summariseAnalysis,
  type AnalysisShape,
} from '@/contracts/index.ts';
import { analyzeDocument } from '@/analysis/index.ts';
import { redact } from '@/redaction/index.ts';
import { receiptAnalysisLines } from '@/panel/index.ts';
import { emptyReceipt } from '@/contracts/index.ts';

/**
 * What the model is told, and what the user is shown.
 *
 * The engine and its egress gate are covered by `privacy.test.ts`. This file
 * covers the two things that happen AFTER the numbers exist, because both are
 * places where a correct computation can still produce a dishonest output:
 *
 *   1. The PROMPT. The model must be able to tell an observation from a
 *      calculation from a prediction, and must never see a cell value.
 *   2. The RECEIPT. "0 raw records transmitted" is true of a step that analysed
 *      100,000 rows and equally true of a step that did nothing at all. If the
 *      panel cannot tell those apart it is reassurance, not evidence.
 */

const NONCE = redactionNonce('a1b2c3d4');

function redactedDoc(html: string): Document {
  return redact(markUntrusted(html), [], {
    viewport: { cssWidth: 900, cssHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'test-salt',
    nonce: NONCE,
    minConfidence: 0.5,
    frameId: 'f1',
    url: 'https://synthetic.invalid/data',
    now: 1_700_000_000_000,
  }).doc;
}

/** A telemetry-shaped page: a rising numeric column and a column of real PII. */
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

// --- the receipt -------------------------------------------------------------

describe('the receipt distinguishes four different outcomes', () => {
  it('says "Nothing analyzed yet" when no analysis ran', () => {
    /*
     * The failure this prevents: a panel that prints "0 raw records
     * transmitted" for a step that never reached the analysis stage. True, and
     * evidence of nothing.
     */
    const summary = summariseAnalysis(null);
    expect(summary.state).toBe('not-run');

    const lines = receiptAnalysisLines({ ...emptyReceipt(1), analysis: summary });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.value).toBe('Nothing analyzed yet');
    expect(lines[0]?.tone).toBe('idle');
  });

  it('reports a wholly-redacted table as BLOCKED, with the count as evidence', () => {
    /*
     * `all-columns-redacted` means the redactor removed every column. That is
     * the privacy pipeline working, and it must not be rendered as "no data" -
     * the two look identical in a count and mean opposite things.
     */
    const doc = redactedDoc(
      `<!doctype html><html><body><table><thead><tr><th>who</th><th>mail</th></tr></thead><tbody>${Array.from(
        { length: 8 },
        (_, i) => `<tr><td>u${String(i)}@example.invalid</td><td>v${String(i)}@example.invalid</td></tr>`,
      ).join('')}</tbody></table></body></html>`,
    );
    const summary = summariseAnalysis(analyzeDocument(doc));
    expect(summary.state).toBe('blocked');
    expect(summary.reason).toBe('all-columns-redacted');

    const lines = receiptAnalysisLines({ ...emptyReceipt(1), analysis: summary });
    expect(lines[0]?.value).toContain('Analysis blocked');
    // The number behind the claim. "Blocked" alone is indistinguishable from a
    // crash, and a reader has no way to tell which happened.
    expect(lines[1]?.value).toContain('column(s)');
    expect(summary.piiCellsExcluded).toBeGreaterThan(0);
  });

  it('counts rows, excluded PII and transmitted metrics off the real payload', () => {
    const analysis = analyzeDocument(redactedDoc(telemetryPage(60)));
    const summary = summariseAnalysis(analysis);

    expect(summary.state).toBe('analysed');
    expect(summary.rowsAnalyzed).toBe(60);
    // One PII cell per row, all excluded before any arithmetic ran.
    expect(summary.piiCellsExcluded).toBe(60);
    expect(summary.columnsRedacted).toBe(1);
    expect(summary.rawRecordsTransmitted).toBe(0);
    expect(summary.metricsTransmitted).toBeGreaterThan(10);

    const lines = receiptAnalysisLines({ ...emptyReceipt(1), analysis: summary });
    expect(lines.map((l) => l.label)).toEqual([
      'Analyzed locally',
      'PII excluded',
      'Raw records sent',
      'Metrics sent',
    ]);
    expect(lines[2]?.value).toBe('0');
    expect(lines[2]?.tone).toBe('ok');
  });

  it('marks a raw row array as BAD rather than counting its cells as metrics', () => {
    /*
     * `AnalysisShape` has no field that can hold a row, so this cannot arise
     * from the engine. It is asserted anyway because the receipt's job is to
     * report the failure of that structural claim, and a counter that silently
     * folded rows into `metricsTransmitted` would report a leak as a feature.
     */
    const smuggled = {
      ...analyzeDocument(redactedDoc(telemetryPage(20))),
      leakedRows: [['Yash', '5000'], ['Ada', '6000']],
    } as unknown as AnalysisShape;

    const summary = summariseAnalysis(smuggled);
    expect(summary.rawRecordsTransmitted).toBe(2);

    const lines = receiptAnalysisLines({ ...emptyReceipt(1), analysis: summary });
    const raw = lines.find((l) => l.label === 'Raw records sent');
    expect(raw?.value).toBe('2');
    expect(raw?.tone).toBe('bad');
  });

  it('never presents a truncated read as a complete one', () => {
    const analysis = analyzeDocument(redactedDoc(telemetryPage(400)), {
      limits: {
        maxCells: 90,
        maxRows: 100_000,
        maxColumns: 64,
        timeoutMs: 2_000,
        minPointsForTrend: 3,
      },
    });
    const summary = summariseAnalysis(analysis);
    expect(summary.truncated).toBe(true);
    expect(summary.rowsAnalyzed).toBeLessThan(400);

    const lines = receiptAnalysisLines({ ...emptyReceipt(1), analysis: summary });
    expect(lines[0]?.value).toContain('PARTIAL');
  });
});
