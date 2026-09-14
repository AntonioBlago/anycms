"""Content layer: everything the pages need, on top of whatever store is active.

Reading, rendering and grouping live here; where the articles physically are
(Markdown files or Postgres) lives in ``store.py``. The pages should not have
to know which one is running.

Deliberately no cache. Articles arrive at runtime via webhook; a cache would
have to be invalidated by exactly the code path that must stay simple.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime

import markdown

from store import SLUG_RE, get_store, sichere_teile  # noqa: F401  (re-export)

SITE_URL = os.environ.get("SITE_URL", "http://localhost:8080").rstrip("/")
SITE_NAME = os.environ.get("SITE_NAME", "Blog")
SITE_DESCRIPTION = os.environ.get(
    "SITE_DESCRIPTION", "Articles delivered by the AI Automation Connector."
)
PER_PAGE = int(os.environ.get("POSTS_PER_PAGE", "10"))

#: Words per minute for an average reader of technical prose.
WPM = 220


@dataclass
class Post:
    slug: str
    url_pfad: str
    title: str
    description: str
    category: str
    tags: list[str] = field(default_factory=list)
    pub_date: str = ""
    updated_date: str = ""
    lang: str = "de"
    fmt: str = "html"
    reading_minutes: int = 1
    body: str = ""

    @property
    def url(self) -> str:
        return f"{SITE_URL}/{self.url_pfad}"



def _text_von(html: str) -> str:
    ohne = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", ohne)).strip()


def _lesezeit(text: str) -> int:
    woerter = len(text.split()) if text else 0
    # Nie 0: auch drei Woerter kosten einen Moment, und "0 min" liest sich
    # wie ein Fehler.
    return max(1, math.ceil(woerter / WPM))


def heading_id(text: str) -> str:
    """Anker fuer eine Ueberschrift. Umlaute bleiben lesbar statt zu verschwinden."""
    s = text.lower()
    for von, nach in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        s = s.replace(von, nach)
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", s))[:80]





def _post(daten: dict) -> Post:
    """Eine Store-Zeile in einen Post, inklusive Lesezeit."""
    return Post(
        slug=daten["slug"],
        url_pfad=daten["url_pfad"],
        title=daten["title"],
        description=daten["description"],
        category=daten["category"],
        tags=daten["tags"],
        pub_date=daten["pub_date"],
        updated_date=daten["updated_date"],
        lang=daten["lang"],
        fmt=daten["format"],
        reading_minutes=_lesezeit(_text_von(daten["body"])),
        body=daten["body"],
    )


def alle_posts() -> list[Post]:
    """Alle Beitraege, neueste zuerst."""
    return [_post(d) for d in get_store().liste()]


def post_lesen(url_pfad: str) -> tuple[Post, str, list[dict]] | None:
    """Einen Beitrag mit gerendertem HTML und Inhaltsverzeichnis."""
    daten = get_store().lesen(url_pfad)
    if daten is None:
        return None

    post = _post(daten)
    # Visibly liefert je nach Cluster Markdown ODER HTML; das Format sagt
    # welches. HTML durch einen Markdown-Parser zu schicken, zerlegt es.
    html = (
        markdown.markdown(post.body, extensions=["extra", "sane_lists"])
        if post.fmt == "markdown"
        else post.body
    )

    toc: list[dict] = []

    def _anker(m: re.Match[str]) -> str:
        stufe, attrs, inner = m.group(1), m.group(2), m.group(3)
        text = _text_von(inner)
        kennung = heading_id(text)
        if kennung:
            toc.append({"id": kennung, "text": text, "level": int(stufe)})
        return f'<h{stufe}{attrs} id="{kennung}">{inner}</h{stufe}>'

    html = re.sub(r"<h([23])([^>]*)>(.*?)</h\1>", _anker, html, flags=re.S | re.I)
    return post, html, toc



def verwandte(alle: list[Post], aktuell: Post, limit: int = 3) -> list[Post]:
    """Verwandte Beitraege, meiste gemeinsame Tags zuerst.

    Nur Tags: eine gemeinsame Kategorie sagt wenig, wenn alle sie teilen, und
    ohne gemeinsame Tags gibt es nichts ehrlich zu behaupten. Eine leere Liste
    ist die bessere Antwort als drei beliebige Beitraege.
    """
    meine = {t.lower() for t in aktuell.tags}
    if not meine:
        return []
    bewertet = [
        (len(meine & {t.lower() for t in p.tags}), p)
        for p in alle
        if p.url_pfad != aktuell.url_pfad
    ]
    treffer = [(n, p) for n, p in bewertet if n > 0]
    treffer.sort(key=lambda x: (x[0], x[1].pub_date), reverse=True)
    return [p for _, p in treffer[:limit]]


def blaettern(items: list, seite: int, pro_seite: int = PER_PAGE) -> dict:
    gesamt = len(items)
    seiten = max(1, math.ceil(gesamt / pro_seite))
    sicher = min(max(1, seite), seiten)
    return {
        "items": items[(sicher - 1) * pro_seite: sicher * pro_seite],
        "page": sicher,
        "pages": seiten,
        "total": gesamt,
    }


def kategorien(alle: list[Post]) -> list[dict]:
    zaehler: dict[str, int] = {}
    for p in alle:
        zaehler[p.category] = zaehler.get(p.category, 0) + 1
    return sorted(
        ({"name": k, "count": v} for k, v in zaehler.items()),
        key=lambda x: (-x["count"], x["name"]),
    )


def tag_liste(alle: list[Post]) -> list[dict]:
    zaehler: dict[str, int] = {}
    for p in alle:
        for t in p.tags:
            zaehler[t.lower()] = zaehler.get(t.lower(), 0) + 1
    return sorted(
        ({"name": k, "count": v} for k, v in zaehler.items()),
        key=lambda x: (-x["count"], x["name"]),
    )


def such_index(alle: list[Post]) -> list[dict]:
    """Index fuer die Suche im Browser: klein genug zum Ausliefern."""
    return [
        {
            "title": p.title,
            "description": p.description,
            "url": f"/{p.url_pfad}",
            "category": p.category,
            "tags": p.tags,
            # Gedeckelt: ein Index, der ganze Artikel ausliefert, kostet mehr
            # Bandbreite als die Suche wert ist.
            "body": _text_von(p.body)[:2000],
        }
        for p in alle
    ]


def datum_lesbar(iso: str, lang: str = "en") -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if lang == "de":
        monate = [
            "Januar", "Februar", "März", "April", "Mai", "Juni",
            "Juli", "August", "September", "Oktober", "November", "Dezember",
        ]
        return f"{d.day}. {monate[d.month - 1]} {d.year}"
    return d.strftime("%B %-d, %Y") if os.name != "nt" else d.strftime("%B %d, %Y").replace(" 0", " ")


def rfc822(iso: str) -> str:
    """Datum im RSS-Format. Leer, wenn unlesbar: lieber kein Datum als ein falsches."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return d.strftime("%a, %d %b %Y %H:%M:%S +0000")
