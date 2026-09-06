/*
 * SIH26171 Agent Test Lab - behaviour.
 *
 * Plain ES2020, no modules, no build, no dependencies, no network. Every
 * handler mutates the page and nothing else.
 *
 * Three things in here exist because of how the extension reads a page. They
 * are affordances of the TEST LAB, not fixes to the extension, and each is
 * marked with WHY:
 *
 *   1. Attribute mirroring. redaction/dom-scan.ts reads form state through
 *      getAttribute('value') and hasAttribute('checked') - the ATTRIBUTES, not
 *      the properties. A value typed by the agent updates only the property, so
 *      on an ordinary page the next snapshot still shows the field empty and a
 *      loop cannot see its own work. Mirroring property back to attribute makes
 *      each step observable. See README, "What this page does for the agent".
 *
 *   2. preventDefault on every submit. executeAction's `type` with submit:true
 *      calls form.requestSubmit(). A real navigation would reload the page and
 *      fire tabs.onUpdated, which detaches the pinned tab and kills the run.
 *
 *   3. No control is ever added to or removed from the page by these handlers,
 *      except search results and review items, which are text only. Elements are
 *      addressed by ordinal ref (e1, e2, ...); inserting a button mid-page
 *      renumbers every ref after it.
 */

'use strict';

// ---------------------------------------------------------------- catalogue

/** The whole "database". Fake, static, in memory. */
var PRODUCTS = [
  {
    id: 'product-laptop',
    photo: 'product-laptop.png',
    reviewer: 'portrait-a.png',
    name: 'Laptop Pro',
    price: '₹1,29,999',
    desc: '14-inch aluminium laptop. 16 GB RAM, 512 GB SSD, 18-hour battery.',
    keywords: ['laptop', 'pro', 'computer', 'notebook', 'macbook', 'ultrabook']
  },
  {
    id: 'product-gaming-laptop',
    photo: 'product-gaming-laptop.png',
    reviewer: 'portrait-c.png',
    name: 'Gaming Laptop',
    price: '₹1,59,999',
    desc: 'Discrete graphics, 240 Hz display, 32 GB RAM, mechanical keyboard.',
    keywords: ['laptop', 'gaming', 'computer', 'game', 'graphics']
  },
  {
    id: 'product-smartphone-x',
    photo: 'product-phone.png',
    name: 'Smartphone X',
    price: '₹74,999',
    desc: '6.7-inch OLED, 256 GB storage, triple rear camera, 5G.',
    keywords: ['smartphone', 'phone', 'mobile', 'android', 'camera']
  },
  {
    id: 'product-headphones',
    photo: 'product-headphones.png',
    name: 'Wireless Headphones',
    price: '₹12,499',
    desc: 'Over-ear, active noise cancelling, 40-hour battery, USB-C.',
    keywords: ['headphones', 'headphone', 'audio', 'wireless', 'earphones', 'music']
  },
  {
    id: 'product-monitor',
    name: 'Monitor 27"',
    price: '₹34,999',
    desc: '27-inch 4K IPS panel, USB-C single-cable docking, height adjustable.',
    keywords: ['monitor', 'display', 'screen', '4k', 'ips']
  }
];

var SECTION_LABELS = {
  'section-search': 'Home',
  'section-products': 'Products',
  'section-profile': 'Profile',
  'section-payment': 'Checkout'
};

/*
 * Fields whose typed text the console records as a length instead of as text.
 * This is console hygiene - it stops a password appearing as fresh plain text
 * elsewhere in the DOM. It is NOT a redaction system; the extension owns that.
 */
var MASKED_FIELD_IDS = ['login-password', 'card-number', 'card-cvv'];

// ------------------------------------------------------------------ helpers

function $(id) {
  return document.getElementById(id);
}

function text(id, value) {
  var el = $(id);
  if (el !== null) el.textContent = value;
}

/** Replace a status line's text and its state class in one call. */
function status(id, value, tone) {
  var el = $(id);
  if (el === null) return;
  el.textContent = value;
  el.className = 'status' + (tone ? ' ' + tone : '');
}

