/*
 * Sample Pharmacy: the practice site's own code.
 *
 * Each "scenario" wires up one well-known way that sites pass what you type to other
 * companies. The tracker libraries it loads are small imitations kept in ../third-party;
 * in a Khara Check sandbox run they are served from this machine and nothing reaches the
 * real companies.
 *
 *   store   everything below at once (the demo journey)
 *   f1      Meta Pixel "Search" event carrying the search text
 *   f2      GA4 "view_search_results" sent with navigator.sendBeacon
 *   f3      signup: SHA-256 of email and phone sent to Meta and Google Ads
 *   f4      CleverTap-style event, base64-encoded inside a JSON body
 *   f5      search text leaked through the Referer header to an unknown third party
 *   f6      clean: a tracker loads, but the search text never leaves the page
 *   f7      first party only: the site's own analytics receives the search text
 *   f8      double URL encoding and changed letter case (Google Ads, Criteo)
 *   r1      the three logged-in patterns from Khara Index Report 1, with made-up data:
 *             a Reddit-style pixel, loaded through a tag manager, picks the phone number
 *             out of the login form by itself ("automatic matching") and sends its hash
 *             with the name of the product on the page;
 *             Google Analytics gets a login event carrying a hash of +91 and the phone
 *             number with the search page address;
 *             Google Ads gets a hash of the email in "enhanced conversions" format
 *   cmp     a consent banner that is not respected:
 *             Meta Pixel fires before the visitor chooses anything,
 *             Google Analytics keeps sending after "Reject all",
 *             Criteo only fires after "Accept all" (the one tracker that behaves)
 */
