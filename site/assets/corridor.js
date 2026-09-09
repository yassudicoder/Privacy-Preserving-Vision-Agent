/**
 * THE CORRIDOR - the sticky stage where one real page crosses the boundary.
 *
 * Native scroll and sticky positioning. NO SCROLL-JACKING: the visitor's scroll
 * is never intercepted, rewritten or eased. Each station is an ordinary
 * screenful of document; one IntersectionObserver per station sets a class on
 * the stage, and everything else is CSS transitions on transform and opacity.
 *
 * Below 820px, and under prefers-reduced-motion, the sticky stage is hidden
 * entirely by CSS and the five station cards stack as ordinary prose carrying
 * identical copy. The choreography is an enhancement over a page that already
 * says everything it needs to say.
 */

/**
 * Luhn, computed rather than re-enacted.
 *
 * The signature moment on this page is two sixteen-digit numbers where only one
 * is a card. Hardcoding the sums would be less work than this function and
 * would also be the single most checkable falsehood on a site whose whole
 * argument is that other people publish figures nobody verified. So the readout
 * ticks from this accumulator, digit by digit, and lands wherever the
 * arithmetic lands.
 *
 * Returns the running state after each digit, right to left, so the animation
 * has something real to step through.
 */
export function luhnSteps(raw) {
  const digits = raw.replace(/\D/g, '').split('').map(Number);
  const steps = [];
  let sum = 0;
  for (let i = digits.length - 1, pos = 0; i >= 0; i--, pos++) {
    const d = digits[i];
    let add = d;
    const doubled = pos % 2 === 1;
    if (doubled) {
      add = d * 2;
      if (add > 9) add -= 9;
    }
    sum += add;
    steps.push({ index: i, digit: d, doubled, add, sum });
  }
  return { steps, sum, valid: sum % 10 === 0 };
}

/**
 * The outbound payload, as explicit LINES of [class, text] tokens.
 *
 * Written line by line rather than as one token stream with newline heuristics
 * — the heuristic version broke a key away from its own value and rendered
 * JSON that would not parse, on the one panel whose whole job is to look like
 * the real thing.
 */
const PAYLOAD_SANITIZED = [
  [['pd', '{']],
  [['pk', '  "url"'], ['pd', ': '], ['ps', '"shop.example/checkout"'], ['pd', ',']],
  [['pk', '  "title"'], ['pd', ': '], ['ps', '"Checkout"'], ['pd', ',']],
  [['pk', '  "elements"'], ['pd', ': [']],
  [['pd', '    { '], ['pk', '"ref"'], ['pd', ':'], ['ps', '"e2"'], ['pd', ', '], ['pk', '"role"'], ['pd', ':'], ['ps', '"textbox"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"name"'], ['pd', ':'], ['ps', '"Name on card"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"value"'], ['pd', ':'], ['pm', '"[[PII:PERSON_NAME:1:9f2a]]"'], ['pd', ' },']],
  [['pd', '    { '], ['pk', '"ref"'], ['pd', ':'], ['ps', '"e3"'], ['pd', ', '], ['pk', '"role"'], ['pd', ':'], ['ps', '"textbox"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"name"'], ['pd', ':'], ['ps', '"Card number"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"value"'], ['pd', ':'], ['pm', '"[[PII:CREDIT_CARD:2:9f2a]]"'], ['pd', ' },']],
  [['pd', '    { '], ['pk', '"ref"'], ['pd', ':'], ['ps', '"e7"'], ['pd', ', '], ['pk', '"role"'], ['pd', ':'], ['ps', '"text"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"name"'], ['pd', ':'], ['ps', '"Order reference"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"value"'], ['pd', ':'], ['ps', '"ORD-4471-9920"'], ['pd', ' },']],
  [['pd', '    { '], ['pk', '"ref"'], ['pd', ':'], ['ps', '"e8"'], ['pd', ', '], ['pk', '"role"'], ['pd', ':'], ['ps', '"button"'], ['pd', ',']],
  [['pd', '      '], ['pk', '"name"'], ['pd', ':'], ['ps', '"Pay now"'], ['pd', ' }']],
  [['pd', '  ]']],
  [['pd', '}']],
];

