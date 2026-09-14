# Der Visibly-Vertrag

Was ein CMS wissen muss, um Artikel aus dem Visibly Content Autopilot
anzunehmen. Diese Datei beschreibt die Schnittstelle, nicht die Starter.

## Ereignisse

| Ereignis | Wann | Was das CMS tun sollte |
|---|---|---|
| `article.approved` | Ein Artikel wurde freigegeben | Beitrag anlegen |
| `article.updated` | Ein bereits veröffentlichter Artikel wurde geändert | Bestehenden Beitrag überschreiben |
| `article.published` | Eine Veröffentlichung wurde bestätigt | meist nichts |
| `article.failed` | Die Erzeugung ist gescheitert | protokollieren |

Die Nutzlast:

```json
{
  "event": "article.updated",
  "article_id": 42,
  "title": "Nizza-Klasse 25",
  "slug": "nizza-klasse-25",
  "project_id": 5,
  "scheduled_date": null,
  "published_url": "https://example.com/glossar/nizza-klasse-25",
  "revision": 3,
  "pull_url": "https://app.visibly-ai.com/api/v1/articles/42",
  "timestamp": "2026-09-14T10:00:00Z"
}
```

`published_url` und `revision` kommen nur bei `article.updated` mit. Mit der URL
findest du den bestehenden Beitrag auch dann, wenn du die Visibly-ID nie
gespeichert hast; mit der Revision erkennst du einen Stand, den du schon hast.

**Die Nutzlast enthält nicht den Artikeltext.** Sie ist das Signal, der Text
kommt über die Pull-API.

## Signatur

Jeder Webhook trägt `X-Webhook-Signature: sha256=<hex>`, ein HMAC-SHA256 über
den **rohen Body** mit dem Secret der Verbindung.

Zwei Fallstricke, die regelmäßig Stunden kosten:

1. **Über die gesendeten Bytes prüfen, nicht über neu serialisiertes JSON.**
   Ein `JSON.parse` + `JSON.stringify` ändert Reihenfolge und Leerzeichen, und
   jede gültige Signatur fällt durch.
2. **Zeitkonstant vergleichen** (`timingSafeEqual`, `hmac.compare_digest`). Ein
   `==` auf Strings bricht beim ersten falschen Zeichen ab und verrät über die
   Laufzeit, wie weit man gekommen ist.

## Antworten: was Visibly daraus liest

| Deine Antwort | Wie Visibly sie liest |
|---|---|
| `202` | Angenommen, du arbeitest daran. Erfolg. |
| `200` mit `blog_post_id`, `post_id` oder `id` im Body | Verarbeitet, fertig. |
| `200` mit JSON ohne eines dieser Felder | Angenommen, aber nichts passiert. Wird als Fehlschlag protokolliert, mit deiner Meldung. |
| `4xx` | Abgelehnt. Kein erneuter Versuch, ein zweiter scheiterte genauso. |
| `5xx`, `429` | Vorübergehend. Erneut nach 1 s, 5 s, 25 s. |
| Keine Antwort binnen 10 s | Zugestellt, Ausgang unbekannt. **Kein erneuter Versuch.** |

Die letzte Zeile ist der Grund für den ganzen Aufbau. Ein Lesetimeout heisst
nicht "nicht angekommen", sondern "der Request war da, die Antwort fehlt".
Nochmal zu senden hiesse, dieselbe Arbeit ein zweites Mal auszulösen.

**Ein Fehler in deiner Verarbeitung ist kein `5xx`.** Die Zustellung hat
geklappt, die Arbeit nicht. Ein `5xx` lädt zu einem Wiederholungsversuch ein,
der denselben Fehler reproduziert.

## Pull-API

Basis `https://app.visibly-ai.com`, Authentifizierung `Authorization: Bearer <key>`.

| Endpunkt | Zweck |
|---|---|
| `GET /api/v1/articles?status=approved&limit=20` | Freigegebene auflisten |
| `GET /api/v1/articles/{id}?include_markdown=true` | Einen Artikel mit Inhalt |
| `POST /api/v1/articles/{id}/confirm` | Veröffentlichung melden: `{"published_url": "…"}` |

Zwei Key-Arten am selben Gate: `lc_…` gilt kontoweit, `cp_…` ist an ein Projekt
gebunden und sieht nur dessen Artikel.

### Felder, die für das Routing zählen

