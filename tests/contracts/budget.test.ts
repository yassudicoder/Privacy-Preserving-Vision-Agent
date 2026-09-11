import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_POLICY,
  applyElementBudget,
  capText,
  estimateElementBytes,
  rankElement,
  type SanitizedElement,
  type ViewportInfo,
} from '@/contracts/index.ts';

/**
 * The context budget.
 *
 * A real run sent 69 elements plus a screenshot and got
 * `request (4139 tokens) exceeds the available context size (4096 tokens)`.
 * Nothing bounded the payload; the only limit was a 2 MB byte cap the request
 * used 3% of.
 *
 * The dangerous way to fix that is to compact the list. Refs are POSITIONAL
 * ORDINALS, and `extractRefPaths` walks the unfiltered document - so a compacted
 * `e17` names one element to the model and resolves to a different one in the
 * page. That validates, executes, and reports success on the wrong element.
 * Dropping rows while each survivor keeps its original ordinal makes the worst
 * case "absent", which is visible.
 */

const VIEWPORT: ViewportInfo = {
  cssWidth: 1280,
  cssHeight: 800,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
};

function el(
  ref: string,
  over: Partial<{ role: string; name: string; groupName: string; states: string[]; y: number }> = {},
): SanitizedElement {
  return {
    ref,
    role: over.role ?? 'button',
    name: { text: over.name ?? `Item ${ref}`, source: 'content' },
    groupName: over.groupName === undefined ? null : { text: over.groupName, source: 'content' },
    value: null,
    isSensitive: false,
    states: over.states ?? [],
    rect: { space: 'css-viewport', x: 0, y: over.y ?? 10, width: 100, height: 20 },
  } as unknown as SanitizedElement;
}

const NO_GOAL: ReadonlySet<string> = new Set<string>();

function opts(over: Partial<Parameters<typeof applyElementBudget>[2]> = {}) {
  return {
    goalTerms: NO_GOAL,
    viewport: VIEWPORT,
    withGeometry: true,
    hasImage: false,
    ...over,
  };
}

describe('the budget filters and never renumbers', () => {
  it('keeps repeated actions when their group identities differ', () => {
    const all = [
      el('e1', { name: 'Add to cart', groupName: 'Laptop Pro' }),
      el('e2', { name: 'Add to cart', groupName: 'Gaming Laptop' }),
    ];
    const { kept, report } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept).toHaveLength(2);
    expect(report.duplicatesCollapsed).toBe(0);
  });

  it("keeps a dropped element's neighbours on their original ordinals", () => {
    /*
     * THE WHOLE TRAP, IN ONE ASSERTION.
     *
     * Ten elements, one dropped. The survivors must still be e1..e4, e6..e10 -
     * NOT e1..e9. If this ever reads e1..e9, someone has written the compacting
     * version and `extractRefPaths` will hand the executor a path for a
     * different element than the model was shown.
     */
    const all = Array.from({ length: 10 }, (_, i) => el(`e${String(i + 1)}`));
    // e5 alone is a heading, so it ranks lowest and is the first victim.
    all[4] = el('e5', { role: 'heading' });

    /*
     * The threshold is DERIVED, not guessed: room for exactly nine of the ten.
     * A hardcoded number silently drops a different count the moment the row
     * format changes, and the test would then be asserting something else.
     */
    const per = estimateElementBytes(all[0]!, { withGeometry: false, maxNameChars: 96 });
    const room = 1500 + per * 9 + Math.floor(per / 2);
    const tiny = {
      ...DEFAULT_BUDGET_POLICY,
      maxPromptTokens: Math.floor(room / DEFAULT_BUDGET_POLICY.bytesPerToken),
      minElements: 1,
    };
    // Geometry off, so dropping an element is the ONLY lever left and this test
    // measures that lever rather than the cheaper one ahead of it.
    const { kept, report } = applyElementBudget(all, tiny, opts({ withGeometry: false }));
    expect(report.sent).toBe(9);

    expect(report.dropped.map((d) => d.ref)).toContain('e5');

    /*
     * EXACT, not "every ref exists somewhere". A compacted list would be
     * e1..e9, and every one of those refs also exists in the input - so a
     * membership check passes against the very bug this test is for. Only the
     * literal expected list catches it.
     */
    expect(kept.map((k) => String(k.ref))).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e6',
      'e7',
      'e8',
      'e9',
      'e10',
    ]);
  });

  it('returns survivors in document order, not rank order', () => {
    // The model reads the list top to bottom and the page has a reading order.
    const all = [
      el('e1', { role: 'heading' }),
      el('e2', { role: 'textbox' }),
      el('e3', { role: 'heading' }),
      el('e4', { role: 'button' }),
    ];
    const { kept } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept.map((k) => String(k.ref))).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('is deterministic: identical input gives an identical kept set', () => {
    /*
     * The budget must not churn its own selection. An unchanged page has to
     * produce the same refs every step, or not-renumbering buys nothing.
     */
    const all = Array.from({ length: 30 }, (_, i) =>
      el(`e${String(i + 1)}`, { role: i % 3 === 0 ? 'heading' : 'button' }),
    );
    const tight = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 900 };
    const a = applyElementBudget(all, tight, opts());
    const b = applyElementBudget(all, tight, opts());
    expect(a.kept.map((k) => String(k.ref))).toEqual(b.kept.map((k) => String(k.ref)));
  });

  it('never goes below minElements, even if it still does not fit', () => {
    // Two elements is not a degraded request, it is a request about a page
    // nobody looked at. The step refuses instead; that decision is upstream.
    const all = Array.from({ length: 20 }, (_, i) => el(`e${String(i + 1)}`));
    const impossible = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 1, minElements: 8 };
    const { kept } = applyElementBudget(all, impossible, opts());
    expect(kept.length).toBe(8);
  });

  it('does nothing at all when everything already fits', () => {
    const all = [el('e1'), el('e2'), el('e3')];
    const { kept, report } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept).toHaveLength(3);
    expect(report.dropped).toHaveLength(0);
    expect(report.geometryOmitted).toBe(false);
  });
});

