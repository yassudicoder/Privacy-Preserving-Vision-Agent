// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyFill, executeAction, fillAccepted } from '@/execution/index.ts';
import { elementRef, type Action } from '@/contracts/index.ts';

/**
 * `execute` used to report success without looking.
 *
 * It assigned `.value` and returned ok unconditionally, so typing "next Friday"
 * into an `input[type=date]` - which the HTML spec requires the browser to
 * sanitise to the empty string, synchronously, on assignment - was reported to
 * the agent, the panel and the privacy receipt as a completed step. The loop
 * then planned its next move believing a date had been entered.
 *
 * The taxonomy is adapted from ego-lite (citrolabs, MIT), `page-actions.ts`.
 */

function env(el: Element | null): Parameters<typeof executeAction>[1] {
  return {
    resolve: () => el,
    scrollBy: () => {},
    navigate: () => {},
  };
}

const typeAction = (text: string): Action => ({
  type: 'type',
  ref: elementRef('e1'),
  text,
  submit: false,
});

describe('classifyFill', () => {
  it('exact when the field kept what it was given', () => {
    expect(classifyFill('', 'hello', 'hello', 'text')).toBe('exact');
  });

  it('unchanged when the browser threw it away', () => {
    // The date case: assignment of an unparseable value yields ''.
    expect(classifyFill('', 'next Friday', '', 'date')).toBe('unchanged');
    expect(fillAccepted('unchanged')).toBe(false);
  });

  it('transformed is ACCEPTED - a field may reformat what it accepted', () => {
    /*
     * The distinction that makes the check usable. A field that upper-cases, or
     * inserts separators, DID accept the input; refusing those would fire on
     * exactly the inputs most likely to have a formatter attached.
     */
    expect(classifyFill('', 'ab12cd', 'AB12CD', 'text')).toBe('transformed');
    expect(fillAccepted('transformed')).toBe(true);
  });

  it('equivalent for a number field that renormalises', () => {
    expect(classifyFill('', '1.50', '1.5', 'number')).toBe('equivalent');
    expect(fillAccepted('equivalent')).toBe(true);
    // And NOT for a text field, where "1.50" and "1.5" are different strings.
    expect(classifyFill('', '1.50', '1.5', 'text')).toBe('transformed');
  });

  it('equivalent when a digits-only entry is formatted for the reader', () => {
    expect(classifyFill('', '4111111111111111', '4111 1111 1111 1111', 'text')).toBe('equivalent');
  });

  it('does NOT treat a mangled non-digit entry as equivalent', () => {
    // The digit rule applies only when what we asked for was digits ALONE, so
    // it cannot quietly accept a field that mangled real text.
    expect(classifyFill('', 'card 4111', '4111', 'text')).toBe('transformed');
  });

  it('appended is a FAILURE - we meant to replace', () => {
    expect(classifyFill('old', 'new', 'oldnew', 'text')).toBe('appended');
    expect(fillAccepted('appended')).toBe(false);
  });

  it('ignores carriage returns and zero-width characters', () => {
    expect(classifyFill('', 'a\r\nb', 'a\nb', 'text')).toBe('exact');
    expect(classifyFill('', 'ab', 'a​b', 'text')).toBe('exact');
  });

  it('clearing a field is exact, not unchanged', () => {
    expect(classifyFill('something', '', '', 'text')).toBe('exact');
  });
});

describe('executeAction reports what actually landed', () => {
  it('REFUSES the date input that silently discarded the text', () => {
    /*
     * The exact case CLAUDE.md recorded as a defect. jsdom implements the
     * sanitisation, so this is the real browser behaviour rather than a stub.
     */
    const el = document.createElement('input');
    el.type = 'date';
    document.body.append(el);

    const out = executeAction(typeAction('next Friday'), env(el));
    expect(el.value).toBe('');
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/did not accept/);
    // The note names the field's actual contents, so the panel can show why.
    expect(out.note).toContain('type=date');
  });

  it('accepts a valid date on the same input', () => {
    const el = document.createElement('input');
    el.type = 'date';
    document.body.append(el);
    const out = executeAction(typeAction('2026-09-11'), env(el));
    expect(out.ok).toBe(true);
    expect(el.value).toBe('2026-09-11');
  });

  it('accepts an ordinary text field', () => {
    const el = document.createElement('input');
    el.type = 'text';
    document.body.append(el);
    const out = executeAction(typeAction('iPhone 17'), env(el));
    expect(out.ok).toBe(true);
    expect(el.value).toBe('iPhone 17');
  });

  it('REFUSES a <select> given an option it does not have', () => {
    /*
     * OUR addition rather than ego-lite's. A select's value comes from a closed
     * set - assigning an absent option yields '' - which reads as `transformed`
     * and the taxonomy accepts that. Accepting it here would report "selected"
     * for an option the page never offered.
     */
    const el = document.createElement('select');
    for (const v of ['india', 'nepal']) {
      const o = document.createElement('option');
      o.value = v;
      el.append(o);
    }
    el.value = 'india';
    document.body.append(el);

    const out = executeAction(typeAction('atlantis'), env(el));
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/not one of its options/);
  });

  it('accepts a <select> given a real option', () => {
    const el = document.createElement('select');
    for (const v of ['india', 'nepal']) {
      const o = document.createElement('option');
      o.value = v;
      el.append(o);
    }
    document.body.append(el);
    const out = executeAction(typeAction('nepal'), env(el));
    expect(out.ok).toBe(true);
    expect(el.value).toBe('nepal');
  });

  it('respects maxlength by reporting the truncation as accepted', () => {
    // Truncation IS a transformation the field applied to input it took, so it
    // is a success - but the note and the next snapshot both carry the real
    // value, so the agent is not misled about what is in the box.
    const el = document.createElement('input');
    el.type = 'text';
    el.setAttribute('maxlength', '4');
    document.body.append(el);
    const out = executeAction(typeAction('abcdefgh'), env(el));
    expect(out.ok).toBe(true);
  });
});
