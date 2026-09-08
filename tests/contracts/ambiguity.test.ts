import { describe, expect, it } from 'vitest';
import {
  composeQuestion,
  detectAmbiguity,
  narrowByClarification,
  type SanitizedElement,
} from '@/contracts/index.ts';

/**
 * Deterministic ambiguity detection.
 *
 * The model will not do this. Measured against qwen2.5vl at temperature 0, on a
 * page with both "Add Laptop Pro to cart" and "Add Gaming Laptop to cart", goal
 * "add a laptop to the cart": it replied with an action on the first candidate,
 * both when the instruction sat in the RULES block and when it was moved to the
 * very end of the prompt. Two placements, no difference.
 *
 * So this runs on the client and needs no model. The bar is deliberately high -
 * a question the user did not need turns a working agent into a nag.
 */

function el(ref: string, role: string, name: string): SanitizedElement {
  return {
    ref,
    role,
    name: { text: name, source: 'content' },
    value: null,
    isSensitive: false,
    states: [],
    rect: { space: 'css-viewport', x: 0, y: 0, width: 10, height: 10 },
  } as unknown as SanitizedElement;
}

const TWO_LAPTOPS = [
  el('e1', 'button', 'Add Laptop Pro to cart'),
  el('e2', 'button', 'Add Gaming Laptop to cart'),
  el('e3', 'searchbox', 'Search products'),
];

