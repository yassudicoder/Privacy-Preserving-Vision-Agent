/* Multi-page offline storefront for real agent-loop testing. */
'use strict';

var SHOP_PRODUCTS = [
  { id: 'macbook-pro', name: 'MacBook Pro 14', price: '₹1,69,999', image: 'images/product-laptop.png', desc: 'Apple laptop with M-series performance, 16 GB memory and 512 GB SSD.', keywords: ['macbook', 'mac', 'laptop', 'apple', 'pro'] },
  { id: 'gaming-laptop', name: 'Gaming Laptop X', price: '₹1,59,999', image: 'images/product-gaming-laptop.png', desc: 'High-refresh gaming laptop with discrete graphics and 32 GB RAM.', keywords: ['gaming', 'laptop', 'computer'] },
  { id: 'pixel-phone', name: 'Pixel Phone 9', price: '₹74,999', image: 'images/product-phone.png', desc: 'Flagship phone with OLED display, 5G and a triple camera.', keywords: ['phone', 'mobile', 'pixel', 'android'] },
  { id: 'quiet-headphones', name: 'Quiet Wireless Headphones', price: '₹12,499', image: 'images/product-headphones.png', desc: 'Over-ear noise cancelling headphones with a 40-hour battery.', keywords: ['headphones', 'audio', 'wireless'] }
];

function shopProduct(id) { return SHOP_PRODUCTS.find(function (p) { return p.id === id; }) || null; }
function shopQuery() { return new URLSearchParams(location.search).get('q') || ''; }
function shopMatches(q) {
  var terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(function (x) { return x.length > 1; });
  return SHOP_PRODUCTS.filter(function (p) {
    var hay = (p.name + ' ' + p.desc + ' ' + p.keywords.join(' ')).toLowerCase();
    return terms.length > 0 && terms.every(function (term) { return hay.includes(term); });
  });
}
function shopCart() { try { return JSON.parse(localStorage.getItem('sih-shop-cart') || '[]'); } catch (_) { return []; } }
function saveShopCart(cart) { localStorage.setItem('sih-shop-cart', JSON.stringify(cart)); }
function addShopCart(id) { var cart = shopCart(); cart.push(id); saveShopCart(cart); }
function cartCount() { return shopCart().length; }
function text(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }
function header() {
  var count = document.getElementById('shop-cart-count');
  if (count) count.textContent = String(cartCount());
  var form = document.getElementById('shop-search-form');
  if (form) form.addEventListener('submit', function (event) {
    event.preventDefault();
    var q = document.getElementById('shop-search').value.trim();
    if (q) location.href = '/search.html?q=' + encodeURIComponent(q);
  });
}
function productCard(product) {
  var article = document.createElement('article');
  article.className = 'shop-product-card';
  article.innerHTML = '<img src="' + product.image + '" alt="' + product.name + ' product" width="240" height="180">' +
    '<div class="shop-card-copy"><p class="shop-kicker">Featured product</p>' +
    '<h2><a href="/product.html?id=' + product.id + '">' + product.name + '</a></h2>' +
    '<p class="shop-price">' + product.price + '</p><p>' + product.desc + '</p>' +
    '<div class="shop-actions"><a class="shop-button secondary" href="/product.html?id=' + product.id + '">View product ' + product.name + '</a>' +
    '<button class="shop-button" type="button" data-add="' + product.id + '" aria-label="Add ' + product.name + ' to cart">Add to cart</button></div></div>';
  return article;
}
function wireAddButtons() {
  document.querySelectorAll('[data-add]').forEach(function (button) {
    button.addEventListener('click', function () {
      addShopCart(button.getAttribute('data-add'));
      button.textContent = 'Added to cart';
      button.setAttribute('aria-label', 'Added to cart');
      header();
    });
  });
}
function renderSearch() {
  var q = shopQuery();
  var results = shopMatches(q);
  text('search-query', q);
  var box = document.getElementById('shop-results');
  results.forEach(function (product) { box.appendChild(productCard(product)); });
  if (results.length === 0) box.innerHTML = '<p>No products found. Try macbook, laptop or headphones.</p>';
  wireAddButtons();
}
function renderProduct() {
  var product = shopProduct(new URLSearchParams(location.search).get('id')) || SHOP_PRODUCTS[0];
  document.title = product.name + ' | SIH Shop';
  text('product-name', product.name); text('product-price', product.price); text('product-description', product.desc);
  var image = document.getElementById('product-image'); image.src = product.image; image.alt = product.name + ' product';
  var add = document.getElementById('product-add');
  add.setAttribute('aria-label', 'Add ' + product.name + ' to cart');
  add.addEventListener('click', function () { addShopCart(product.id); add.textContent = 'Added to cart'; header(); });
}
function renderCart() {
  var box = document.getElementById('cart-items');
  var ids = shopCart();
  if (ids.length === 0) { box.innerHTML = '<p>Your cart is empty.</p>'; return; }
  ids.forEach(function (id) { var p = shopProduct(id); if (p) { var row = document.createElement('article'); row.className = 'cart-item'; row.innerHTML = '<img src="' + p.image + '" alt="' + p.name + ' product" width="120" height="90"><div><h2>' + p.name + '</h2><p>' + p.price + '</p></div>'; box.appendChild(row); } });
  document.getElementById('checkout-link').hidden = false;
}
function initShop() {
  header();
  if (location.pathname.endsWith('/search.html')) renderSearch();
  if (location.pathname.endsWith('/product.html')) renderProduct();
  if (location.pathname.endsWith('/cart.html')) renderCart();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initShop); else initShop();
