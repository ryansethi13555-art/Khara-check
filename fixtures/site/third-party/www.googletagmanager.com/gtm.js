/*
 * Imitation of a Google Tag Manager container, written for Khara Check's practice site. Not Google's code.
 * A real container can load any number of other companies' scripts. This one loads a Reddit-style pixel.
 */
(function () {
  var s = document.createElement('script');
  s.src = 'https://www.redditstatic.com/ads/pixel.js';
  s.async = true;
  document.head.appendChild(s);
})();
