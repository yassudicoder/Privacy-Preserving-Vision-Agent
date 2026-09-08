// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYSIS_LIMITS,
  inspectAnalysis,
  inspectOutboundContext,
  markUntrusted,
  redactionNonce,
} from '@/contracts/index.ts';
import { analyzeDocument, parseNumber, readTable, chooseTable } from '@/analysis/index.ts';
import { redact } from '@/redaction/index.ts';

/**
 * The privacy claim of the analysis layer, asserted rather than described.
 *
 * The claim is: a table is read AFTER redaction, computed on this device, and
 * only numbers leave. Three things have to be true for that to hold, and each
 * has its own section below:
 *
 *   1. A redacted cell is EXCLUDED AND COUNTED, never parsed. A placeholder
 *      returns NaN from parseFloat, and an unguarded mean over a column
 *      containing one is either NaN or - far worse - silently computed over the
 *      rows that happened to survive, and reported as if it covered the column.
 *   2. No cell value can reach the outbound payload, because the TYPE has no
 *      field that could hold one and the egress gate refuses any string that is
 *      not a column label.
 *   3. The gate fails CLOSED: an analysis that cannot be proven safe is
 *      rejected whole, not stripped and forwarded.
 */

const NONCE = redactionNonce('a1b2c3d4');

/** Builds a page, runs the REAL redactor over it, returns the redacted Document. */
function redactedDoc(html: string): Document {
  const result = redact(markUntrusted(html), [], {
    viewport: { cssWidth: 900, cssHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    salt: 'test-salt',
    nonce: NONCE,
    minConfidence: 0.5,
    frameId: 'f1',
    url: 'https://synthetic.invalid/data',
    now: 1_700_000_000_000,
  });
  return result.doc;
}

function tablePage(rows: string): string {
  return `<!doctype html><html><body><table>
    <thead><tr><th>reading</th><th>owner</th></tr></thead>
    <tbody>${rows}</tbody></table></body></html>`;
}

// --- 1. the redaction/NaN trap ----------------------------------------------

describe('a redacted cell is excluded and counted, never parsed', () => {
  it('averages 1000, 2000, [redacted], 3000 to 2000 - not NaN', () => {
    /*
     * THE CASE THIS WHOLE FILE EXISTS FOR, spelled out because it is the one
     * that silently produces a wrong number rather than an error.
     *
     * The email is real-shaped so the REAL redactor substitutes it; nothing here
     * hand-writes a placeholder. By the time the engine reads the column the
     * cell says `[[PII:EMAIL:1:a1b2c3d4]]`, and `Number.parseFloat` of that is
     * NaN.
     */
    const doc = redactedDoc(
      tablePage(
        ['1000', '2000', 'ada@example.com', '3000']
          .map((v) => `<tr><td>${v}</td><td>x</td></tr>`)
          .join(''),
      ),
    );

    const chosen = chooseTable(doc);
    expect(chosen).not.toBeNull();
    const read = readTable(chosen!.table, DEFAULT_ANALYSIS_LIMITS);
    const col = read.columns[0];

    expect(col?.values).toEqual([1000, 2000, 3000]);
    expect(col?.nRedacted).toBe(1);
    // The mean is over the three that survived, and the count says so.
    const values = col?.values ?? [];
    expect(values.reduce((a, b) => a + b, 0) / values.length).toBe(2000);
    expect(Number.isNaN(values.reduce((a, b) => a + b, 0))).toBe(false);
  });

  it('reports a wholly-PII column as `redacted`, not as `unknown`', () => {
    /*
     * "The redactor removed all of it" and "there was nothing here" are
     * different facts, and only the first is evidence the privacy pipeline
     * worked. A kind that folded them together would make the claim
     * unverifiable from the output.
     */
    const doc = redactedDoc(
      tablePage(
        ['ada@example.com', 'bob@example.com', 'cid@example.com', 'dee@example.com']
          .map((v) => `<tr><td>1</td><td>${v}</td></tr>`)
          .join(''),
      ),
    );
    const chosen = chooseTable(doc);
    const read = readTable(chosen!.table, DEFAULT_ANALYSIS_LIMITS);
    expect(read.columns[1]?.kind).toBe('redacted');
    expect(read.columns[1]?.nRedacted).toBe(4);
  });

  it('refuses with all-columns-redacted rather than reporting an empty analysis', () => {
    const doc = redactedDoc(
      tablePage(
        Array.from({ length: 6 }, (_, i) => `<tr><td>u${String(i)}@example.com</td><td>x</td></tr>`).join(''),
      ),
    );
    const a = analyzeDocument(doc);
    expect(a.refusal).toBe('all-columns-redacted');
    expect(a.rowsAnalyzed).toBe(0);
  });
});

// --- 2. no cell value can leave ---------------------------------------------

describe('no cell value can reach the payload', () => {
  it('a real analysis contains none of the table values as strings', () => {
    const doc = redactedDoc(
      tablePage(
        Array.from(
          { length: 30 },
          (_, i) => `<tr><td>${String(1000 + i * 37)}</td><td>label${String(i)}</td></tr>`,
        ).join(''),
      ),
    );
    const a = analyzeDocument(doc);
    expect(a.rowsAnalyzed).toBe(30);

    /*
     * The decisive check. Every STRING anywhere in the serialised analysis must
     * be a column label, an enum, or a key. A cell value appearing as text would
     * be the exfiltration channel the type is designed to make impossible.
     */
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk(a);

    const allowed = new Set([
      'page-data', 'reading', 'owner', 'numeric', 'categorical', 'redacted', 'unknown',
      'temporal', 'rising', 'falling', 'flat', 'high', 'low', 'medium', 'none', 'weak',
      'moderate', 'strong', 'accelerating', 'steady', 'decelerating',
      'linear-least-squares', 'last-value', 'moving-average',
    ]);
    for (const s of strings) expect(allowed.has(s), `unexpected string in analysis: ${s}`).toBe(true);

    // And specifically: not one of the 30 values, and not a row label.
    const json = JSON.stringify(a);
    expect(json).not.toContain('1037');
    expect(json).not.toContain('label7');
  });

  it('outliers carry a POSITION and a z-score, never the value', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      `<tr><td>${i === 17 ? '999999' : String(50 + (i % 3))}</td><td>x</td></tr>`,
    ).join('');
    const a = analyzeDocument(redactedDoc(tablePage(rows)));
    expect(a.outliers.length).toBeGreaterThan(0);
    const o = a.outliers[0];
    expect(typeof o?.rowIndex).toBe('number');
    expect(typeof o?.z).toBe('number');
    expect(JSON.stringify(a.outliers)).not.toContain('999999');
  });
});

