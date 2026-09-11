import { describe, expect, it } from 'vitest';
import { isQuestionGoal } from '@/agent-server/prompt.ts';

/**
 * Whether a goal is a QUESTION about the page, which decides whether the prompt
 * gains the QUESTION block telling the model to answer in `done.summary`.
 *
 * Measured before this existed: on the ISRO telemetry page the local model
 * answered none of the six suggested questions - four times it clicked the chart
 * button named after the goal's noun, twice it asked the user a clarifying
 * question - because nothing said a question is answered rather than acted on.
 */
describe('isQuestionGoal', () => {
  it('recognises every question the ISRO demo page suggests', () => {
    for (const q of [
      'What is the altitude trend?',
      'What will the next altitude reading be?',
      'Are there any temperature anomalies?',
      'Which telemetry channels are correlated?',
      'When is the fuel expected to run out?',
      'How much of this data contains personal information?',
    ]) {
      expect(isQuestionGoal(q), q).toBe(true);
    }
  });

  it('treats a question mark or a question word as a question', () => {
    expect(isQuestionGoal('What is in my cart?')).toBe(true);
    expect(isQuestionGoal('is the fuel falling')).toBe(true);
  });

  it('never treats a request as a question, even when phrased as one', () => {
    // An action verb means the user wants something DONE; answering in prose
    // instead of acting would be the opposite failure.
    expect(isQuestionGoal('Can you open my profile?')).toBe(false);
    expect(isQuestionGoal('Could you add laptop pro to the cart?')).toBe(false);
    expect(isQuestionGoal('How do I log in?')).toBe(false);
  });

  it('leaves ordinary task goals alone', () => {
    expect(isQuestionGoal('search for laptop')).toBe(false);
    expect(isQuestionGoal('add laptop pro to cart')).toBe(false);
    expect(isQuestionGoal('Go to the profile')).toBe(false);
    expect(isQuestionGoal('')).toBe(false);
    expect(isQuestionGoal('   ')).toBe(false);
  });

  it('matches whole words, so a noun containing a verb is not a verb', () => {
    // `\b` boundaries: "address" contains "add", "opening" is not "open" by itself
    // - a regex without boundaries would misclassify both.
    expect(isQuestionGoal('What is the delivery address?')).toBe(true);
    expect(isQuestionGoal('What are the opening hours?')).toBe(true);
  });
});
