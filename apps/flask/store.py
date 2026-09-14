"""Where articles live: files or Postgres, decided by one environment variable.

**Files** are the default. Markdown with frontmatter, the same format Hugo,
Jekyll and Eleventy use: humans can read it, there is no schema to migrate, and
on Railway a mounted volume is enough instead of a second service.

**Postgres** when ``DATABASE_URL`` is set. Pick it when you run several
instances (a volume attaches to exactly one service), when the articles belong
in the same backup as the rest of your data, or when your platform has no
volumes.

The choice comes from the environment, not from a config file: on Railway,
adding a Postgres service sets ``DATABASE_URL`` for you, and the starter should
follow that without a second place to edit.
"""
from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CONTENT_DIR = Path(os.environ.get("CONTENT_DIR", "/data/content"))

#: Slug und Pfadteile kommen aus einem fremden System und landen in einem
#: Dateipfad beziehungsweise in einer URL: ohne diese Pruefung schriebe ein
#: ``../`` ausserhalb des Verzeichnisses.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,199}$", re.IGNORECASE)

_FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_ZITAT = re.compile(r'"([^"]*)"')


def sichere_teile(pfad: str) -> list[str]:
    """Pfadteile, die alle der Slug-Regel genuegen; sonst leer."""
    teile = [t for t in pfad.split("/") if t]
    return teile if teile and all(SLUG_RE.match(t) for t in teile) else []


def praefix_teile(url_prefix: str | None) -> list[str]:
    """Die Pfadteile des Cluster-Praefix, jeder einzeln geprueft."""
    roh = (url_prefix or "/blog/").strip("/")
    return [t for t in roh.split("/") if t and SLUG_RE.match(t)]


def kategorie_von(url_prefix: str | None) -> str:
    """Die Kategorie ist das erste Segment des Cluster-Praefix."""
    teile = praefix_teile(url_prefix)
    return teile[0] if teile else "blog"


def tags_von(keywords: Any) -> list[str]:
    if not isinstance(keywords, list):
        return []
    return [k for k in keywords if isinstance(k, str) and k.strip()]


def inhalt_von(artikel: dict) -> str:
    """Der Textkoerper: Markdown wenn das Format es sagt, sonst HTML.

    Visibly liefert ``content_markdown`` mit, sobald ``include_markdown=true``
    gesetzt ist, auch bei einem HTML-Artikel. Wer Markdown nimmt, weil es da
    ist, legt den falschen Koerper ab.
    """
    if artikel.get("content_format") == "markdown" and artikel.get("content_markdown"):
        return str(artikel["content_markdown"])
    return str(artikel.get("content_html") or "")


class Store(ABC):
    """Drei Lesezugriffe und ein Schreibzugriff, mehr braucht kein Backend."""

    art: str

    @abstractmethod
    def init(self) -> None: ...

    @abstractmethod
    def speichern(self, artikel: dict, site_url: str) -> str | None:
        """Ablegen und die oeffentliche URL zurueckgeben; ``None`` bei Ablehnung."""

    @abstractmethod
    def liste(self) -> list[dict]:
        """Alle Artikel, neueste zuerst, ohne Koerper."""

    @abstractmethod
    def lesen(self, url_pfad: str) -> dict | None:
        """Einen Artikel mit Koerper; ``None``, wenn es ihn nicht gibt."""


# ─────────────────────────────────────────────────────────────────────────────
# Dateien
# ─────────────────────────────────────────────────────────────────────────────


def _yaml_wert(wert: object) -> str:
    """Frontmatter maskieren: ein Doppelpunkt im Titel zerlegt sonst das YAML."""
    s = "" if wert is None else str(wert)
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _yaml_string(roh: str) -> str:
    """Einen Frontmatter-Wert entpacken.

    ``strip('"')`` waere hier falsch: es entfernt ALLE Anfuehrungszeichen an
    den Raendern, also bei ``"was \\"x\\""`` auch das maskierte, und
    zurueck bliebe ein einzelner Backslash. Ein Titel mit Zitat kam so
    verstuemmelt heraus (gefunden beim Vergleich mit dem Postgres-Store).
    """
    roh = roh.strip()
    if len(roh) >= 2 and roh.startswith('"') and roh.endswith('"'):
        # In einem Durchgang entmaskieren: sequentielle replace-Aufrufe
        # verschlucken sich an \\" (maskierter Backslash vor Zitat).
        return re.sub(r"\\(.)", r"\1", roh[1:-1])
    return roh


