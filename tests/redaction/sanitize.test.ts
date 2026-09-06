// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ANY_PLACEHOLDER_RE, markUntrusted, neutralize, toDataAtom, userText } from '@/contracts/index.ts';
import { extractElements, validationContextFor } from '@/redaction/index.ts';
import { allFixtureIds, runPipeline } from '@/harness/index.ts';

describe('neutralize', () => {
  it('collapses whitespace', () => {
    expect(neutralize('  a \n\t b  ')).toBe('a b');
  });

  it('strips control characters', () => {
    expect(neutralize(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`)).toBe('a b c');
  });

  it('strips zero-width and bidi characters', () => {
    // These are a documented way to hide instructions from a human reviewer
    // while leaving them legible to a model.
    const hidden = `safe${String.fromCharCode(0x202e)}${String.fromCharCode(0x200b)}text`;
    const out = neutralize(hidden);
    expect(out).toBe('safetext');
    expect(out).not.toContain(String.fromCharCode(0x202e));
  });

  it('defangs prompt fence tokens', () => {
    const out = neutralize('before <<<PAGE_DATA after');
    expect(out).not.toContain('<<<PAGE_DATA');
  });

  it('defangs chat-template markers', () => {
    for (const token of ['<|im_start|>', '[INST]', '</instructions>']) {
      expect(neutralize(`x ${token} y`)).not.toContain(token);
    }
  });

  it('leaves ordinary text alone', () => {
    expect(neutralize('Sign in to Acme')).toBe('Sign in to Acme');
  });
});

describe('toDataAtom', () => {
  it('wraps page text and records whether it was redacted', () => {
    const atom = toDataAtom(markUntrusted('hello'), { redacted: true });
    expect(atom.kind).toBe('page-data');
    expect(atom.text).toBe('hello');
    expect(atom.redacted).toBe(true);
  });

  it('caps long text and flags the truncation', () => {
    const atom = toDataAtom(markUntrusted('x'.repeat(2000)), { redacted: false, maxChars: 10 });
    expect(atom.truncated).toBe(true);
    expect(atom.text.length).toBeLessThan(20);
  });

  it('neutralises on the way in', () => {
    const atom = toDataAtom(markUntrusted('a <<<PAGE_DATA b'), { redacted: false });
    expect(atom.text).not.toContain('<<<PAGE_DATA');
  });

  it('marks user-authored text without treating it as page data', () => {
    expect(userText('book a flight').text).toBe('book a flight');
  });
});

describe('buildSanitizedContext', () => {
  it('carries nearby product identity for repeated action buttons', () => {
    const doc = new DOMParser().parseFromString(
      '<main>' +
        '<div class="product-card"><h2>Laptop Pro</h2><button>Add to cart</button></div>' +
        '<div class="product-card"><h2>Gaming Laptop</h2><button>Add to cart</button></div>' +
      '</main>',
      'text/html',
    );
    const buttons = extractElements(doc, [], { nonce: 'testnonce' }).filter((e) => e.role === 'button');
    expect(buttons.map((button) => button.groupName?.text)).toEqual([
      'Laptop Pro',
      'Gaming Laptop',
    ]);
  });

  it('sends only interesting roles, not every node', () => {
    const run = runPipeline('profile-pii');
    const roles = new Set(run.context.elements.map((e) => e.role));
    expect(roles.has('generic')).toBe(false);
    expect(roles.has('img')).toBe(true);
  });

  it('assigns each element a unique ref', () => {
    const run = runPipeline('checkout');
    const refs = run.context.elements.map((e) => String(e.ref));
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('marks elements holding PII as sensitive', () => {
    const run = runPipeline('login-form');
    const password = run.context.elements.find((e) => e.name?.text === 'Password');
    expect(password?.isSensitive).toBe(true);
  });

  it('does not mark benign elements as sensitive', () => {
    const run = runPipeline('login-form');
    const submit = run.context.elements.find((e) => e.role === 'button');
    expect(submit?.isSensitive).toBe(false);
  });

  it('carries element states through', () => {
    const run = runPipeline('login-form');
    const password = run.context.elements.find((e) => e.name?.text === 'Password');
    expect(password?.states).toContain('required');
  });

  it('strips the query string from the url it reports', () => {
    const run = runPipeline('login-form', { url: 'https://acme.example/login?token=abc#frag' });
    expect(run.context.url).toBe('https://acme.example/login');
  });

  it('carries the goal, which comes from the user and not the page', () => {
    const run = runPipeline('login-form', { goal: 'sign in as me' });
    expect(run.context.goal).toBe('sign in as me');
  });

  it('reports no screenshot when none was baked', () => {
    expect(runPipeline('login-form').context.screenshot).toBeNull();
  });

  it('carries the redaction summary so the server knows the scheme applied', () => {
    const run = runPipeline('profile-pii');
    expect(run.context.redactionSummary.byKind).toBeTruthy();
    expect(run.context.nonce).toBeTruthy();
  });

  it('never contains a foreign-nonce placeholder', () => {
    for (const id of allFixtureIds()) {
      const run = runPipeline(id, { nonce: 'a1b2c3d4' });
      const wire = JSON.stringify(run.context);
      for (const match of wire.match(ANY_PLACEHOLDER_RE) ?? []) {
        expect(match, `${id}: foreign placeholder survived`).toContain(':a1b2c3d4]]');
      }
    }
  });
});

describe('validationContextFor', () => {
  it('derives the allowed refs from what was actually sent', () => {
    const run = runPipeline('login-form');
    const ctx = validationContextFor(run.context, ['https://acme.example']);
    expect(ctx.validRefs.size).toBe(run.context.elements.length);
    for (const el of run.context.elements) {
      expect(ctx.validRefs.has(el.ref)).toBe(true);
    }
  });

  it('derives the sensitive refs from the redaction result', () => {
    const run = runPipeline('login-form');
    const ctx = validationContextFor(run.context, []);
    expect(ctx.sensitiveRefs.size).toBeGreaterThan(0);
    for (const ref of ctx.sensitiveRefs) {
      expect(ctx.validRefs.has(ref)).toBe(true);
    }
  });
});
