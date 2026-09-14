"""Beide Speicher müssen sich gleich verhalten.

Das ist die Behauptung, die der Store-Wechsel aufstellt: eine Seite soll nicht
wissen müssen, ob ihre Artikel aus Dateien oder aus Postgres kommen. Also wird
derselbe Ablauf gegen beide gefahren und das Ergebnis verglichen.

Der Postgres-Teil läuft nur mit ``TEST_DATABASE_URL``, sonst wird er
übersprungen. Der Container dafür:

    docker run -d --name anycms-pg -e POSTGRES_PASSWORD=testpw \
      -e POSTGRES_DB=anycms_test -p 55432:5432 postgres:16-alpine

Lauf:
    TEST_DATABASE_URL=postgres://postgres:testpw@127.0.0.1:55432/anycms_test \
      python test_store.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from store import FileStore, PostgresStore, Store

befunde: list[str] = []


def pruefe(name: str, ok: bool, zusatz: str = "") -> None:
    befunde.append(f"{'OK  ' if ok else 'FEHL'}  {name}{(' - ' + zusatz) if zusatz else ''}")


def artikel(**ueber: object) -> dict:
    basis = {
        "id": 1,
        "title": 'Nizza-Klasse 25: was "hineingehört"',
        "slug": "nizza-klasse-25",
        "content_html": "<p>Inhalt</p>",
        "content_markdown": "## Überschrift\n\nInhalt.",
        "content_format": "markdown",
        "meta_description": "Kurz erklärt",
        "keywords": ["nizza klasse 25", "marke"],
        "url_prefix": "/glossar/",
        "content_language": "de",
        "revision": 3,
        "created_at": "2026-09-01T10:00:00+00:00",
        "updated_at": "2026-09-05T10:00:00+00:00",
    }
    basis.update(ueber)
    return basis


def ablauf(store: Store, name: str) -> dict:
    """Derselbe Ablauf gegen einen Store. Gibt zurueck, was verglichen wird."""
    store.init()

    url = store.speichern(artikel(), "https://example.com/")
    pruefe(f"[{name}] speichern gibt die URL zurueck",
           url == "https://example.com/glossar/nizza-klasse-25", str(url))

    eintrag = store.lesen("glossar/nizza-klasse-25")
    pruefe(f"[{name}] lesen findet den Artikel", eintrag is not None)
    if eintrag is None:
        return {}

    # Umlaute und maskierte Anfuehrungszeichen muessen unveraendert
    # zurueckkommen: sie sind der Regelfall, nicht die Ausnahme.
    pruefe(f"[{name}] Titel unveraendert",
           eintrag["title"] == 'Nizza-Klasse 25: was "hineingehört"', eintrag["title"])
    pruefe(f"[{name}] Kategorie aus dem Cluster", eintrag["category"] == "glossar")
    pruefe(f"[{name}] Tags vollstaendig",
           eintrag["tags"] == ["nizza klasse 25", "marke"], str(eintrag["tags"]))
    pruefe(f"[{name}] Markdown im Koerper", "## Überschrift" in eintrag["body"])
    pruefe(f"[{name}] Format mitgefuehrt", eintrag["format"] == "markdown")

    # Zweite Zustellung: aktualisieren, nicht duplizieren.
    store.speichern(artikel(title="Neuer Titel", content_markdown="## Neu"), "https://example.com")
    liste = store.liste()
    pruefe(f"[{name}] zweite Zustellung dupliziert nicht", len(liste) == 1, f"{len(liste)} Zeilen")
    pruefe(f"[{name}] zweite Zustellung aktualisiert",
           liste[0]["title"] == "Neuer Titel" if liste else False)

    # Sortierung: neueste zuerst.
    store.speichern(
        artikel(id=2, slug="aelterer", created_at="2026-01-01T00:00:00+00:00"),
        "https://example.com",
    )
    liste = store.liste()
    pruefe(f"[{name}] neueste zuerst",
           [p["slug"] for p in liste] == ["nizza-klasse-25", "aelterer"],
           str([p["slug"] for p in liste]))

    # Sicherheit: kein Schreiben und kein Lesen ausserhalb.
    pruefe(f"[{name}] boeser Slug wird abgelehnt",
           store.speichern(artikel(slug="../../../boese"), "https://example.com") is None)
    pruefe(f"[{name}] boeser Lesepfad ergibt None",
           store.lesen("../../etc/passwd") is None)

    # Ein Artikel ohne Tags: leere Liste, nicht None.
    store.speichern(artikel(id=3, slug="ohne-tags", keywords=[]), "https://example.com")
    ohne = store.lesen("glossar/ohne-tags")
    pruefe(f"[{name}] ohne Tags ist eine leere Liste",
           ohne is not None and ohne["tags"] == [])

    # Das Format entscheidet, nicht die Anwesenheit von Markdown.
    store.speichern(
        artikel(id=4, slug="html-artikel", content_format="html",
                content_html="<p>Das ist HTML.</p>"),
        "https://example.com",
    )
    html = store.lesen("glossar/html-artikel")
    pruefe(f"[{name}] HTML-Artikel speichert HTML",
           html is not None and "Das ist HTML" in html["body"]
           and "Überschrift" not in html["body"])

    return {
        p["url_pfad"]: {k: p[k] for k in ("title", "category", "tags", "lang", "format")}
        for p in store.liste()
    }


def main() -> int:
    datei_verzeichnis = Path(tempfile.mkdtemp(prefix="anycms-store-"))
    aus_dateien = ablauf(FileStore(datei_verzeichnis), "files")

    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        befunde.append("--    Postgres uebersprungen (TEST_DATABASE_URL nicht gesetzt)")
        aus_postgres = None
    else:
        pg = PostgresStore(url, tabelle="anycms_store_test")
        pg.init()
        # Mit leerer Tabelle beginnen, sonst zaehlt ein frueherer Lauf mit.
        with pg._verbindung() as con, con.cursor() as cur:  # noqa: SLF001
            cur.execute(f"TRUNCATE {pg.tabelle}")
            con.commit()
        aus_postgres = ablauf(pg, "postgres")

    if aus_postgres is not None:
        # Der eigentliche Punkt: beide liefern dasselbe. Ein Unterschied hier
        # hiesse, dass ein Seitenwechsel den Blog veraendert.
        pruefe("beide Speicher liefern dieselben Artikel",
               set(aus_dateien) == set(aus_postgres),
               f"{sorted(aus_dateien)} vs {sorted(aus_postgres)}")
        for pfad in sorted(set(aus_dateien) & set(aus_postgres)):
            pruefe(f"identisch: {pfad}", aus_dateien[pfad] == aus_postgres[pfad],
                   f"{aus_dateien[pfad]} vs {aus_postgres[pfad]}")

    print("\n".join(befunde))
    misserfolge = [b for b in befunde if b.startswith("FEHL")]
    print(f"\n{len(befunde) - len(misserfolge)}/{len(befunde)} bestanden")
    return 1 if misserfolge else 0


if __name__ == "__main__":
    sys.exit(main())