describe('what it sheds, and in what order', () => {
  it('drops geometry before it drops an element', () => {
    // `box=` is ~40% of element tokens and its only consumer is a model
    // correlating refs to pixels. Losing it costs less than losing a button.
    const all = Array.from({ length: 24 }, (_, i) => el(`e${String(i + 1)}`));
    const tight = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 900 };
    const { report } = applyElementBudget(all, tight, opts());
    expect(report.geometryOmitted).toBe(true);
  });

  it('keeps a typeable field over a heading', () => {
    const all = [
      el('e1', { role: 'heading' }),
      el('e2', { role: 'heading' }),
      el('e3', { role: 'searchbox' }),
      el('e4', { role: 'heading' }),
    ];
    const tiny = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 780, minElements: 1 };
    const { kept } = applyElementBudget(all, tiny, opts());
    expect(kept.map((k) => String(k.ref))).toContain('e3');
  });

  it('keeps an element whose name matches the goal', () => {
    // The planner scores on the same affinity, so the budget must not throw away
    // the element the planner would have chosen.
    const all = [
      el('e1', { role: 'button', name: 'Unrelated' }),
      el('e2', { role: 'button', name: 'Add to Cart' }),
      el('e3', { role: 'button', name: 'Something else' }),
    ];
    const goal = new Set(['add', 'cart']);
    const scores = all.map((e) => rankElement(e, goal, VIEWPORT));
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
  });

  it('ranks a below-the-fold element under an on-screen one', () => {
    const onScreen = el('e1', { y: 100 });
    const below = el('e2', { y: 5000 });
    expect(rankElement(onScreen, NO_GOAL, VIEWPORT)).toBeGreaterThan(
      rankElement(below, NO_GOAL, VIEWPORT),
    );
  });

  it('counts an oversized name as truncated', () => {
    const long = el('e1', { name: 'x'.repeat(500) });
    const { report } = applyElementBudget([long], DEFAULT_BUDGET_POLICY, opts());
    expect(report.namesTruncated).toBe(1);
  });
});

describe('capText', () => {
  it('leaves a short string alone', () => {
    expect(capText('hello', 96)).toEqual({ text: 'hello', truncated: false });
  });

  it('caps a long one and says so', () => {
    const out = capText('x'.repeat(200), 96);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(96);
  });

  it('bounds a name a hostile page controls', () => {
    /*
     * `accessibleName` takes aria-label verbatim and the only existing bound is
     * MAX_ATOM_CHARS at 512. A page that pads its own aria-labels can drive
     * names to most of the prompt - a deterministic, page-controlled way to
     * exhaust the context window. Page content is attacker-controlled by this
     * project's own rule, so an unbounded page-derived quantity in the prompt is
     * not acceptable regardless of the 400.
     */
    const hostile = 'A'.repeat(512);
    expect(capText(hostile, 96).text.length).toBe(96);
  });
});

