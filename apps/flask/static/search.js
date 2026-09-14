/*
 * Volltextsuche im Browser.
 *
 * Der Index kommt einmal als JSON und wird danach lokal durchsucht: bei einem
 * Blog dieser Groesse ist das schneller als jeder Serveraufruf und braucht
 * keinen Suchdienst. Ab einigen tausend Beitraegen waere ein Index-Dienst die
 * richtige Antwort.
 */
(function () {
  var feld = document.getElementById('q');
  var liste = document.getElementById('treffer');
  var anzahl = document.getElementById('anzahl');
  var leer = document.getElementById('leer');
  if (!feld) return;

  var index = null;

  fetch('/search-index.json')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      index = d;
      feld.disabled = false;
      feld.placeholder = 'Search articles…';
      feld.focus();
    })
    .catch(function () {
      // Ein kaputter Index macht das Feld nicht benutzbar: es als bedienbar
      // anzuzeigen waere die schlechtere Auskunft.
      index = [];
      feld.placeholder = 'Search unavailable';
    });

  feld.addEventListener('input', function () {
    var q = feld.value.trim().toLowerCase();
    liste.innerHTML = '';
    if (!q || !index) {
      anzahl.hidden = true;
      leer.hidden = true;
      return;
    }

    // Jedes Wort muss vorkommen, irgendwo: "trademark research" findet auch
    // einen Artikel, der die beiden Woerter getrennt fuehrt.
    var woerter = q.split(/\s+/);
    var treffer = index
      .map(function (e) {
        var heu = (
          e.title + ' ' + e.description + ' ' + e.category + ' ' +
          e.tags.join(' ') + ' ' + e.body
        ).toLowerCase();
        for (var i = 0; i < woerter.length; i++) {
          if (heu.indexOf(woerter[i]) === -1) return null;
        }
        // Titeltreffer wiegen schwerer als Fundstellen im Fliesstext.
        var punkte = 1;
        woerter.forEach(function (w) {
          if (e.title.toLowerCase().indexOf(w) !== -1) punkte += 3;
          if (e.description.toLowerCase().indexOf(w) !== -1) punkte += 2;
        });
        return { e: e, punkte: punkte };
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.punkte - a.punkte; });

    anzahl.hidden = false;
    anzahl.textContent = treffer.length + ' result' + (treffer.length === 1 ? '' : 's');
    leer.hidden = treffer.length > 0;

    treffer.forEach(function (t) {
      // Ueber textContent, nicht innerHTML: der Index traegt Artikeltext, und
      // der gehoert hier nicht als Markup interpretiert.
      var li = document.createElement('li');
      li.className = 'post-card';

      var h = document.createElement('h2');
      var a = document.createElement('a');
      a.href = t.e.url;
      a.textContent = t.e.title;
      h.appendChild(a);
      li.appendChild(h);

      if (t.e.description) {
        var p = document.createElement('p');
        p.textContent = t.e.description;
        li.appendChild(p);
      }

      var m = document.createElement('div');
      m.className = 'meta';
      var c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t.e.category;
      m.appendChild(c);
      li.appendChild(m);

      liste.appendChild(li);
    });
  });
})();