// --- 3. the gate fails closed ------------------------------------------------

describe('the egress gate refuses anything it cannot prove safe', () => {
  it('rejects a field the engine does not emit', () => {
    const v = inspectAnalysis({ schemaVersion: 1, rows: [['a', 'b']] });
    expect(v.some((x) => x.code === 'unexpected-field')).toBe(true);
  });

  it('rejects a raw row array smuggled into an allowed field', () => {
    // `columns` is allowed, so the array itself passes - but each entry is
    // checked, and a bare string is not an object.
    const v = inspectAnalysis({ schemaVersion: 1, columns: [['secret', 'row']] });
    expect(v.length).toBeGreaterThan(0);
  });

  it('rejects an arbitrary string where a statistic belongs', () => {
    /*
     * The generic walk, not a hand-written field list. A statistic added later
     * is covered without this gate being updated - the failure worth defending
     * against is a NEW field carrying text, and a hand-written list would not
     * see it.
     */
    const v = inspectAnalysis({
      schemaVersion: 1,
      trends: [{ columnIndex: 0, slope: 1, note: 'the max row was Yash, 5000' }],
    });
    expect(v.some((x) => x.code === 'unquoted-page-text')).toBe(true);
  });

  it('rejects a column label that is not a DataAtom', () => {
    // A bare string means it never went through toDataAtom, so it was never
    // neutralised, fence-defanged or length-capped.
    const v = inspectAnalysis({ schemaVersion: 1, columns: [{ index: 0, label: 'raw header' }] });
    expect(v.some((x) => x.code === 'unquoted-page-text')).toBe(true);
  });

  it('accepts a REFUSAL that carries its evidence', () => {
    /*
     * The refusal path grew a `columns` array so the receipt could prove that
     * "Analysis blocked" meant the redactor removed everything rather than that
     * the engine crashed. That array carries `DataAtom` headers and counts
     * straight to the wire, so it has to clear the same gate a successful
     * analysis does - a refusal is not a lower-scrutiny payload.
     */
    const doc = redactedDoc(
      tablePage(
        Array.from({ length: 6 }, (_, i) => `<tr><td>u${String(i)}@example.com</td><td>x</td></tr>`).join(''),
      ),
    );
    const a = analyzeDocument(doc);
    expect(a.refusal).toBe('all-columns-redacted');
    expect(a.columns.length).toBeGreaterThan(0);
    expect(a.columns.some((c) => c.nRedacted > 0)).toBe(true);
    expect(inspectAnalysis(a)).toEqual([]);

    // And it still carries no cell value.
    const wire = JSON.stringify(a);
    expect(wire).not.toContain('@example.com');
    expect(wire).not.toContain('u3');
  });

  it('accepts a real analysis untouched', () => {
    const doc = redactedDoc(
      tablePage(
        Array.from({ length: 20 }, (_, i) => `<tr><td>${String(i * 3)}</td><td>y</td></tr>`).join(''),
      ),
    );
    expect(inspectAnalysis(analyzeDocument(doc))).toEqual([]);
  });

  it('is reached by the whole-context gate, so analysis cannot bypass it', () => {
    /*
     * The field is only safe if `inspectOutboundContext` actually calls the
     * analysis inspector. Asserted through the TOP-LEVEL entry point rather
     * than by calling `inspectAnalysis` directly - a gate that is correct but
     * unwired is the failure mode this codebase keeps finding.
     */
    const v = inspectOutboundContext({
      schemaVersion: 1,
      taskId: 't', step: 1, goal: 'g', url: 'u',
      title: { kind: 'page-data', text: 't', redacted: false, truncated: false },
      viewport: {}, elements: [], screenshot: null, redactionSummary: {},
      nonce: 'a1b2c3d4', history: [], clarifications: [], budget: {},
      analysis: { schemaVersion: 1, leakedRows: [['Yash', '5000']] },
    });
    expect(v.some((x) => x.detail.includes('leakedRows'))).toBe(true);
  });
});

// --- number parsing ----------------------------------------------------------

describe('parseNumber handles what a real data table contains', () => {
  it('reads separators, currency and percentages', () => {
    expect(parseNumber('1,234.50')).toBe(1234.5);
    expect(parseNumber('₹1,234.50')).toBe(1234.5);
    expect(parseNumber('$99')).toBe(99);
    expect(parseNumber('12.5%')).toBe(12.5);
    expect(parseNumber('(1,234)')).toBe(-1234);
    expect(parseNumber('-4.25')).toBe(-4.25);
  });

  it('returns null rather than guessing', () => {
    // Ambiguity is COUNTED as missing, which is visible, rather than guessed
    // at, which is not.
    for (const bad of ['', '  ', 'N/A', 'twelve', '1.2.3', '[[PII:EMAIL:1:abcd]]']) {
      expect(parseNumber(bad), bad).toBeNull();
    }
  });
});
