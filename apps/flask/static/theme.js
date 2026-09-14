/**
 * Dark-Mode-Schalter.
 *
 * Die Klasse setzt bereits das Inline-Skript im <head>, VOR dem ersten Paint.
 * Hier geht es nur noch um das Umschalten und das Merken.
 */
(function () {
  var knopf = document.querySelector('.theme-toggle');
  if (!knopf) return;

  function zeichen() {
    var dunkel = document.documentElement.classList.contains('dark');
    knopf.textContent = dunkel ? '☀' : '☾';
    knopf.setAttribute('aria-label', dunkel ? 'Switch to light' : 'Switch to dark');
  }

  knopf.addEventListener('click', function () {
    var dunkel = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dunkel);
    try {
      localStorage.setItem('theme', dunkel ? 'dark' : 'light');
    } catch (e) {
      // Privates Fenster oder gesperrte Site-Daten: die Auswahl gilt fuer
      // diese Sitzung, mehr ist hier nicht zu retten.
    }
    zeichen();
  });

  zeichen();
})();
