"""Content layer: everything the pages need from the articles on disk.

Articles are Markdown files written by the connector. This module turns them
into the shapes the blog renders: lists, filters, pagination, reading time,
related posts and a search index.

Deliberately no cache. Articles arrive at runtime via webhook; a cache would
have to be invalidated by exactly the code path that must stay simple, and a
blog of this size reads its directory in single-digit milliseconds.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import markdown

CONTENT_DIR = Path(os.environ.get("CONTENT_DIR", "/data/content"))
SITE_URL = os.environ.get("SITE_URL", "http://localhost:8080").rstrip("/")
SITE_NAME = os.environ.get("SITE_NAME", "Blog")
SITE_DESCRIPTION = os.environ.get(
    "SITE_DESCRIPTION", "Articles delivered by the AI Automation Connector."
)
PER_PAGE = int(os.environ.get("POSTS_PER_PAGE", "10"))

#: Words per minute for an average reader of technical prose.
WPM = 220

#: Slug und Pfadteile kommen aus einem fremden System und landen in einem
#: Dateipfad: ohne diese Pruefung schriebe ein ``../`` ausserhalb des
#: Verzeichnisses, und ein Aufruf laese ausserhalb.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,199}$", re.IGNORECASE)

_FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_TAGS = re.compile(r'"([^"]*)"')


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


def sichere_teile(pfad: str) -> list[str]:
    """Pfadteile, die alle der Slug-Regel genuegen; sonst leer."""
    teile = [t for t in pfad.split("/") if t]
    return teile if teile and all(SLUG_RE.match(t) for t in teile) else []


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


def _kopf_und_rumpf(roh: str) -> tuple[dict[str, str], str]:
    treffer = _FRONTMATTER.match(roh)
    if not treffer:
        return {}, roh
    kopf: dict[str, str] = {}
    for zeile in treffer.group(1).splitlines():
        m = re.match(r"^(\w+):\s*(.*)$", zeile)
        if m:
            kopf[m.group(1)] = m.group(2).strip().strip('"').replace('\\"', '"')
    return kopf, roh[treffer.end():]


def _tags_lesen(roh: str | None) -> list[str]:
    """Eine Frontmatter-Liste ``["a", "b"]`` lesen. Unlesbares ergibt leer."""
    if not roh:
        return []
    return [t for t in _TAGS.findall(roh) if t.strip()]


def _post_aus_datei(datei: Path) -> Post:
    roh = datei.read_text(encoding="utf-8")
    kopf, rumpf = _kopf_und_rumpf(roh)
    rel = datei.relative_to(CONTENT_DIR).with_suffix("")
    teile = rel.as_posix().split("/")
    return Post(
        slug=teile[-1],
        url_pfad=rel.as_posix(),
        title=kopf.get("title") or teile[-1],
        description=kopf.get("description", ""),
        category=kopf.get("category") or (teile[0] if len(teile) > 1 else "blog"),
        tags=_tags_lesen(kopf.get("tags")),
        pub_date=kopf.get("pubDate", ""),
        updated_date=kopf.get("updatedDate") or kopf.get("pubDate", ""),
        lang=kopf.get("lang", "de"),
        fmt=kopf.get("format", "html"),
        reading_minutes=_lesezeit(_text_von(rumpf)),
        body=rumpf,
    )


def alle_posts() -> list[Post]:
    """Alle Beitraege, neueste zuerst."""
    if not CONTENT_DIR.exists():
        return []  # noch nichts empfangen ist kein Fehler
    posts = [_post_aus_datei(d) for d in CONTENT_DIR.rglob("*.md")]
    return sorted(posts, key=lambda p: p.pub_date, reverse=True)


def post_lesen(url_pfad: str) -> tuple[Post, str, list[dict]] | None:
    """Einen Beitrag mit gerendertem HTML und Inhaltsverzeichnis."""
    teile = sichere_teile(url_pfad)
    if not teile:
        return None
    datei = CONTENT_DIR.joinpath(*teile[:-1], f"{teile[-1]}.md")
    if not datei.is_file():
        return None

    post = _post_aus_datei(datei)
    # Visibly liefert je nach Cluster Markdown ODER HTML; das Frontmatter sagt
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
