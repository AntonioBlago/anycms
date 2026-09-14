"""End-to-end for the Flask starter.

Checks the delivery chain (signed webhook, fast 202, background pull, URL
reported back) AND that the blog around it works on the delivered article: SEO
metadata, JSON-LD, category and tag pages, search index, RSS, sitemap, robots
and pagination.

Run:  python test_e2e.py
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = "whsec_e2e"
FAKE_PORT = 8399
SITE = "http://127.0.0.1:8398"


def artikel(aid: int, slug: str, titel: str, praefix: str, tags: list[str],
            datum: str = "2026-09-01T10:00:00Z") -> dict:
    return {
        "id": aid,
        "title": titel,
        "slug": slug,
        "status": "approved",
        "content_html": "<p>Fallback.</p>",
        "content_markdown": (
            "## Why research first\n\nResearch comes before filing.\n\n"
            "### What the register shows\n\nEverything already protected."
        ),
        "meta_description": f"Summary of {titel}",
        "keywords": tags,
        "word_count": 850,
        "seo_score": 78,
        "project_id": 1,
        "url_prefix": praefix,
        "content_language": "en",
        "content_format": "markdown",
        "revision": 1,
        "created_at": datum,
        "updated_at": "2026-09-10T10:00:00Z",
    }


ARTIKEL = {
    # Der neuere steht auf Seite 1: mit POSTS_PER_PAGE=1 muss die Reihenfolge
    # bestimmt sein, sonst entscheidet der Zufall, was der Test sieht.
    88: artikel(88, "trademark-research-first-step", "Trademark research: the first step",
                "/guides/", ["trademark research", "filing"], "2026-09-05T10:00:00Z"),
    89: artikel(89, "nice-class-25-explained", "Nice class 25, explained",
                "/glossary/", ["nice class", "trademark research"], "2026-09-01T10:00:00Z"),
}

bestaetigt: list[dict] = []


class FakeVisibly(BaseHTTPRequestHandler):
    """Gefaelschtes Visibly: liefert Artikel, nimmt die Bestaetigung an."""

    def _id(self) -> int:
        # Query abschneiden: der Pull haengt ?include_markdown=true an, und
        # "88?include_markdown=true" ist keine Ziffernfolge.
        pfad = (self.path or "").split("?")[0]
        for t in pfad.split("/"):
            if t.isdigit():
                return int(t)
        return 0

    def do_GET(self) -> None:  # noqa: N802 - von BaseHTTPRequestHandler vorgegeben
        a = ARTIKEL.get(self._id())
        self._json({"article": a} if a else {}, 200 if a else 404)

    def do_POST(self) -> None:  # noqa: N802
        if "/confirm" in (self.path or ""):
            laenge = int(self.headers.get("Content-Length", 0))
            bestaetigt.append(json.loads(self.rfile.read(laenge) or b"{}"))
            self._json({"success": True})
        else:
            self._json({}, 404)

    def _json(self, daten: dict, status: int = 200) -> None:
        roh = json.dumps(daten).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(roh)))
        self.end_headers()
        self.wfile.write(roh)

    def log_message(self, *args: object) -> None:
        pass  # kein Rauschen im Testlauf


def main() -> int:
    content_dir = tempfile.mkdtemp(prefix="anycms-flask-")
    os.environ.update(
        CONTENT_DIR=content_dir,
        SITE_URL=SITE,
        SITE_NAME="Test Blog",
        SITE_DESCRIPTION="Articles delivered automatically.",
        VISIBLY_WEBHOOK_SECRET=SECRET,
        VISIBLY_API_KEY="lc_test",
        VISIBLY_BASE_URL=f"http://127.0.0.1:{FAKE_PORT}",
        CONTENTPILOT_WEBHOOK_SECRET=SECRET,  # das SDK liest diesen Namen
        POSTS_PER_PAGE="1",  # damit die Paginierung im Test wirklich blaettert
    )

    fake = HTTPServer(("127.0.0.1", FAKE_PORT), FakeVisibly)
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    import app as anwendung  # nach den Env-Variablen importieren

    client = anwendung.create_app().test_client()
    befunde: list[str] = []

    def pruefe(name: str, ok: bool, zusatz: str = "") -> None:
        befunde.append(f"{'OK  ' if ok else 'FEHL'}  {name}{(' - ' + zusatz) if zusatz else ''}")

    def hole(pfad: str) -> str:
        res = client.get(pfad)
        # Ein 500er meldete sich sonst nur als "Artikel fehlt", und der
        # eigentliche Fehler stand im Log statt im Befund.
        if res.status_code >= 500:
            pruefe(f"{pfad} antwortet ohne Serverfehler", False, f"HTTP {res.status_code}")
        return res.get_data(as_text=True)

    # ── Leerer Zustand ───────────────────────────────────────────────────────
    pruefe("Leerer Zustand ist ehrlich", "No articles yet" in hole("/"))

    # ── Zustellung ───────────────────────────────────────────────────────────
    begonnen = time.monotonic()
    for aid in ARTIKEL:
        koerper = json.dumps({"event": "article.approved", "article_id": aid}).encode()
        sig = "sha256=" + hmac.new(SECRET.encode(), koerper, hashlib.sha256).hexdigest()
        res = client.post(
            "/webhooks/visibly", data=koerper,
            headers={"Content-Type": "application/json", "X-Webhook-Signature": sig},
        )
        if aid == 88:
            pruefe("Webhook quittiert mit 202", res.status_code == 202, f"bekam {res.status_code}")
    dauer = time.monotonic() - begonnen
    pruefe("Antwort kommt sofort", dauer < 2.0, f"{dauer:.2f}s fuer beide")

    koerper = json.dumps({"event": "article.approved", "article_id": 88}).encode()
    boese = client.post(
        "/webhooks/visibly", data=koerper,
        headers={"Content-Type": "application/json", "X-Webhook-Signature": "sha256=falsch"},
    )
    pruefe("Falsche Signatur wird abgewiesen", boese.status_code == 401)

    # ── Warten, bis der Hintergrundlauf durch ist ────────────────────────────
    start = ""
    for _ in range(40):
        start = hole("/")
        if "Trademark research" in start:
            break
        time.sleep(0.25)
    pruefe("Neuester Artikel steht auf Seite 1", "Trademark research: the first step" in start)
    pruefe("Aelterer Artikel steht auf Seite 2",
           "Nice class 25" in hole("/page/2"))
    pruefe("Lesezeit wird angezeigt", "min read" in start)
    pruefe("URL wurde zurueckgemeldet", len(bestaetigt) == 2, f"{len(bestaetigt)} Meldungen")
    if bestaetigt:
        urls = {b.get("published_url") for b in bestaetigt}
        pruefe("Gemeldete URL stimmt",
               f"{SITE}/guides/trademark-research-first-step" in urls, str(urls))

    # ── Artikelseite: SEO ────────────────────────────────────────────────────
    detail = hole("/guides/trademark-research-first-step")
    pruefe("Markdown wurde gerendert", "<h2" in detail)
    pruefe("Ueberschriften haben Anker", 'id="why-research-first"' in detail)
    pruefe("Inhaltsverzeichnis erscheint", "Contents" in detail)
    pruefe("Canonical gesetzt", f'rel="canonical" href="{SITE}/guides/trademark-research-first-step"' in detail)
    pruefe("Meta-Description gesetzt", 'name="description"' in detail)
    pruefe("Open Graph gesetzt", 'property="og:title"' in detail)
    pruefe("JSON-LD BlogPosting", '"@type": "BlogPosting"' in detail)
    pruefe("JSON-LD Breadcrumb", '"@type": "BreadcrumbList"' in detail)
    pruefe("dateModified im JSON-LD", '"dateModified"' in detail)
    pruefe("JSON-LD ist gueltiges JSON", _ld_gueltig(detail))
    pruefe("Kategorie verlinkt", "/category/guides" in detail)
    pruefe("Tags verlinkt", "/tag/filing" in detail)
    pruefe("Verwandte Beitraege erscheinen", "Related articles" in detail,
           "ueber das gemeinsame Tag 'trademark research'")

    # ── Uebersichtsseiten ────────────────────────────────────────────────────
    pruefe("Kategorie-Seite listet den Artikel", "Trademark research" in hole("/category/guides"))
    pruefe("Tag-Seite listet den Artikel", "Trademark research" in hole("/tag/filing"))
    pruefe("Kategorien-Uebersicht kennt beide", "guides" in hole("/categories")
           and "glossary" in hole("/categories"))
    pruefe("Tag-Uebersicht kennt das Tag", "filing" in hole("/tags"))

    # ── Paginierung (POSTS_PER_PAGE=1) ───────────────────────────────────────
    pruefe("Startseite blaettert", "/page/2" in start)
    pruefe("Seite 2 laedt", client.get("/page/2").status_code == 200)

    # ── Feeds und Index ──────────────────────────────────────────────────────
    rss = hole("/rss.xml")
    pruefe("RSS enthaelt den Artikel", "trademark-research-first-step" in rss)
    pruefe("RSS ist wohlgeformt", _xml_gueltig(rss))
    sitemap = hole("/sitemap.xml")
    pruefe("Sitemap enthaelt den Artikel", "trademark-research-first-step" in sitemap)
    pruefe("Sitemap ist wohlgeformt", _xml_gueltig(sitemap))
    pruefe("Sitemap fuehrt lastmod", "<lastmod>" in sitemap)
    robots = hole("/robots.txt")
    pruefe("robots.txt verweist auf die Sitemap", "sitemap.xml" in robots)
    pruefe("robots.txt sperrt die Suche", "/search" in robots)
    index = hole("/search-index.json")
    pruefe("Suchindex enthaelt den Artikel", "Trademark research" in index)
    pruefe("Suchindex traegt den Text", "Research comes before filing" in index)

    # ── Statische Dateien ────────────────────────────────────────────────────
    css = client.get("/static/style.css")
    pruefe("Stylesheet wird ausgeliefert", css.status_code == 200)
    pruefe("Stylesheet traegt die Variablen", "--accent" in css.get_data(as_text=True))
    pruefe("Suchskript wird ausgeliefert", client.get("/static/search.js").status_code == 200)

    # ── Fehlerfaelle ─────────────────────────────────────────────────────────
    pruefe("Unbekannter Artikel ergibt 404", client.get("/guides/gibt-es-nicht").status_code == 404)
    pruefe("Leere Kategorie ergibt 404", client.get("/category/gibtsnicht").status_code == 404)
    pruefe("Leeres Tag ergibt 404", client.get("/tag/gibtsnicht").status_code == 404)
    pruefe("Seite jenseits des Bestands ergibt 404", client.get("/page/99").status_code == 404)
    pruefe("Pfadwechsel wird abgewiesen",
           client.get("/blog/../../etc").status_code in (308, 404))
    pruefe("Suchseite laedt", client.get("/search").status_code == 200)
    pruefe("Suchseite ist auf noindex", "noindex" in hole("/search"))

    fake.shutdown()
    print("\n".join(befunde))
    misserfolge = [b for b in befunde if b.startswith("FEHL")]
    print(f"\n{len(befunde) - len(misserfolge)}/{len(befunde)} bestanden")
    return 1 if misserfolge else 0


def _ld_gueltig(html: str) -> bool:
    """Das JSON-LD muss parsebar sein, sonst ignoriert es jede Suchmaschine."""
    import re
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    if not m:
        return False
    try:
        json.loads(m.group(1))
    except ValueError:
        return False
    return True


def _xml_gueltig(text: str) -> bool:
    """Ein Feed mit unmaskiertem & ist kaputt, auch wenn er ausgeliefert wird."""
    import xml.etree.ElementTree as ET
    try:
        ET.fromstring(text)
    except ET.ParseError:
        return False
    return True


if __name__ == "__main__":
    sys.exit(main())
