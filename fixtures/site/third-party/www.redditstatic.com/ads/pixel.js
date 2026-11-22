/*
 * Imitation of a Reddit-style ad pixel with "automatic matching" switched on, written for Khara Check's
 * practice site. Not Reddit's code. It reproduces the request shape Khara Index recorded in Report 1:
 * a GET to https://alb.reddit.com/rp.gif with event details in m.* parameters and a hashed phone
 * number in auto_pn, picked up from any phone field the page shows, without the site passing it.
 */
(function () {
  var queue = (window.rdt && window.rdt.q) || [];
  var KEY = 'rdt_auto_pn';

  function sha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function remember(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 10) return;
    sha256('+91' + digits.slice(-10)).then(function (h) { try { localStorage.setItem(KEY, h); } catch (e) {} });
  }
  // Automatic matching: watch every phone field on every page.
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && (t.type === 'tel' || /phone|mobile/i.test(t.name || ''))) remember(t.value);
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && (t.type === 'tel' || /phone|mobile/i.test(t.name || ''))) remember(t.value);
  }, true);

  function send(event, data) {
    var p = new URLSearchParams();
    p.set('ts', String(Date.now()));
    p.set('id', 't2_fixture');
    p.set('event', event);
    var products = (data && data.products) || [];
    if (products.length) {
      p.set('m.itemCount', String(products.length));
      p.set('m.products', products.map(function (x) { return x.name; }).join(','));
    }
    var pn = null;
    try { pn = localStorage.getItem(KEY); } catch (e) {}
    if (pn) p.set('auto_pn', pn);
    p.set('integration', 'gtm');
    new Image().src = 'https://alb.reddit.com/rp.gif?' + p.toString();
  }

  function handle(args) {
    if (args[0] === 'track') send(args[1], args[2]);
  }
  window.rdt = function () { handle(arguments); };
  queue.forEach(handle);
  send('PageVisit', {});
})();