// -------------------------------------------------- console (observer only)

var consoleState = {
  task: '—',
  lastAction: '—',
  execution: '—',
  pageState: 'Idle',
  events: []
};

var MAX_EVENTS = 40;

function renderConsole() {
  text('console-task', consoleState.task);
  text('console-last-action', consoleState.lastAction);
  text('console-page-state', consoleState.pageState);

  var exec = $('console-execution');
  if (exec !== null) {
    exec.textContent = consoleState.execution;
    exec.className =
      consoleState.execution === 'SUCCESS'
        ? 'ok'
        : consoleState.execution === 'PENDING'
          ? 'pending'
          : '';
  }

  var list = $('console-events');
  if (list === null) return;
  list.textContent = '';
  for (var i = 0; i < consoleState.events.length; i++) {
    var li = document.createElement('li');
    li.textContent = consoleState.events[i];
    list.appendChild(li);
  }
}

function logEvent(line) {
  consoleState.events.unshift('✓ ' + line);
  if (consoleState.events.length > MAX_EVENTS) {
    consoleState.events.length = MAX_EVENTS;
  }
  renderConsole();
}

/**
 * Record an observed interaction.
 *
 * `execution` is PENDING for anything that only changed a value and SUCCESS
 * once a handler actually changed page state. The console never reports SUCCESS
 * for something it did not watch happen.
 */
function observe(action, execution, pageState) {
  consoleState.lastAction = action;
  if (execution) consoleState.execution = execution;
  if (pageState) consoleState.pageState = pageState;
  renderConsole();
}

function setTask(task) {
  consoleState.task = task;
  renderConsole();
}

// ------------------------------------------------------- attribute mirroring

/*
 * WHY: see the header comment, point 1. Keeps the serialised DOM honest about
 * current form state so the extension's next snapshot reflects what just
 * happened on the page.
 */
function mirrorValue(el) {
  if (el.tagName === 'TEXTAREA') {
    el.textContent = el.value;
    return;
  }
  if (el.tagName === 'SELECT') {
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      if (opt.selected) opt.setAttribute('selected', 'selected');
      else opt.removeAttribute('selected');
    }
    return;
  }
  if (el.type === 'checkbox' || el.type === 'radio') {
    if (el.checked) el.setAttribute('checked', 'checked');
    else el.removeAttribute('checked');
    // A radio turning on turns its group mates off, and only the clicked
    // element gets a change event - so the rest have to be swept here.
    if (el.type === 'radio' && el.name) {
      var group = document.querySelectorAll(
        'input[type="radio"][name="' + el.name + '"]'
      );
      for (var g = 0; g < group.length; g++) {
        if (group[g] !== el) group[g].removeAttribute('checked');
      }
    }
    return;
  }
  el.setAttribute('value', el.value);
}

// -------------------------------------------------------------------- search

function renderResults(query, matches) {
  var box = $('search-results');
  box.textContent = '';

  if (matches.length === 0) {
    var none = document.createElement('p');
    none.className = 'result-item';
    none.textContent =
      'No products matched "' + query + '". Try laptop, phone, headphones or monitor.';
    box.appendChild(none);
    return;
  }

  for (var i = 0; i < matches.length; i++) {
    var p = matches[i];
    var item = document.createElement('div');
    item.className = 'result-item';
    item.setAttribute('data-result', p.id);

    /*
     * The product photo, and for some products a reviewer's picture.
     *
     * The photos are face-detector CONTROLS - a search for "laptop" must show
     * them and produce zero boxes. The reviewer picture is the opposite: its alt
     * text says "Verified buyer", which matches none of the IMG_VISUAL_RULES
     * patterns, so the DOM scan cannot tell there is a person in it. If the panel
     * reports a face on a search for laptops, that detection came from the model
     * and from nowhere else.
     */
    if (p.photo) {
      var photo = document.createElement('img');
      photo.className = 'result-photo';
      photo.src = 'images/' + p.photo;
      photo.width = 160;
      photo.height = 120;
      photo.alt = p.name;
      item.appendChild(photo);
    }
    if (p.reviewer) {
      var rev = document.createElement('img');
      rev.className = 'result-reviewer';
      rev.src = 'images/' + p.reviewer;
      rev.width = 56;
      rev.height = 56;
      rev.alt = 'Verified buyer';
      item.appendChild(rev);
    }

    var h = document.createElement('h3');
    h.textContent = p.name;
    var price = document.createElement('p');
    price.className = 'price';
    price.textContent = p.price;
    var desc = document.createElement('p');
    desc.textContent = p.desc;

    item.appendChild(h);
    item.appendChild(price);
    item.appendChild(desc);
    box.appendChild(item);
  }
}