def _kopf_und_rumpf(roh: str) -> tuple[dict[str, str], str]:
    treffer = _FRONTMATTER.match(roh)
    if not treffer:
        return {}, roh
    kopf: dict[str, str] = {}
    for zeile in treffer.group(1).splitlines():
        m = re.match(r"^(\w+):\s*(.*)$", zeile)
        if m:
            kopf[m.group(1)] = _yaml_string(m.group(2))
    return kopf, roh[treffer.end():]


def _tags_lesen(roh: str | None) -> list[str]:
    """Eine Frontmatter-Liste ``["a", "b"]`` lesen. Unlesbares ergibt leer."""
    return [t for t in _ZITAT.findall(roh)] if roh else []


class FileStore(Store):
    art = "files"

    def __init__(self, dir: Path | None = None) -> None:
        self.dir = dir or CONTENT_DIR

    def init(self) -> None:
        # Das Verzeichnis darf fehlen: "noch nichts empfangen" ist kein Fehler,
        # und angelegt wird es beim ersten Schreiben.
        pass

    def speichern(self, artikel: dict, site_url: str) -> str | None:
        slug = str(artikel.get("slug") or "").strip()
        if not SLUG_RE.match(slug):
            print(f"[visibly] Slug abgelehnt: {slug!r}")
            return None

        teile = praefix_teile(artikel.get("url_prefix"))
        ordner = self.dir.joinpath(*teile)
        ordner.mkdir(parents=True, exist_ok=True)

        jetzt = datetime.now(UTC).isoformat()
        tags = tags_von(artikel.get("keywords"))
        kopf = "\n".join(
            [
                "---",
                f"title: {_yaml_wert(artikel.get('title'))}",
                f"description: {_yaml_wert(artikel.get('meta_description'))}",
                f"slug: {_yaml_wert(slug)}",
                f"category: {_yaml_wert(kategorie_von(artikel.get('url_prefix')))}",
                f"pubDate: {_yaml_wert(artikel.get('created_at') or jetzt)}",
                f"updatedDate: {_yaml_wert(artikel.get('updated_at') or jetzt)}",
                f"lang: {_yaml_wert(artikel.get('content_language') or 'de')}",
                f"visiblyArticleId: {artikel.get('id')}",
                f"visiblyRevision: {artikel.get('revision') or 1}",
                f"format: {_yaml_wert(artikel.get('content_format') or 'html')}",
                # Tags stehen immer da, auch leer: ein fehlender Schluessel und
                # eine leere Liste sind zwei verschiedene Aussagen.
                "tags: [" + ", ".join(_yaml_wert(t) for t in tags) + "]",
                "---",
                "",
            ]
        )
        # Der Dateiname ist der Slug: eine zweite Zustellung ueberschreibt,
        # sie dupliziert nicht.
        (ordner / f"{slug}.md").write_text(kopf + inhalt_von(artikel) + "\n", encoding="utf-8")
        return f"{site_url.rstrip('/')}/{'/'.join([*teile, slug])}"

    def liste(self) -> list[dict]:
        if not self.dir.exists():
            return []
        gefunden = []
        for datei in self.dir.rglob("*.md"):
            kopf, rumpf = _kopf_und_rumpf(datei.read_text(encoding="utf-8"))
            rel = datei.relative_to(self.dir).with_suffix("")
            teile = rel.as_posix().split("/")
            gefunden.append(
                {
                    "slug": teile[-1],
                    "url_pfad": rel.as_posix(),
                    "title": kopf.get("title") or teile[-1],
                    "description": kopf.get("description", ""),
                    "category": kopf.get("category") or (teile[0] if len(teile) > 1 else "blog"),
                    "tags": _tags_lesen(kopf.get("tags")),
                    "pub_date": kopf.get("pubDate", ""),
                    "updated_date": kopf.get("updatedDate") or kopf.get("pubDate", ""),
                    "lang": kopf.get("lang", "de"),
                    "format": kopf.get("format", "html"),
                    "body": rumpf,
                }
            )
        return sorted(gefunden, key=lambda p: p["pub_date"], reverse=True)

    def lesen(self, url_pfad: str) -> dict | None:
        teile = sichere_teile(url_pfad)
        if not teile:
            return None
        datei = self.dir.joinpath(*teile[:-1], f"{teile[-1]}.md")
        if not datei.is_file():
            return None
        kopf, rumpf = _kopf_und_rumpf(datei.read_text(encoding="utf-8"))
        return {
            "slug": teile[-1],
            "url_pfad": "/".join(teile),
            "title": kopf.get("title") or teile[-1],
            "description": kopf.get("description", ""),
            "category": kopf.get("category") or (teile[0] if len(teile) > 1 else "blog"),
            "tags": _tags_lesen(kopf.get("tags")),
            "pub_date": kopf.get("pubDate", ""),
            "updated_date": kopf.get("updatedDate") or kopf.get("pubDate", ""),
            "lang": kopf.get("lang", "de"),
            "format": kopf.get("format", "html"),
            "body": rumpf,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Postgres
# ─────────────────────────────────────────────────────────────────────────────


def _sicherer_tabellenname(name: str) -> str:
    """Postgres bindet Werte, keine Bezeichner.

    Der Tabellenname landet also unmaskiert im SQL und muss hier gefiltert
    werden, sonst waere er eine Injektion mit Ansage.
    """
    if not re.match(r"^[a-z_][a-z0-9_]{0,62}$", name, re.IGNORECASE):
        raise ValueError(f"ARTICLE_TABLE ist kein gueltiger Bezeichner: {name!r}")
    return name


class PostgresStore(Store):
    art = "postgres"

    def __init__(self, url: str, tabelle: str | None = None) -> None:
        self.url = url
        self.tabelle = _sicherer_tabellenname(
            tabelle or os.environ.get("ARTICLE_TABLE", "anycms_articles")
        )
        self._pool: Any = None

    def _verbindung(self):  # noqa: ANN202 - psycopg-Typen sind optional
        try:
            import psycopg
        except ImportError as e:  # pragma: no cover - haengt an der Installation
            raise RuntimeError(
                "DATABASE_URL ist gesetzt, aber das Paket 'psycopg' fehlt. "
                "Installiere es (pip install 'psycopg[binary]') oder setze "
                "ARTICLE_STORE=files."
            ) from e
        return psycopg.connect(self.url)

    def init(self) -> None:
        # Ein Tabelle, kein Migrationswerkzeug: die Form ist klein genug, dass
        # ein Framework mehr Maschinerie waere als das, was es verwaltet.
        with self._verbindung() as con, con.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {self.tabelle} (
                    url_path      TEXT PRIMARY KEY,
                    slug          TEXT NOT NULL,
                    article_id    INTEGER,
                    title         TEXT NOT NULL DEFAULT '',
                    description   TEXT NOT NULL DEFAULT '',
                    category      TEXT NOT NULL DEFAULT 'blog',
                    tags          TEXT[] NOT NULL DEFAULT '{{}}',
                    lang          TEXT NOT NULL DEFAULT 'de',
                    format        TEXT NOT NULL DEFAULT 'html',
                    body          TEXT NOT NULL DEFAULT '',
                    revision      INTEGER NOT NULL DEFAULT 1,
                    pub_date      TIMESTAMPTZ,
                    updated_date  TIMESTAMPTZ,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS {self.tabelle}_pub_date_idx "
                f"ON {self.tabelle} (pub_date DESC)"
            )
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS {self.tabelle}_category_idx "
                f"ON {self.tabelle} (category)"
            )
            con.commit()

    def speichern(self, artikel: dict, site_url: str) -> str | None:
        slug = str(artikel.get("slug") or "").strip()
        if not SLUG_RE.match(slug):
            print(f"[visibly] Slug abgelehnt: {slug!r}")
            return None

        teile = praefix_teile(artikel.get("url_prefix"))
        url_pfad = "/".join([*teile, slug])
        jetzt = datetime.now(UTC).isoformat()

        # Der Pfad ist der Schluessel: eine zweite Zustellung desselben
        # Artikels aktualisiert, sie legt keinen zweiten an.
        with self._verbindung() as con, con.cursor() as cur:
            cur.execute(
                f"""INSERT INTO {self.tabelle}
                      (url_path, slug, article_id, title, description, category,
                       tags, lang, format, body, revision, pub_date, updated_date)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (url_path) DO UPDATE SET
                      slug = EXCLUDED.slug, article_id = EXCLUDED.article_id,
                      title = EXCLUDED.title, description = EXCLUDED.description,
                      category = EXCLUDED.category, tags = EXCLUDED.tags,
                      lang = EXCLUDED.lang, format = EXCLUDED.format,
                      body = EXCLUDED.body, revision = EXCLUDED.revision,
                      updated_date = EXCLUDED.updated_date""",
                (
                    url_pfad, slug, artikel.get("id"),
                    artikel.get("title") or "", artikel.get("meta_description") or "",
                    kategorie_von(artikel.get("url_prefix")), tags_von(artikel.get("keywords")),
                    artikel.get("content_language") or "de",
                    artikel.get("content_format") or "html",
                    inhalt_von(artikel), artikel.get("revision") or 1,
                    artikel.get("created_at") or jetzt,
                    artikel.get("updated_at") or jetzt,
                ),
            )
            con.commit()
        return f"{site_url.rstrip('/')}/{url_pfad}"

    def liste(self) -> list[dict]:
        with self._verbindung() as con, con.cursor() as cur:
            cur.execute(
                f"""SELECT url_path, slug, title, description, category, tags,
                           lang, format, body, pub_date, updated_date
                      FROM {self.tabelle}
                     ORDER BY pub_date DESC NULLS LAST, url_path"""
            )
            return [self._zeile(r) for r in cur.fetchall()]

    def lesen(self, url_pfad: str) -> dict | None:
        teile = sichere_teile(url_pfad)
        if not teile:
            return None
        with self._verbindung() as con, con.cursor() as cur:
            cur.execute(
                f"""SELECT url_path, slug, title, description, category, tags,
                           lang, format, body, pub_date, updated_date
                      FROM {self.tabelle} WHERE url_path = %s""",
                ("/".join(teile),),
            )
            zeile = cur.fetchone()
        return self._zeile(zeile) if zeile else None

    @staticmethod
    def _zeile(r: tuple) -> dict:
        # Dieselbe Form wie beim Datei-Store: die Seiten sollen nicht wissen
        # muessen, woher ein Artikel kommt.
        return {
            "url_pfad": r[0], "slug": r[1], "title": r[2] or "", "description": r[3] or "",
            "category": r[4] or "blog", "tags": list(r[5] or []),
            "lang": r[6] or "de", "format": r[7] or "html", "body": r[8] or "",
            "pub_date": r[9].isoformat() if r[9] else "",
            "updated_date": (r[10] or r[9]).isoformat() if (r[10] or r[9]) else "",
        }