const PAYLOAD_ACTION = [
  [['pd', '{']],
  [['pk', '  "type"'], ['pd', ':'], ['ps', '"click"'], ['pd', ',']],
  [['pk', '  "ref"'], ['pd', ':'], ['ps', '"e8"']],
  [['pd', '}']],
];

/**
 * Renders lines of [class, text] tokens as highlighted code. Every token is
 * inserted with textContent, so nothing here can produce markup.
 */
function renderTokens(el, lines) {
  el.textContent = '';
  lines.forEach((tokens, i) => {
    if (i > 0) el.append('\n');
    for (const [cls, text] of tokens) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      el.append(span);
    }
  });
}

/**
 * What each detected field becomes once station 3 has run.
 *
 * These have to be REAL substitutions, not a colour change. An earlier version
 * of this file only restyled the values and left the card number legible on
 * screen while the caption above it said the value had been removed — which is
 * precisely the overclaim the rest of this site exists to argue against.
 */
const MARKERS = {
  'person-name': '[[PII:PERSON_NAME:1:9f2a]]',
  'credit-card': '[[PII:CREDIT_CARD:2:9f2a]]',
  cvv: '[[PII:CVV:3:9f2a]]',
  email: '[[PII:EMAIL:4:9f2a]]',
  phone: '[[PII:PHONE:5:9f2a]]',
};

