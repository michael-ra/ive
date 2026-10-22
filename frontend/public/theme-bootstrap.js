// Same-origin, blocking pre-paint bootstrap: permitted by script-src 'self'.
// Keep preferences and colors in sync with src/lib/theme.js.
// The old ive-theme key is intentionally ignored; light is the default.
(function () {
  try {
    var t = localStorage.getItem('ive-theme.v2');
    if (t === 'system') {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } else if (t !== 'dark' && t !== 'light') {
      t = 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#FFFFFF' : '#0E1014');
  } catch (e) { /* :root light tokens remain the default */ }
})();
