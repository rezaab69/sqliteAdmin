// Applied before first paint to avoid a flash of the wrong theme.
(function () {
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('sqla:theme')); } catch (e) { /* ignore */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
}());