(function () {
  var params = new URLSearchParams(location.search);
  var scenario = params.get('scenario') || sessionStorage.getItem('scenario') || 'store';
  sessionStorage.setItem('scenario', scenario);
  var page = document.body.getAttribute('data-page') || 'home';
  var on = function (name) { return scenario === 'store' || scenario === name; };

  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  // Keep the scenario through the search form and the signup link.
  var hidden = document.getElementById('scenario');
  if (hidden) hidden.value = scenario;
  var signupLink = document.getElementById('signup-link');
  if (signupLink) signupLink.href = '/signup.html?scenario=' + encodeURIComponent(scenario);

  // f6 keeps the search text out of the address bar entirely.
  var searchForm = document.getElementById('search-form');
  if (searchForm && scenario === 'f6') {
    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      sessionStorage.setItem('q', document.getElementById('q').value);
      location.href = '/search.html?scenario=f6';
    });
  }

  // ---- Consent banner (scenario cmp) -------------------------------------------------------

  var consent = null;
  try { consent = localStorage.getItem('consent'); } catch (e) {}
  if (scenario === 'cmp' && !consent) {
    var banner = document.createElement('div');
    banner.id = 'cmp';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie choices');
    banner.innerHTML =
      '<p><b>We value your privacy.</b> We use cookies and similar tools to improve your experience and show you relevant ads.</p>' +
      '<div><button type="button" id="cmp-reject" class="secondary">Reject all</button> ' +
      '<button type="button" id="cmp-accept">Accept all</button></div>';
    document.body.appendChild(banner);
    var decide = function (choice) {
      return function () {
        try { localStorage.setItem('consent', choice); } catch (e) {}
        consent = choice;
        banner.remove();
        if (choice === 'accepted') startCriteo();
      };
    };
    document.getElementById('cmp-accept').addEventListener('click', decide('accepted'));
    document.getElementById('cmp-reject').addEventListener('click', decide('rejected'));
  }

  // ---- Tracker setup, as a real site would paste it in -------------------------------------

  var ready = [];
  var cmp = scenario === 'cmp';
  var usesMeta = on('f1') || on('f6') || (on('f3') && page === 'signup') || cmp;
  var usesGtag = on('f2') || on('f8') || (on('f3') && page === 'signup') || cmp;
  if (usesMeta) {
    window.fbq = window.fbq || function () { (window.fbq.q = window.fbq.q || []).push(arguments); };
    ready.push(loadScript('https://connect.facebook.net/en_US/fbevents.js'));
  }
  if (usesGtag) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    ready.push(loadScript('https://www.googletagmanager.com/gtag/js?id=G-FIXTURE0001'));
  }
  if (on('f4')) {
    window.clevertap = { event: [], account: [{ id: 'TEST-FIX-TURE' }] };
    ready.push(loadScript('https://static.clevertap.com/js/clevertap.min.js'));
  }
  if (on('f8')) {
    window.criteo_q = window.criteo_q || [];
    ready.push(loadScript('https://static.criteo.net/js/ld/ld.js'));
  }
  if (scenario === 'store') {
    // Present on every page, but never handed anything the customer types.
    ready.push(loadScript('https://www.clarity.ms/tag/fixture0001'));
  }

  function startCriteo() {
    if (window.criteo_q && window.criteo_q.push !== Array.prototype.push) return;
    window.criteo_q = window.criteo_q || [];
    loadScript('https://static.criteo.net/js/ld/ld.js');
    if (page === 'search') {
      window.criteo_q.push({ event: 'setAccount', account: 54321 }, { event: 'viewList', keywords: params.get('q') || '' });
    }
  }
  if (cmp && consent === 'accepted') startCriteo();

  if (usesMeta && page !== 'signup') { fbq('init', '1234567890123456'); fbq('track', 'PageView'); }
  if (usesGtag) { gtag('js', new Date()); gtag('config', 'G-FIXTURE0001'); gtag('config', 'AW-987654321'); }

  // ---- Report 1 patterns (scenario r1) -----------------------------------------------------

  if (scenario === 'r1') {
    // The site itself only adds a tag manager container. The container loads the Reddit pixel.
    loadScript('https://www.googletagmanager.com/gtm.js?id=GTM-FIXTURE1');
    var loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var phone = document.getElementById('phone').value;
        var email = document.getElementById('email').value;
        fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: phone, email: email }) });
        try {
          localStorage.setItem('account', JSON.stringify({ id: 'acct-' + Math.floor(Math.random() * 1e9), phone: phone, email: email }));
        } catch (err) {}
        location.href = '/?scenario=r1';
      });
    }
    var account = null;
    try { account = JSON.parse(localStorage.getItem('account') || 'null'); } catch (err) {}
    if (account && page === 'search') {
      var term = params.get('q') || '';
      var sha256Hex = function (text) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
          return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        });
      };
      var sha256B64Url = function (text) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
          var bin = ''; new Uint8Array(buf).forEach(function (b) { bin += String.fromCharCode(b); });
          return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        });
      };
      // Apollo-style: a GA4 "login_completed" event with a hashed mobile number and the page address.
      sha256Hex('+91' + account.phone).then(function (mobile) {
        var body = 'en=login_completed&ep.mobile=' + mobile + '&uid=' + encodeURIComponent(account.id);
        navigator.sendBeacon('https://analytics.google.com/g/collect?v=2&tid=G-FIXTURE0002&cid=1.2&dl=' + encodeURIComponent(location.href), body);
      });
      // MedPlus-style: Google Ads "enhanced conversions" page_view with a hashed email, no page address.
      sha256B64Url(account.email.trim().toLowerCase()).then(function (em) {
        new Image().src = 'https://www.google.com/pagead/form-data/987654321?gtm=45be&en=page_view&ec_mode=a&em=' + encodeURIComponent('tv.1~em.' + em);
      });
      // Metropolis-style: the page tells the Reddit pixel which product is on screen.
      window.rdt = window.rdt || function () { (window.rdt.q = window.rdt.q || []).push(arguments); };
      rdt('track', 'ViewContent', { products: [{ id: 'T-101', name: term + ' test', category: 'lab test' }] });
    }
  }

  // ---- Search results ----------------------------------------------------------------------

  if (page === 'search') {
    var q = scenario === 'f6' ? (sessionStorage.getItem('q') || '') : (params.get('q') || '');
    document.getElementById('term').textContent = q;
    document.getElementById('q').value = q;
    document.getElementById('result-1').textContent = q + ' tablet';
    document.getElementById('result-2').textContent = q + ' SR tablet';

    if (on('f1') || cmp) fbq('track', 'Search', { search_string: q, content_category: 'medicines' });
    if (on('f2') || cmp) gtag('event', 'view_search_results', { search_term: q });
    if (on('f4')) clevertap.event.push('Searched', { Term: q, Results: 2 });
    if (on('f5')) {
      // A partner pixel that asks the browser to send the full page address as the Referer.
      var img = new Image();
      img.referrerPolicy = 'unsafe-url';
      img.src = 'https://pixel.adpartner-sample.example/t.gif?pid=77&ev=pageview';
    }
    if (on('f7')) {
      navigator.sendBeacon('/api/analytics', JSON.stringify({ event: 'search', term: q, results: 2 }));
    }
    if (on('f8')) {
      gtag('event', 'view_search_results', { send_to: 'AW-987654321', search_term: q.toUpperCase() });
      var mixed = q.split('').map(function (c, i) { return i % 2 ? c.toUpperCase() : c.toLowerCase(); }).join('');
      window.criteo_q.push({ event: 'setAccount', account: 54321 }, { event: 'viewList', keywords: mixed });
    }
  }

  // ---- Signup ------------------------------------------------------------------------------

  var signupForm = document.getElementById('signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('email').value;
      var phone = document.getElementById('phone').value;
      // The site's own server gets the details, as you would expect.
      fetch('/api/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, phone: phone }),
        keepalive: true
      });
      if (on('f3')) {
        // "Advanced matching": the libraries hash the email and phone and send the hashes.
        fbq('init', '1234567890123456', { em: email, ph: '91' + phone });
        fbq('track', 'CompleteRegistration');
        gtag('set', 'user_data', { email: email, phone_number: '+91' + phone });
        gtag('event', 'conversion', { send_to: 'AW-987654321/AbC-D_efG-h12_34-567' });
      }
      signupForm.hidden = true;
      document.getElementById('done').hidden = false;
    });
  }
})();
