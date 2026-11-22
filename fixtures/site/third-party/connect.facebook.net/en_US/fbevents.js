/*
 * Imitation of the Meta Pixel library, written for Khara Check's practice site.
 * It is not Meta's code. It reproduces the publicly documented request shape:
 * a GET to https://www.facebook.com/tr/ with id, ev, dl, cd[...] and ud[...] parameters.
 */
(function () {
  var queue = (window.fbq && window.fbq.q) || [];
  var pixelId = null;
  var userData = {};
  var fbp = 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10);

  function sha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  var chain = Promise.resolve();
  function handle(args) {
    chain = chain.then(function () {
      var command = args[0];
      if (command === 'init') {
        pixelId = args[1];
        var raw = args[2] || {};
        return Promise.all(Object.keys(raw).map(function (key) {
          return sha256(String(raw[key]).trim().toLowerCase()).then(function (hash) { userData[key] = hash; });
        }));
      }
      if (command === 'track' || command === 'trackCustom') {
        var p = new URLSearchParams();
        p.set('id', pixelId);
        p.set('ev', args[1]);
        p.set('dl', location.href);
        p.set('rl', document.referrer);
        p.set('if', 'false');
        p.set('ts', String(Date.now()));
        var custom = args[2] || {};
        Object.keys(custom).forEach(function (key) { p.set('cd[' + key + ']', custom[key]); });
        Object.keys(userData).forEach(function (key) { p.set('ud[' + key + ']', userData[key]); });
        p.set('sw', String(screen.width));
        p.set('sh', String(screen.height));
        p.set('v', '2.9.999');
        p.set('r', 'stable');
        p.set('fbp', fbp);
        new Image().src = 'https://www.facebook.com/tr/?' + p.toString();
      }
    });
  }

  window.fbq = function () { handle(arguments); };
  window.fbq.loaded = true;
  queue.forEach(handle);
})();