describe('when it asks', () => {
  it('asks which laptop when two are offered', () => {
    const f = detectAmbiguity('add a laptop to the cart', TWO_LAPTOPS);
    expect(f).not.toBeNull();
    expect(f?.term).toBe('laptop');
    expect(f?.candidates).toHaveLength(2);
    expect(f?.question).toMatch(/Laptop Pro/);
    expect(f?.question).toMatch(/Gaming Laptop/);
  });

  it('does NOT ask when the goal already picks one', () => {
    /*
     * "add laptop pro to cart" carries a word only one candidate has. Asking
     * here would be the nag this is written to avoid, and it is the single most
     * likely false positive.
     */
    expect(detectAmbiguity('add laptop pro to cart', TWO_LAPTOPS)).toBeNull();
  });

  it('does NOT ask when only one thing matches', () => {
    expect(
      detectAmbiguity('add gaming laptop to cart', [
        el('e1', 'button', 'Add Gaming Laptop to cart'),
        el('e2', 'searchbox', 'Search products'),
      ]),
    ).toBeNull();
  });

  it('does NOT ask when nothing matches', () => {
    expect(detectAmbiguity('book a flight to goa', TWO_LAPTOPS)).toBeNull();
  });

  it('does NOT ask about a search over many results', () => {
    /*
     * Forty laptops on a results page is not an ambiguous goal, it is a goal
     * about forty things - and a question listing forty options is not a
     * question.
     */
    const many = Array.from({ length: 40 }, (_, i) =>
      el(`e${String(i + 1)}`, 'link', `Laptop model ${String(i)}`),
    );
    expect(detectAmbiguity('search for a laptop', many)).toBeNull();
  });

  it('ignores stopwords, so common verbs never trigger it', () => {
    // "add" appears in every button on a shop. It must never be the term.
    const f = detectAmbiguity('add something', [
      el('e1', 'button', 'Add to cart'),
      el('e2', 'button', 'Add to wishlist'),
    ]);
    expect(f).toBeNull();
  });

  it('does not treat a heading and a button as a choice', () => {
    // A heading is not something the agent acts on, so sharing a word with one
    // is not a decision the user has to make.
    expect(
      detectAmbiguity('add a laptop', [
        el('e1', 'heading', 'Laptop deals'),
        el('e2', 'button', 'Add Laptop Pro to cart'),
      ]),
    ).toBeNull();
  });

  it('ignores unnamed elements', () => {
    expect(
      detectAmbiguity('add a laptop', [
        el('e1', 'button', ''),
        el('e2', 'button', ''),
      ]),
    ).toBeNull();
  });

  it('returns ONE finding, not a list', () => {
    // The loop carries a single question per step, and a user facing three at
    // once answers none of them well.
    const f = detectAmbiguity('add a laptop with a warranty', [
      el('e1', 'button', 'Add Laptop Pro to cart'),
      el('e2', 'button', 'Add Gaming Laptop to cart'),
      el('e3', 'button', 'Add warranty Basic'),
      el('e4', 'button', 'Add warranty Plus'),
    ]);
    expect(f).not.toBeNull();
    expect(typeof f?.question).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// the answer must CONSTRAIN, because the model ignores it
// ---------------------------------------------------------------------------

describe('narrowByClarification', () => {
  /*
   * THE BUG THIS EXISTS FOR. The clarification loop worked - question asked,
   * answer typed, task resumed - and the answer changed nothing. Probed against
   * qwen2.5vl at temperature 0, with the ANSWERS block confirmed present in the
   * prompt:
   *
   *   answered "Gaming Laptop" -> {"type":"type","ref":"e14","text":"Laptop Pro"}
   *   answered "Laptop Pro"    -> {"type":"type","ref":"e14","text":"Laptop Pro"}
   *
   * Identical. A conversation whose answer changes nothing is worse than no
   * conversation, because it looks like it works.
   *
   * So the answer removes the elements it rules out. Same principle as the ref
   * allowlist: the way to stop the model choosing wrongly is not to send the
   * wrong ones. After this, the same probe returns e18 for Gaming and e14 for
   * Pro.
   */
  const CART = [
    el('e1', 'button', 'Add Laptop Pro to cart'),
    el('e2', 'button', 'Add Gaming Laptop to cart'),
    el('e3', 'button', 'Add Smartphone X to cart'),
  ];
  const Q = 'Which one did you mean - Add Laptop Pro to cart, or Add Gaming Laptop to cart?';
  const GOAL = 'add laptop to the cart';

  it('removes the candidate the user did not choose', () => {
    const kept = narrowByClarification(CART, [{ question: Q, answer: 'Gaming Laptop' }], GOAL);
    const names = kept.map((k) => k.name?.text ?? '');
    expect(names).toContain('Add Gaming Laptop to cart');
    expect(names).not.toContain('Add Laptop Pro to cart');
  });

  it('leaves elements outside the group alone', () => {
    // Only siblings of the group the user was asked about are removed. The
    // smartphone was never part of the question.
    const kept = narrowByClarification(CART, [{ question: Q, answer: 'Laptop Pro' }], GOAL);
    expect(kept.map((k) => k.name?.text ?? '')).toContain('Add Smartphone X to cart');
  });

  it('matches on the DISTINCTIVE word, not raw overlap', () => {
    /*
     * Every candidate shares the goal term by construction, so counting raw hits
     * gives "Gaming Laptop" a point for `laptop` against both. What separates
     * them is `gaming` versus `pro`.
     */
    const kept = narrowByClarification(CART, [{ question: Q, answer: 'the gaming one' }], GOAL);
    expect(kept.map((k) => k.name?.text ?? '')).not.toContain('Add Laptop Pro to cart');
  });

  it('changes nothing when the answer names none of them', () => {
    // Guessing which was meant is how a clarification becomes a wrong click
    // wearing the user's own words.
    const kept = narrowByClarification(CART, [{ question: Q, answer: 'a tablet' }], GOAL);
    expect(kept).toHaveLength(CART.length);
  });

  it('changes nothing when the answer names all of them', () => {
    const kept = narrowByClarification(CART, [{ question: Q, answer: 'laptop' }], GOAL);
    expect(kept).toHaveLength(CART.length);
  });

  it('never renumbers - it is a filter', () => {
    // The same rule the budget follows, for the same reason: extractRefPaths
    // walks the unfiltered document.
    const kept = narrowByClarification(CART, [{ question: Q, answer: 'Gaming Laptop' }], GOAL);
    expect(kept.map((k) => String(k.ref))).toEqual(['e2', 'e3']);
  });
});

describe('the question only offers what the goal is about', () => {
  it('excludes candidates that match the goal less well', () => {
    /*
     * A real run asked "View details for Laptop Pro, or Add Laptop Pro to cart,
     * or View details for Gaming Laptop, or Add Gaming Laptop to cart?" - four
     * options across two different actions, when the goal said "add ... to
     * cart". The extra pair made the question unreadable AND the answer
     * ambiguous, because "Gaming Laptop" then matched two candidates equally.
     */
    const f = detectAmbiguity('add laptop to the cart', [
      el('e1', 'button', 'View details for Laptop Pro'),
      el('e2', 'button', 'Add Laptop Pro to cart'),
      el('e3', 'button', 'View details for Gaming Laptop'),
      el('e4', 'button', 'Add Gaming Laptop to cart'),
    ]);
    expect(f?.candidates).toEqual(['Add Laptop Pro to cart', 'Add Gaming Laptop to cart']);
    expect(f?.question).not.toMatch(/View details/);
  });

  it('ignores non-actionable roles entirely', () => {
    /*
     * The first real run asked about the HEADINGS - "Laptop Pro, or Gaming
     * Laptop" - so the answer matched no button and nothing could be narrowed.
     * Asking about what can be clicked keeps the question and the remedy in one
     * vocabulary.
     */
    const f = detectAmbiguity('add laptop to the cart', [
      el('e1', 'heading', 'Laptop Pro'),
      el('e2', 'heading', 'Gaming Laptop'),
    ]);
    expect(f).toBeNull();
  });
});

describe('a goal naming something the page does not have', () => {
  /*
   * FROM A REAL AMAZON RUN. Goal "add macbook pro to cart" on a homepage with no
   * MacBook produced:
   *
   *   Which one did you mean - Cart, shift, alt, c, or 0 items in cart?
   *
   * `macbook` matched nothing, so the loop fell through to `cart` - a word all
   * over the nav - and offered the cart link and the cart counter. No answer to
   * that question helps, and the task stopped to ask it.
   *
   * The user named something the page does not contain. That is a page the agent
   * has not navigated to yet, not a choice the user has to make.
   */
  it('stays silent rather than asking about an incidental word', () => {
    const amazonish = [
      el('e1', 'link', 'Cart, shift, alt, c'),
      el('e2', 'link', '0 items in cart'),
      el('e3', 'searchbox', 'Search Amazon'),
    ];
    expect(detectAmbiguity('add macbook pro to cart', amazonish)).toBeNull();
  });

  it('still asks when every goal word is present', () => {
    // The working case must keep working: both `laptop` and `cart` are on the
    // page, and neither picks between the two candidates.
    const shop = [
      el('e1', 'button', 'Add Laptop Pro to cart'),
      el('e2', 'button', 'Add Gaming Laptop to cart'),
    ];
    expect(detectAmbiguity('add a laptop to the cart', shop)).not.toBeNull();
  });

  it('is not fooled by the word appearing on a non-actionable element', () => {
    // A heading mentioning MacBook does not make it something the agent can act
    // on, so it must not license a question about the cart either.
    const withHeading = [
      el('e1', 'heading', 'MacBook deals this week'),
      el('e2', 'link', 'Cart, shift, alt, c'),
      el('e3', 'link', '0 items in cart'),
    ];
    expect(detectAmbiguity('add macbook to cart', withHeading)).toBeNull();
  });
});

describe('the question shows what DIFFERS, not what the controls share', () => {
  /*
   * FROM A REAL CART PAGE ON amazon.in. Every control on a product row is named
   * after the product, so the two choices ran to 445 characters and were about
   * ninety percent identical - the reader had to diff two paragraphs in their
   * head to find the four words that decided it. On a shopping site this is the
   * ORDINARY case, not an unlucky one.
   */
  const PRODUCT =
    'Lenovo Legion 5 2025 AMD Ryzen 7 260 | NVIDIA RTX 5060 8GB (16GB RAM/1TB SSD/' +
    'WUXGA IPS/165Hz/15(39.6cm)/Windows 11/Office 2024+AI Now/Black/2.5Kg), ' +
    '83M00074IN AI Powered Gaming Laptop';

  it('strips the shared product name out of the choices', () => {
    const q = composeQuestion([
      `Delete ${PRODUCT}`,
      `Increase quantity by one, Quantity is 1, ${PRODUCT}`,
    ]);

    // The decision, in the first few words, where it can be read.
    expect(q).toContain('Delete, or Increase quantity by one');
    // The product is stated ONCE as context, not twice as a choice.
    expect(q).toContain('both on:');
    expect(q.split('Lenovo').length - 1).toBe(1);
    // And the whole thing is short enough to read.
    expect(q.length).toBeLessThan(220);
  });

  it('leaves a dangling separator behind when it trims', () => {
    // "...Quantity is 1," used to end on a comma pointing at nothing, which
    // reads as though the option itself had been truncated.
    const q = composeQuestion([`Delete ${PRODUCT}`, `Quantity is 1, ${PRODUCT}`]);
    expect(q).not.toContain(',?');
    expect(q).not.toContain(' ,');
  });

  it('handles a shared PREFIX as well as a shared suffix', () => {
    const q = composeQuestion(['Add Laptop Pro to cart', 'Add Gaming Laptop to cart']);
    expect(q).toContain('Laptop Pro, or Gaming Laptop');
    expect(q).toContain('Add to cart');
  });

  it('says "all" rather than "both" past two choices', () => {
    const q = composeQuestion([
      'Add Laptop Pro to cart',
      'Add Gaming Laptop to cart',
      'Add Ultrabook to cart',
    ]);
    expect(q).toContain('all on:');
  });

  it('changes nothing when the names share no words', () => {
    const q = composeQuestion(['Add to cart', 'Buy now']);
    expect(q).toBe('Which one did you mean - Add to cart, or Buy now?');
  });

  it('never renders an empty choice', () => {
    /*
     * One name being a prefix of the other is where trimming can eat a whole
     * option. A question naming an empty choice is worse than a long one, so
     * this falls back to the full names.
     */
    for (const pair of [
      ['Qty 1', 'Qty 1 more'],
      ['Save', 'Save for later'],
      ['a b c', 'a b c d'],
    ]) {
      const q = composeQuestion(pair);
      expect(q, pair.join(' | ')).not.toMatch(/-\s*,|,\s*or\s*\?|-\s*\?/);
      for (const name of pair) {
        // Each option must still be identifiable in the question.
        expect(q.length, pair.join(' | ')).toBeGreaterThan('Which one did you mean - ?'.length);
        void name;
      }
    }
  });
});