function matchProducts(query) {
  var q = query.toLowerCase().trim();
  if (q === '') return [];
  var terms = q.split(/[^a-z0-9]+/).filter(function (t) {
    return t.length > 1;
  });
  if (terms.length === 0) terms = [q];

  return PRODUCTS.filter(function (p) {
    var hay = (p.name + ' ' + p.desc + ' ' + p.keywords.join(' ')).toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) !== -1) return true;
    }
    return false;
  });
}

function runSearch(event) {
  event.preventDefault();
  var input = $('search-input');
  var query = input.value.trim();

  if (query === '') {
    status('search-status', 'Enter something to search for.', 'warn');
    renderResults('', []);
    observe('SUBMIT → search-form (empty)', 'PENDING', 'Search rejected: empty query');
    logEvent('Search submitted with an empty query');
    return;
  }

  // The storefront path exercises real navigation and persistent cart state.
  // The older in-page result rendering remains below as a fallback for the
  // original lab scenarios, but normal searches use the multi-page flow.
  location.href = '/search.html?q=' + encodeURIComponent(query);
  return;

  var matches = matchProducts(query);
  status('search-status', 'Search results for: ' + query, 'ok');
  renderResults(query, matches);

  setTask('Search for ' + query);
  observe(
    'SUBMIT → search-form → "' + query + '"',
    'SUCCESS',
    'Search submitted (' + matches.length + ' result(s))'
  );
  logEvent('Search form submitted');
  logEvent('Results updated: ' + matches.length + ' product(s) for "' + query + '"');
}

// ------------------------------------------------------------------ products

var cart = [];

function productById(id) {
  for (var i = 0; i < PRODUCTS.length; i++) {
    if (PRODUCTS[i].id === id) return PRODUCTS[i];
  }
  return null;
}

function viewProduct(product) {
  text('product-details-title', product.name);
  text(
    'product-details-body',
    product.price + ' — ' + product.desc + ' In stock, ships in 2 days.'
  );
  setTask('Open ' + product.name);
  observe(
    'CLICK → view details → ' + product.name,
    'SUCCESS',
    'Product details opened: ' + product.name
  );
  logEvent('Product details updated: ' + product.name);
}

function addToCart(product) {
  cart.push(product.name);
  text('cart-count', String(cart.length));
  text('cart-contents', cart.join(', '));
  setTask('Add ' + product.name + ' to cart');
  observe(
    'CLICK → add to cart → ' + product.name,
    'SUCCESS',
    'Cart: ' + cart.length + ' item(s)'
  );
  logEvent('Cart updated: ' + product.name + ' added (' + cart.length + ' total)');
}

function wireProducts() {
  var cards = document.querySelectorAll('.product');
  for (var i = 0; i < cards.length; i++) {
    (function (card) {
      var product = productById(card.id);
      if (product === null) return;
      var view = card.querySelector('.view-btn');
      var add = card.querySelector('.add-btn');
      if (view !== null) {
        view.addEventListener('click', function () {
          viewProduct(product);
        });
      }
      if (add !== null) {
        add.addEventListener('click', function () {
          addToCart(product);
        });
      }
    })(cards[i]);
  }
}

// --------------------------------------------------------------------- login