export function initCorridor() {
  const root = document.querySelector('[data-corridor]');
  if (!root) return;

  const stations = [...root.querySelectorAll('.station')];
  const payloadCode = root.querySelector('[data-payload-code] code');
  const twins = root.querySelector('[data-twins]');
  const gates = [...root.querySelectorAll('.gate')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // Every value that will be redacted, with its original text kept so the
  // stage can be scrolled back through.
  const values = [...root.querySelectorAll('.sp-row[data-kind] .sp-v')].map((el) => {
    const row = el.closest('.sp-row');
    return { el, raw: el.textContent, marker: MARKERS[row.dataset.kind] ?? '[[PII:REDACTED]]' };
  });

  let current = 0;
  let twinTimers = [];
  let wipeTimers = [];

  /** Stamps the markers in, or puts the original values back. */
  function setRedacted(on) {
    wipeTimers.forEach(clearTimeout);
    wipeTimers = [];
    values.forEach((v, i) => {
      const write = () => {
        v.el.textContent = on ? v.marker : v.raw;
      };
      // A stamp, not a dissolve: 90 ms apart, in document order.
      if (on && !reduced.matches) wipeTimers.push(setTimeout(write, i * 90));
      else write();
    });
  }

  const clearTwins = () => {
    twinTimers.forEach(clearTimeout);
    twinTimers = [];
  };

  /**
   * Steps the checksum across one number, doubling every second digit from the
   * right and ticking a running total, then states the verdict the arithmetic
   * produced.
   */
  function runChecksum(node, raw, kind) {
    const digitsEl = node.querySelector('[data-twin-digits]');
    const sumEl = node.querySelector('[data-twin-sum]');
    const verdictEl = node.querySelector('.twin-verdict');
    const { steps, sum, valid } = luhnSteps(raw);
    const chars = raw.split('');

    verdictEl.textContent = '';
    verdictEl.className = 'twin-verdict';
    sumEl.textContent = 'sum 0';

    // Rebuild the number as one span per character so a digit can be lit
    // without re-laying-out the line.
    digitsEl.textContent = '';
    const spans = chars.map((c) => {
      const s = document.createElement('span');
      s.textContent = c;
      digitsEl.append(s);
      return s;
    });

    // Map digit-only indices back to character positions.
    const digitPositions = [];
    chars.forEach((c, i) => { if (/\d/.test(c)) digitPositions.push(i); });

    if (reduced.matches) {
      sumEl.textContent = `sum ${sum} · mod 10 = ${sum % 10}`;
      verdictEl.textContent = valid ? 'VALID CARD · REDACT' : 'NOT A CARD · LEAVE ALONE';
      verdictEl.classList.add(valid ? 'is-card' : 'is-not');
      return;
    }

    steps.forEach((st, n) => {
      twinTimers.push(
        setTimeout(() => {
          const pos = digitPositions[st.index];
          const span = spans[pos];
          if (st.doubled && span) {
            const b = document.createElement('b');
            b.textContent = span.textContent;
            span.replaceWith(b);
            spans[pos] = b;
          }
          sumEl.textContent = `sum ${st.sum}`;
        }, 45 * n),
      );
    });

    twinTimers.push(
      setTimeout(() => {
        sumEl.textContent = `sum ${sum} · mod 10 = ${sum % 10}`;
        verdictEl.textContent = valid ? 'VALID CARD · REDACT' : 'NOT A CARD · LEAVE ALONE';
        verdictEl.classList.add(valid ? 'is-card' : 'is-not');
      }, 45 * steps.length + 120),
    );
    void kind;
  }

  function showTwins() {
    if (!twins) return;
    clearTwins();
    root.classList.add('twins-on');
    twins.setAttribute('aria-hidden', 'false');
    const [a, b] = twins.querySelectorAll('.twin');
    if (a) runChecksum(a, '4111 1111 1111 1111', 'card');
    if (b) twinTimers.push(setTimeout(() => runChecksum(b, '1234 5678 9012 3456', 'not'), 380));
  }

  function hideTwins() {
    if (!twins) return;
    clearTwins();
    root.classList.remove('twins-on');
    twins.setAttribute('aria-hidden', 'true');
  }

  function setStation(n) {
    if (n === current) return;
    current = n;

    for (let i = 1; i <= 5; i++) root.classList.toggle(`at-${i}`, i === n);

    // The values themselves. This is the substitution the caption describes.
    setRedacted(n >= 3);

    // The payload only exists once redaction has happened. Before that the
    // right-hand side is deliberately empty — there is nothing to show,
    // because nothing has been produced.
    if (payloadCode) {
      if (n >= 3 && n <= 4) renderTokens(payloadCode, PAYLOAD_SANITIZED);
      else if (n === 5) renderTokens(payloadCode, PAYLOAD_ACTION);
      else payloadCode.textContent = '';
    }

    // The gates light 240 ms apart, and only at the boundary.
    gates.forEach((g, i) => {
      g.classList.remove('is-open');
      if (n >= 4) setTimeout(() => g.classList.add('is-open'), 220 + i * 240);
    });

    if (n === 2) showTwins();
    else hideTwins();
  }

  // One observer per station. The band is deliberately narrow and centred, so
  // a station becomes current when it is genuinely the thing being read.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        // ADD only. Toggling meant a card faded back out the moment it left the
        // narrow trigger band — invisible on desktop, where one station fills
        // the screen, but on mobile the cards are ordinary stacked prose and
        // the band is smaller than the gap between them, so they blanked.
        e.target.classList.add('is-in');
        const n = Number(e.target.dataset.station);
        if (!Number.isNaN(n)) setStation(n);
      }
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
  );
  stations.forEach((s) => io.observe(s));

  // On small screens the stage is hidden and the cards are ordinary content,
  // so they should reveal on their own rather than waiting for a stage that
  // will never appear.
  const small = matchMedia('(max-width: 820px)');
  const applySmall = () => {
    if (small.matches) stations.forEach((s) => s.classList.add('is-in'));
  };
  applySmall();
  small.addEventListener('change', applySmall);
}
