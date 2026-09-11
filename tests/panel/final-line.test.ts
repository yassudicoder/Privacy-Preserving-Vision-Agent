import { describe, expect, it } from 'vitest';
import { finalAgentLine } from '@/panel/index.ts';

/**
 * The transcript's last line. On a page of data the model's `done.summary` IS
 * the answer, and the panel used to discard it for a fixed "Done." - or, since
 * a question is answered without touching the page, for "I did not need to do
 * anything".
 */
describe('finalAgentLine', () => {
  it("shows the model's answer when a run ends in done with a summary", () => {
    const answer = 'Altitude is rising (CALCULATED slope 38.1/row, r2 0.99).';
    expect(finalAgentLine({ type: 'done', summary: answer }, 0)).toBe(answer);
    expect(finalAgentLine({ type: 'done', summary: answer }, 3)).toBe(answer);
  });

  it('does NOT say "I did not need to do anything" over an answer', () => {
    expect(finalAgentLine({ type: 'done', summary: 'Two anomalies.' }, 0)).not.toMatch(/did not need/);
  });

  it('keeps the fixed lines when there is no summary to show', () => {
    expect(finalAgentLine({ type: 'done', summary: '   ' }, 0)).toMatch(/did not need to do anything/);
    expect(finalAgentLine({ type: 'done', summary: '' }, 2)).toBe('Done.');
    expect(finalAgentLine(null, 1)).toBe('Done.');
  });

  it('never presents a non-done action as an answer', () => {
    expect(finalAgentLine({ type: 'click' }, 1)).toBe('Done.');
  });
});