/*
 * Entirely local. There is no fetch, no XHR, no form action and no method.
 * The password is compared in memory against a constant and then forgotten.
 */
var TEST_ACCOUNT = { email: 'test.user@example.com', password: 'TestPass123!' };

function runLogin(event) {
  event.preventDefault();
  var email = $('login-email').value.trim();
  var password = $('login-password').value;

  if (email === '' || password === '') {
    status('login-status', 'Enter both an email and a password.', 'warn');
    observe('SUBMIT → login-form (incomplete)', 'PENDING', 'Login rejected: missing field');
    logEvent('Login submitted with a missing field');
    return;
  }

  var ok = email === TEST_ACCOUNT.email && password === TEST_ACCOUNT.password;
  setTask('Login with the test account');

  if (ok) {
    status('login-status', 'Signed in as ' + email + ' (fake session, nothing left this page).', 'ok');
    observe('SUBMIT → login-form', 'SUCCESS', 'Signed in (test account)');
    logEvent('Login succeeded for the test account');
  } else {
    status('login-status', 'Those are not the test credentials. Nothing was sent anywhere.', 'warn');
    observe('SUBMIT → login-form', 'SUCCESS', 'Login rejected: wrong test credentials');
    logEvent('Login rejected: credentials did not match the test account');
  }
}

// ------------------------------------------------------------------- payment

/*
 * Deliberately not a validator. It reports whether the four fields are filled
 * and says, out loud, that nothing was transmitted. No digits are echoed.
 */
function checkPayment() {
  var ids = ['card-name', 'card-number', 'card-expiry', 'card-cvv'];
  var missing = [];
  for (var i = 0; i < ids.length; i++) {
    if ($(ids[i]).value.trim() === '') missing.push(ids[i]);
  }

  if (missing.length > 0) {
    status('payment-status', 'Incomplete: ' + missing.join(', ') + '. Nothing was sent.', 'warn');
    observe('CLICK → payment-check', 'SUCCESS', 'Payment form incomplete');
    logEvent('Payment check ran: ' + missing.length + ' field(s) empty');
    return;
  }

  status('payment-status', 'All four fields are filled. TEST DATA - nothing was sent anywhere.', 'ok');
  observe('CLICK → payment-check', 'SUCCESS', 'Payment form complete (local check only)');
  logEvent('Payment check ran: all fields present, no request made');
}

// -------------------------------------------------------------------- review

function submitReview(event) {
  event.preventDefault();
  var area = $('review-textarea');
  var body = area.value.trim();

  if (body === '') {
    status('review-status', 'Write something before submitting.', 'warn');
    observe('SUBMIT → review-form (empty)', 'PENDING', 'Review rejected: empty');
    logEvent('Review submitted while empty');
    return;
  }

  var li = document.createElement('li');
  li.textContent = body;
  $('review-list').appendChild(li);

  area.value = '';
  mirrorValue(area);

  status('review-status', 'Review posted.', 'ok');
  setTask('Write a review');
  observe('SUBMIT → review-form → "' + body + '"', 'SUCCESS', 'Review posted');
  logEvent('Review posted: "' + body + '"');
}

// ------------------------------------------------------- select, checks, radios

function onCountryChange() {
  var sel = $('country-select');
  var value = sel.value === '' ? 'none' : sel.value;
  text('country-selected', value);

  if (sel.value !== '') setTask('Select ' + sel.value + ' as country');
  observe(
    'SELECT → country-select → "' + value + '"',
    'SUCCESS',
    'Country selected: ' + value
  );
  logEvent('Country changed to ' + value);
}

function preferencesSummary() {
  var terms = $('terms-checkbox').checked ? 'yes' : 'no';
  var news = $('newsletter-checkbox').checked ? 'yes' : 'no';
  var radios = document.querySelectorAll('input[name="paymethod"]');
  var method = 'none';
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) method = radios[i].value;
  }
  return 'terms ' + terms + ', newsletter ' + news + ', payment method ' + method;
}