| Feld | Bedeutung |
|---|---|
| `slug` | URL-Teil des Beitrags. **Visibly baut die URL nicht**, das tust du. |
| `url_prefix` | Pfad-Präfix des Clusters, z. B. `/glossar/`. `null` = kein Cluster. |
| `content_language` | Sprache des Clusters (`de`, `en`). `null` = kein Cluster, **nicht** "Deutsch". |
| `target_country` | Zielland des Clusters (`DE`, `US`). |
| `recommended_page_type` | Vorlagen-Hinweis (`guide`, `blog`, …). |
| `content_format` | `html` oder `markdown`. Beides kommt vor, prüfe es. |
| `revision` | Zählt in Visibly bei jedem Schreibvorgang hoch. |

## Mehrsprachigkeit und hreflang

**Ein Visibly-Artikel trägt genau eine Sprache.** Es gibt keinen
Übersetzungs-Endpunkt und keine Artikel mit mehreren Sprachfassungen.

### Weg A: dein CMS übersetzt

Du bekommst den Quellartikel und erzeugst die übrigen Sprachen selbst. Du
trägst Kosten, Glossar und Konsistenz; Visibly sieht einen Artikel, und ein
späteres `article.updated` überschreibt deine Quellsprache.

Das ist langsam, und genau deshalb darf die Übersetzung **nicht** im
Webhook-Request laufen.

### Weg B: ein Cluster je Sprache

In Visibly bekommt jeder Cluster eigene Sprache, eigenes Zielland und einen
eigenen Pfad-Präfix:

| Cluster | `content_language` | `target_country` | `url_prefix` |
|---|---|---|---|
| Glossar DE | `de` | `DE` | `/glossar/` |
| Glossar EN | `en` | `US` | `/en/glossary/` |
| Glossar FR | `fr` | `FR` | `/fr/glossaire/` |

Jeder Artikel wird nativ in seiner Sprache geschrieben, nicht übersetzt, mit
eigener Keyword-Recherche je Markt. Der Preis: ein Artikel je Sprache gegen
dein Monatskontingent.

### Die hreflang-Struktur baut dein CMS

Visibly liefert `slug`, `url_prefix` und `content_language` als Bauplan. Die
fertige URL entsteht bei dir, und du meldest sie mit `confirm` zurück. Also
gehören auch die Tags dir:

```html
<link rel="alternate" hreflang="de" href="https://example.com/glossar/nizza-klasse/">
<link rel="alternate" hreflang="en" href="https://example.com/en/glossary/nice-class/">
<link rel="alternate" hreflang="fr" href="https://example.com/fr/glossaire/classe-de-nice/">
<link rel="alternate" hreflang="x-default" href="https://example.com/en/glossary/nice-class/">
```

Drei Regeln, an denen Generatoren häufig scheitern:

1. **Jede Fassung verlinkt jede Fassung, sich selbst eingeschlossen.** Eine
   Seite ohne eigenes hreflang gilt als unvollständiger Satz und wird ignoriert.
2. **`x-default` zeigt auf die Fassung für Besucher, zu denen keine andere
   passt**, meist die englische. Es ist nicht "die Standardsprache der Seite".
3. **Nur auf Seiten verlinken, die es gibt und die indexierbar sind.** Ein
   hreflang auf eine `noindex`-Seite oder einen 404 entwertet den ganzen Satz.

**Was Visibly dir noch nicht sagt:** welche Artikel Übersetzungen voneinander
sind. Zwei Cluster liefern zwei eigenständige Artikel ohne verbindende Kennung.
Halte diese Zuordnung auf deiner Seite, etwa über das Cluster-Paar plus deinen
eigenen Themenschlüssel.

## Speicherung: warum Dateien

Die Starter legen Artikel als Markdown mit Frontmatter ab. Astro und Next.js
lesen das nativ, Menschen können hineinsehen, es gibt kein Schema zu migrieren,
und auf Railway genügt ein Volume statt eines zweiten Dienstes.

**Das Verzeichnis muss auf einem Volume liegen.** Railways Dateisystem ist
sonst flüchtig: Container neu, Artikel weg.

Wenn du eine Datenbank bevorzugst, tausche in der Webhook-Datei den Aufruf von
`speichereArtikel` gegen deinen eigenen Schreibpfad. Der Rest bleibt gleich.

## Sicherheit

- **Slug und `url_prefix` kommen aus einem fremden System und landen in einem
  Pfad.** Ohne Prüfung liesse sich mit `../` aus dem Content-Verzeichnis
  herausschreiben. Die Starter lassen nur `[a-z0-9][a-z0-9-]*` durch.
- **Der Artikelinhalt ist HTML und wird ungefiltert gerendert.** Das ist
  beabsichtigt: er stammt aus deinem eigenen Visibly-Konto. Wer Inhalte aus
  fremden Konten annimmt, muss bereinigen.
- **Der API-Key gehört in die Umgebung**, nie ins Repo.