# ─────────────────────────────────────────────────────────────────────────────
# Auswahl
# ─────────────────────────────────────────────────────────────────────────────

_gewaehlt: Store | None = None


def get_store() -> Store:
    """Der Store dieses Prozesses, einmal erzeugt.

    Postgres gewinnt, sobald ``DATABASE_URL`` gesetzt ist, ausser
    ``ARTICLE_STORE=files`` sagt ausdruecklich etwas anderes: sonst waere eine
    vom Hoster gesetzte Variable eine stille Umstellung des Speichers.
    """
    global _gewaehlt
    if _gewaehlt is not None:
        return _gewaehlt

    erzwungen = os.environ.get("ARTICLE_STORE", "").lower()
    db_url = os.environ.get("DATABASE_URL", "")
    nutze_postgres = erzwungen == "postgres" or (bool(db_url) and erzwungen != "files")

    if nutze_postgres:
        if not db_url:
            raise RuntimeError("ARTICLE_STORE=postgres, aber DATABASE_URL fehlt")
        _gewaehlt = PostgresStore(db_url)
    else:
        _gewaehlt = FileStore()

    _gewaehlt.init()
    return _gewaehlt


def reset_store() -> None:
    """Nur fuer Tests: den gewaehlten Store vergessen."""
    global _gewaehlt
    _gewaehlt = None