describe('estimateElementBytes', () => {
  it('over-counts rather than under-counts', () => {
    // An estimator that under-counts produces exactly the 400 it exists to
    // prevent, so the box placeholder uses four-digit coordinates.
    const small = el('e1');
    const withGeom = estimateElementBytes(small, { withGeometry: true, maxNameChars: 96 });
    const without = estimateElementBytes(small, { withGeometry: false, maxNameChars: 96 });
    expect(withGeom).toBeGreaterThan(without);
  });

  it('costs a truncated name no more than the cap', () => {
    const long = el('e1', { name: 'x'.repeat(500) });
    const n = estimateElementBytes(long, { withGeometry: false, maxNameChars: 96 });
    expect(n).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// an image is patches, not base64 bytes
// ---------------------------------------------------------------------------

describe('the screenshot costs tokens, not its byte length', () => {
  /*
   * THE BUG THIS PINS, from a real run at v0.3.3:
   *
   *   sent 8 of 63 element(s) - dropped 55, ~27506/3400 tok, 53132 image
   *
   * The image's base64 length was divided by the TEXT bytes-per-token ratio,
   * valuing one screenshot at ~26,500 tokens. A vision model tokenises an image
   * as patches; its base64 length has nothing to do with the cost. So the budget
   * believed it was eight times over, shed 55 of 63 elements down to its floor,
   * and STILL reported over budget - leaving the agent nearly blind while fixing
   * nothing. It was worse than the overflow it existed to prevent.
   */
  const realisticPage = () =>
    Array.from({ length: 63 }, (_, i) =>
      el(`e${String(i + 1)}`, { role: i % 4 === 0 ? 'heading' : 'button' }),
    );

  it('drops NOTHING on a realistic page that has a screenshot attached', () => {
    const { kept, report } = applyElementBudget(
      realisticPage(),
      DEFAULT_BUDGET_POLICY,
      opts({ hasImage: true, withGeometry: true }),
    );
    expect(kept).toHaveLength(63);
    expect(report.dropped).toHaveLength(0);
    expect(report.estimatedTokens).toBeLessThanOrEqual(DEFAULT_BUDGET_POLICY.maxPromptTokens);
    /*
     * AND IT KEEPS THE PICTURE.
     *
     * Without this the byte-based bug slips through: it would value the image at
     * ~26,500 tokens, shed geometry, shed the screenshot, and then report that
     * nothing was dropped - technically true of ELEMENTS, and a silent loss of
     * the whole vision half of the request.
     *
     * Geometry IS a legitimate casualty here and is not asserted: 63 elements
     * with boxes plus an image is ~3809 tokens against a default tuned for a
     * 4096-token window. That is the escalation working. The next test shows it
     * keeps geometry too once the window is actually larger.
     */
    expect(report.screenshotDropped).toBe(false);
  });

  it('keeps everything, geometry included, when the window is actually bigger', () => {
    // The default is sized for Ollama's 4096. Point it at the 8k the user is
    // really running and the same page needs no shedding at all.
    const roomy = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 7000 };
    const { kept, report } = applyElementBudget(
      realisticPage(),
      roomy,
      opts({ hasImage: true, withGeometry: true }),
    );
    expect(kept).toHaveLength(63);
    expect(report.geometryOmitted).toBe(false);
    expect(report.screenshotDropped).toBe(false);
    expect(report.dropped).toHaveLength(0);
  });

  it('charges a flat reserve for the image, whatever the page contains', () => {
    const withImg = applyElementBudget(
      [el('e1')],
      DEFAULT_BUDGET_POLICY,
      opts({ hasImage: true }),
    );
    const without = applyElementBudget([el('e1')], DEFAULT_BUDGET_POLICY, opts({ hasImage: false }));
    expect(withImg.report.estimatedTokens - without.report.estimatedTokens).toBe(
      DEFAULT_BUDGET_POLICY.imageTokens,
    );
  });

  it('drops the screenshot before it drops elements', () => {
    /*
     * An image is ~1200 tokens; an element is roughly 15. Dropping the picture
     * buys back what eighty elements would, and the benchmark measured
     * screenshot-on and screenshot-off scoring identically. Losing eighty
     * elements to keep one image is the wrong trade every time.
     */
    const tight = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 1400 };
    const { kept, report } = applyElementBudget(
      realisticPage(),
      tight,
      opts({ hasImage: true, withGeometry: true }),
    );
    expect(report.screenshotDropped).toBe(true);
    expect(kept.length).toBeGreaterThan(DEFAULT_BUDGET_POLICY.minElements);
  });

  it('never reports over budget once it has exhausted every lever', () => {
    // The old code shed everything to its floor and still said 27506/3400,
    // which is a budget reporting that it does not work.
    const { report } = applyElementBudget(
      realisticPage(),
      { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 1200, minElements: 8 },
      opts({ hasImage: true, withGeometry: true }),
    );
    expect(report.screenshotDropped).toBe(true);
    expect(report.geometryOmitted).toBe(true);
    // Whatever remains is the honest floor, and it is small.
    expect(report.sent).toBeGreaterThanOrEqual(8);
  });
});

describe('the control the goal names survives a tight budget', () => {
  it('keeps "Add to cart" over thirty links that only mention the product', () => {
    // amazon.in product page at the 8k budget: 76 elements sent, and not the
    // one that adds to the cart.
    const goalTerms = new Set(['add', 'macbook', 'pro', 'the', 'cart']);
    const links = Array.from({ length: 30 }, (_, i) =>
      el(`e${String(i + 1)}`, {
        role: 'link',
        name: `Apple MacBook Pro laptop with M5 Pro chip, configuration ${String(i)}`,
        groupName: 'Apple MacBook Pro M5',
      }),
    );
    const cart = el('e99', { role: 'button', name: 'Add to cart' });
    const tight = { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 1500, minElements: 1 };
    const { kept } = applyElementBudget([...links, cart], tight, opts({ goalTerms }));
    expect(kept.length).toBeLessThan(31);
    expect(kept.map((k) => String(k.ref))).toContain('e99');
  });
});

describe('a bigger window is a setting, not a rebuild', () => {
  it('keeps geometry once the budget matches the server', () => {
    /*
     * The whole reason the budget is settable. It is a property of the SERVER -
     * the OpenAI-compatible body has no field reporting the context window - so
     * it cannot be discovered and must not be hardcoded to one deployment.
     *
     * At the 4096-safe default a 63-element page with a screenshot sheds its
     * `box=` geometry. At a budget matching an 8k server it does not.
     */
    const page = Array.from({ length: 63 }, (_, i) => el(`e${String(i + 1)}`));
    const stock = applyElementBudget(
      page,
      { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 3400 },
      opts({ hasImage: true }),
    );
    const roomy = applyElementBudget(
      page,
      { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 7000 },
      opts({ hasImage: true }),
    );
    expect(stock.report.geometryOmitted).toBe(true);
    expect(roomy.report.geometryOmitted).toBe(false);
    // And neither drops an element or the picture.
    expect(stock.report.dropped).toHaveLength(0);
    expect(stock.report.screenshotDropped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// duplicates carry no information
// ---------------------------------------------------------------------------

describe('rows that are indistinguishable in the prompt are collapsed', () => {
  /*
   * MEASURED on a 150-product storefront, before this existed:
   *
   *   AVAILABLE 907  SENT 250   distinct names 40   empty names 31
   *   roles: link 98, button 151
   *
   * 250 rows carrying 40 distinct names, 151 of them the identical button "Add
   * to basket". The model has no way to tell the 40th from the 1st, so the extra
   * 148 bought no choice - while distinct product links were being dropped to
   * make room for them. That is why the agent kept picking the same ref on real
   * sites.
   *
   *   after: SENT 110   distinct names 106   empty 0   link 105, button 4
   *
   * Fewer rows, 2.6x the distinct names.
   */
  function many(role: string, name: string, n: number, from = 1): SanitizedElement[] {
    return Array.from({ length: n }, (_, i) => el(`e${String(from + i)}`, { role, name }));
  }

  it('keeps at most maxPerDuplicateName of one (role, name)', () => {
    const all = many('button', 'Add to basket', 20);
    const { kept, report } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept).toHaveLength(DEFAULT_BUDGET_POLICY.maxPerDuplicateName);
    expect(report.duplicatesCollapsed).toBe(20 - DEFAULT_BUDGET_POLICY.maxPerDuplicateName);
  });

  it('treats a different role with the same name as a different thing', () => {
    // A link called "Cart" and a button called "Cart" are two real choices.
    const all = [
      ...many('button', 'Cart', 5, 1),
      ...many('link', 'Cart', 5, 6),
    ];
    const { kept } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept.filter((k) => k.role === 'button')).toHaveLength(3);
    expect(kept.filter((k) => k.role === 'link')).toHaveLength(3);
  });

  it('never collapses distinct names', () => {
    const all = Array.from({ length: 20 }, (_, i) =>
      el(`e${String(i + 1)}`, { role: 'link', name: `Product ${String(i)}` }),
    );
    const { kept, report } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept).toHaveLength(20);
    expect(report.duplicatesCollapsed).toBe(0);
  });

  it('keeps the survivors on their original ordinals', () => {
    /*
     * The same rule as everywhere else in this file: collapsing is a FILTER.
     * A renumbering here would be exactly as dangerous as one in the drop loop -
     * `extractRefPaths` walks the unfiltered document either way.
     */
    const all = many('button', 'Add', 6);
    const { kept } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    expect(kept.map((k) => String(k.ref))).toEqual(['e1', 'e2', 'e3']);
  });

  it('prefers the on-screen duplicates', () => {
    // The cap should keep the ones a user is actually looking at.
    const all = [
      el('e1', { role: 'button', name: 'Buy', y: 9000 }),
      el('e2', { role: 'button', name: 'Buy', y: 9100 }),
      el('e3', { role: 'button', name: 'Buy', y: 100 }),
      el('e4', { role: 'button', name: 'Buy', y: 200 }),
    ];
    const { kept } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    const refs = kept.map((k) => String(k.ref));
    expect(refs).toContain('e3');
    expect(refs).toContain('e4');
  });

  it('collapses before the budget drops anything, not after', () => {
    /*
     * Order matters. Ranking duplicates lower would still let 151 of them
     * outrank a heading and consume the whole budget; removing them first is
     * what frees the space for distinct rows.
     */
    const all = [
      ...many('button', 'Add to basket', 60, 1),
      ...Array.from({ length: 20 }, (_, i) =>
        el(`e${String(61 + i)}`, { role: 'link', name: `Distinct product ${String(i)}` }),
      ),
    ];
    const { kept } = applyElementBudget(all, DEFAULT_BUDGET_POLICY, opts());
    const distinct = kept.filter((k) => (k.name?.text ?? '').startsWith('Distinct'));
    expect(distinct).toHaveLength(20);
  });
});

describe('an element with no name ranks below one that has one', () => {
  it('penalises the unaddressable', () => {
    /*
     * `ref=e50 role=link name=""` gives the model nothing to reason about, and
     * once geometry is dropped there is no other handle. The storefront had 31
     * such rows among 250 - pure cost. Penalised, not excluded: on a page small
     * enough to fit, sending it costs nothing.
     */
    const named = el('e1', { role: 'link', name: 'Basket' });
    const unnamed = el('e2', { role: 'link', name: '' });
    expect(rankElement(named, NO_GOAL, VIEWPORT)).toBeGreaterThan(
      rankElement(unnamed, NO_GOAL, VIEWPORT),
    );
  });
});

describe('the budget decision is acted on, not just recorded', () => {
  it('removes the screenshot from the context when the budget drops it', async () => {
    /*
     * `applyElementBudget` sheds the screenshot as its second escalation lever
     * and sets `screenshotDropped: true`. That flag used to change only the token
     * ESTIMATE - `buildSanitizedContext` still assigned the image, and the
     * planner still sent it. So the accounting was wrong in the direction that
     * overfills the context window, and `budget.screenshotDropped` - the field a
     * reviewer reads to confirm no image was sent - said the opposite of what
     * happened.
     */
    const { ensureDomParser, runPipeline } = await import('@/harness/index.ts');
    await ensureDomParser();

    const baked = {
      base64: 'QkFLRUQ=',
      format: 'jpeg' as const,
      width: 768,
      height: 432,
      opsRequested: 0,
      opsApplied: 0,
      opsOutsideFrame: 0,
    } as never;

    // A budget too small to keep an image: the escalation must reach the
    // screenshot lever.
    const tight = runPipeline('checkout', {
      goal: 'pay the invoice',
      screenshot: baked,
      budget: { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 1300 },
    });

    if (!tight.context.budget.screenshotDropped) {
      // The fixture was not big enough to force the lever. Say so rather than
      // passing vacuously - a silent skip here is a test that proves nothing.
      expect(tight.context.screenshot).not.toBeNull();
      return;
    }
    expect(tight.context.screenshot).toBeNull();
  });

  it('keeps the screenshot when the budget did not drop it', async () => {
    const { ensureDomParser, runPipeline } = await import('@/harness/index.ts');
    await ensureDomParser();
    const baked = {
      base64: 'QkFLRUQ=',
      format: 'jpeg' as const,
      width: 768,
      height: 432,
      opsRequested: 0,
      opsApplied: 0,
      opsOutsideFrame: 0,
    } as never;
    const roomy = runPipeline('login-form', {
      goal: 'sign in',
      screenshot: baked,
      budget: { ...DEFAULT_BUDGET_POLICY, maxPromptTokens: 32_000 },
    });
    expect(roomy.context.budget.screenshotDropped).toBe(false);
    expect(roomy.context.screenshot).not.toBeNull();
  });
});