function onPreferenceChange(el) {
  var summary = preferencesSummary();
  text('preferences-status', summary);

  var label = el.id;
  var state = el.checked ? 'on' : 'off';

  if (el.id === 'terms-checkbox' && el.checked) setTask('Enable the terms checkbox');
  observe(
    (el.type === 'radio' ? 'CLICK (radio) → ' : 'CLICK (checkbox) → ') + label + ' → ' + state,
    'SUCCESS',
    'Preferences: ' + summary
  );
  logEvent(label + ' turned ' + state);
}

// ---------------------------------------------------------------- navigation

function goToSection(sectionId, source) {
  var target = $(sectionId);
  if (target === null) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });

  var label = SECTION_LABELS[sectionId] || sectionId;
  text('current-section', label);

  var buttons = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < buttons.length; i++) {
    var isCurrent = buttons[i].getAttribute('data-target') === sectionId;
    // aria-current is a real attribute, so the extension sees the active tab
    // in its snapshot rather than only in the pixels.
    if (isCurrent) buttons[i].setAttribute('aria-current', 'true');
    else buttons[i].removeAttribute('aria-current');
  }

  setTask('Go to the ' + label.toLowerCase());
  observe('CLICK → ' + source + ' → ' + label, 'SUCCESS', 'Current section: ' + label);
  logEvent('Navigated to ' + label);
}

function wireNav() {
  var buttons = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < buttons.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        goToSection(btn.getAttribute('data-target'), btn.id);
      });
    })(buttons[i]);
  }
  $('nav-home').setAttribute('aria-current', 'true');
}

// ------------------------------------------------- global observation wiring

/*
 * One capture-phase listener per event type, on the document. It sees changes
 * made by a human and changes made by the extension identically, because
 * executeAction dispatches bubbling `input` and `change` events after writing a
 * value for exactly this reason.
 */
function wireObservers() {
  document.addEventListener(
    'input',
    function (e) {
      var el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (!('value' in el)) return;

      mirrorValue(el);

      var shown = MASKED_FIELD_IDS.indexOf(el.id) !== -1
        ? '(' + String(el.value.length) + ' chars, not shown)'
        : '"' + String(el.value) + '"';

      observe('TYPE → ' + (el.id || el.tagName.toLowerCase()) + ' → ' + shown, 'PENDING');
      logEvent((el.id || el.tagName.toLowerCase()) + ' changed');
    },
    true
  );

  document.addEventListener(
    'change',
    function (e) {
      var el = e.target;
      if (!(el instanceof HTMLElement)) return;
      mirrorValue(el);

      if (el.id === 'country-select') {
        onCountryChange();
        return;
      }
      if (el.type === 'checkbox' || el.type === 'radio') {
        onPreferenceChange(el);
      }
    },
    true
  );

  document.addEventListener(
    'submit',
    function (e) {
      // Every form on this page is handled in-page. A form that reached the
      // browser's default submit would reload and detach the agent's tab.
      if (e.target && e.target.tagName === 'FORM') logEvent(e.target.id + ' submit fired');
    },
    true
  );
}

// ---------------------------------------------------------------------- boot

function init() {
  $('search-form').addEventListener('submit', runSearch);
  $('login-form').addEventListener('submit', runLogin);
  $('review-form').addEventListener('submit', submitReview);
  $('payment-form').addEventListener('submit', function (e) {
    // The payment form has no submit button, but Enter in a text field still
    // submits a form. Swallow it; the local check is an explicit click.
    e.preventDefault();
  });
  $('payment-check').addEventListener('click', checkPayment);

  wireProducts();
  wireNav();
  wireObservers();

  $('console-clear').addEventListener('click', function () {
    consoleState.events = [];
    consoleState.task = '—';
    consoleState.lastAction = '—';
    consoleState.execution = '—';
    consoleState.pageState = 'Idle';
    renderConsole();
  });

  // The pre-filled login and payment values live in HTML attributes already, so
  // the first snapshot the extension takes has PII to find without anyone
  // touching the page.
  renderConsole();
  logEvent('Test lab ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
