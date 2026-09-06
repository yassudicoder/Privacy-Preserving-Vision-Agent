// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { type Action, elementRef } from '@/contracts/index.ts';
import { type ExecutionEnv, executeAction } from '@/execution/index.ts';

/**
 * The last step of the loop: doing the thing the model asked for.
 *
 * Everything here runs in the content script, which is the only context that
 * touches the page - and the one place where getting it wrong types a password
 * into the wrong field. So the DOM effects live in this module, where jsdom can
 * drive them, rather than in the entrypoint where nothing can.
 *
 * The resolver is injected. This module deliberately does not know how an
 * ElementRef maps to an element; it knows what to do once it has one, and what
 * to do when it does not.
 */

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

/** Resolves refs against a fixed list, mimicking the snapshot-time map. */
function refsFor(...els: (Element | null)[]): (ref: string) => Element | null {
  return (ref) => {
    const i = Number(ref.replace(/^e/, ''));
    return els[i - 1] ?? null;
  };
}

function env(over: Partial<ExecutionEnv> = {}): ExecutionEnv {
  return {
    resolve: () => null,
    scrollBy: vi.fn(),
    navigate: vi.fn(),
    ...over,
  };
}

describe('click', () => {
  it('clicks the resolved element', () => {
    const doc = page('<button id="b">Pay</button>');
    const button = doc.getElementById('b');
    const clicked = vi.fn();
    button?.addEventListener('click', clicked);

    const out = executeAction({ type: 'click', ref: elementRef('e1') }, env({ resolve: refsFor(button) }));

    expect(out.ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('reports failure rather than throwing when the ref resolves to nothing', () => {
    // A stale ref is normal - the page may have changed since the snapshot.
    // Throwing would abort the loop; a false ok would hide a real miss.
    const out = executeAction({ type: 'click', ref: elementRef('e9') }, env());
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/e9/);
  });
});

describe('type', () => {
  it('sets the value and fires input and change', () => {
    // Frameworks listen for these. Assigning .value alone updates the DOM and
    // leaves React/Vue state stale, which looks like the typing "did nothing".
    const doc = page('<input id="i">');
    const input = doc.getElementById('i') as HTMLInputElement | null;
    const events: string[] = [];
    input?.addEventListener('input', () => events.push('input'));
    input?.addEventListener('change', () => events.push('change'));

    const out = executeAction(
      { type: 'type', ref: elementRef('e1'), text: 'hello', submit: false },
      env({ resolve: refsFor(input) }),
    );

    expect(out.ok).toBe(true);
    expect(input?.value).toBe('hello');
    expect(events).toEqual(['input', 'change']);
  });

  it('writes into a textarea through its text content, not an attribute', () => {
    // setAttribute('value') is a no-op on a textarea. This exact bug already
    // leaked PII past redaction once; it must not come back on the write path.
    const doc = page('<textarea id="t"></textarea>');
    const ta = doc.getElementById('t') as HTMLTextAreaElement | null;

    executeAction(
      { type: 'type', ref: elementRef('e1'), text: 'note', submit: false },
      env({ resolve: refsFor(ta) }),
    );

    expect(ta?.value).toBe('note');
  });

  it('submits the owning form when asked', () => {
    const doc = page('<form id="f"><input id="i"></form>');
    const input = doc.getElementById('i');
    const form = doc.getElementById('f') as HTMLFormElement | null;
    const submitted = vi.fn((e: Event) => {
      e.preventDefault();
    });
    form?.addEventListener('submit', submitted);

    executeAction(
      { type: 'type', ref: elementRef('e1'), text: 'x', submit: true },
      env({ resolve: refsFor(input) }),
    );

    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('does not submit when submit is false', () => {
    const doc = page('<form id="f"><input id="i"></form>');
    const submitted = vi.fn();
    doc.getElementById('f')?.addEventListener('submit', submitted);

    executeAction(
      { type: 'type', ref: elementRef('e1'), text: 'x', submit: false },
      env({ resolve: refsFor(doc.getElementById('i')) }),
    );

    expect(submitted).not.toHaveBeenCalled();
  });

  it('refuses to type into an element that holds no value', () => {
    const doc = page('<div id="d"></div>');
    const out = executeAction(
      { type: 'type', ref: elementRef('e1'), text: 'x', submit: false },
      env({ resolve: refsFor(doc.getElementById('d')) }),
    );
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/value/i);
  });
});

describe('select', () => {
  it('picks a matching option and fires change', () => {
    const doc = page('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
    const sel = doc.getElementById('s') as HTMLSelectElement | null;
    const changed = vi.fn();
    sel?.addEventListener('change', changed);

    const out = executeAction(
      { type: 'select', ref: elementRef('e1'), option: 'b' },
      env({ resolve: refsFor(sel) }),
    );

    expect(out.ok).toBe(true);
    expect(sel?.value).toBe('b');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('matches on visible label when the value does not match', () => {
    const doc = page('<select id="s"><option value="1">United Kingdom</option></select>');
    const sel = doc.getElementById('s') as HTMLSelectElement | null;
    const out = executeAction(
      { type: 'select', ref: elementRef('e1'), option: 'United Kingdom' },
      env({ resolve: refsFor(sel) }),
    );
    expect(out.ok).toBe(true);
    expect(sel?.value).toBe('1');
  });

  it('reports failure when no option matches instead of selecting the first', () => {
    // Silently picking something is worse than doing nothing: the loop would
    // proceed believing a choice it never made.
    const doc = page('<select id="s"><option value="a">A</option></select>');
    const sel = doc.getElementById('s') as HTMLSelectElement | null;
    const out = executeAction(
      { type: 'select', ref: elementRef('e1'), option: 'zzz' },
      env({ resolve: refsFor(sel) }),
    );
    expect(out.ok).toBe(false);
    expect(sel?.value).toBe('a');
  });
});

describe('scroll and key', () => {
  it('scrolls in the requested direction by the requested amount', () => {
    const scrollBy = vi.fn();
    const out = executeAction({ type: 'scroll', direction: 'down', amountPx: 300 }, env({ scrollBy }));
    expect(out.ok).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(0, 300);
  });

  it('maps every direction to the right axis and sign', () => {
    const scrollBy = vi.fn();
    const e = env({ scrollBy });
    executeAction({ type: 'scroll', direction: 'up', amountPx: 100 }, e);
    executeAction({ type: 'scroll', direction: 'left', amountPx: 50 }, e);
    executeAction({ type: 'scroll', direction: 'right', amountPx: 25 }, e);
    expect(scrollBy.mock.calls).toEqual([
      [0, -100],
      [-50, 0],
      [25, 0],
    ]);
  });

  it('dispatches a key to the focused element', () => {
    const doc = page('<input id="i">');
    const input = doc.getElementById('i') as HTMLInputElement | null;
    input?.focus();
    const keys: string[] = [];
    input?.addEventListener('keydown', (e) => keys.push((e as KeyboardEvent).key));

    const out = executeAction({ type: 'key', key: 'Enter' }, env());
    expect(out.ok).toBe(true);
    expect(keys).toEqual(['Enter']);
  });
});

describe('navigate', () => {
  it('delegates navigation rather than touching location directly', () => {
    // Injected so it is testable, and so the one call that leaves the page has
    // exactly one call site.
    const navigate = vi.fn();
    const out = executeAction({ type: 'navigate', url: 'https://shop.example/cart' }, env({ navigate }));
    expect(out.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith('https://shop.example/cart');
  });
});

describe('actions with no page effect', () => {
  it.each([
    [{ type: 'wait', ms: 500 }, /wait/i],
    [{ type: 'done', summary: 'finished' }, /done/i],
    [{ type: 'ask_user', question: 'which card?' }, /ask_user|user/i],
    [{ type: 'abort', reason: 'stuck' }, /abort/i],
  ] as [Action, RegExp][])('reports %o as handled elsewhere', (action, note) => {
    // These are decisions for the orchestrator, not DOM operations. They must
    // succeed here without touching the page - returning false would make the
    // loop treat a normal "done" as a failure.
    const scrollBy = vi.fn();
    const navigate = vi.fn();
    const out = executeAction(action, env({ scrollBy, navigate }));
    expect(out.ok).toBe(true);
    expect(out.note).toMatch(note);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
