/*
 * Imitation of a Criteo-style loader, written for Khara Check's practice site. It is not Criteo's code.
 * Events are packed as "e=<event>&kw=<keywords>", then URL-encoded again inside the p0 parameter,
 * so the value ends up URL-encoded twice.
 */
(function () {
  var account = null;
  function handle(item) {
    if (item.event === 'setAccount') { account = item.account; return; }
    if (item.event === 'viewList') {
      var inner = 'e=vl&kw=' + encodeURIComponent(item.keywords);
      new Image().src = 'https://sslwidget.criteo.com/event?a=' + account + '&v=5.9.0&p0=' + encodeURIComponent(inner) + '&dc=1';
    }
  }
  var queued = window.criteo_q || [];
  window.criteo_q = { push: function () { for (var i = 0; i < arguments.length; i++) handle(arguments[i]); } };
  queued.forEach(handle);
})();
