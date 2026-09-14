"""anyCMS Flask starter: a blog that receives AI-generated articles.

The connector here is not custom code but the ``ai-content-autopilot`` package
(1.1.0 and up). It verifies the HMAC signature, acknowledges with HTTP 202, and
fetches the article in the background over the pull API. That order is the
point: Visibly waits 10 seconds for the response and does NOT retry when it
times out. Answering only after the article is written means being delivered to
repeatedly and doing the same work several times.

Articles live wherever ``store.py`` puts them: Markdown files under
``CONTENT_DIR`` by default, or Postgres when ``DATABASE_URL`` is set. With
files on Railway, **the directory must be a mounted volume**, otherwise the
articles are gone after the next deploy.
"""
from __future__ import annotations

import os
from datetime import UTC, datetime
from xml.sax.saxutils import escape as xml_escape

from ai_content_autopilot import configure_visibly, contentpilot_webhook_bp
from ai_content_autopilot.client import VisiblyClient
from flask import Flask, Response, abort, jsonify, render_template, request

import content as inhalt
from content import SITE_DESCRIPTION, SITE_NAME, SITE_URL
from store import get_store

# ─────────────────────────────────────────────────────────────────────────────
# Empfang
# ─────────────────────────────────────────────────────────────────────────────


def speichere_artikel(artikel: dict) -> str | None:
    """Artikel ablegen und die oeffentliche URL zurueckgeben.

    Wohin, entscheidet ``store.get_store()``: Markdown-Dateien oder Postgres.
    """
    return get_store().speichern(artikel, SITE_URL)


def _handler(artikel: dict) -> bool:
    """Wird vom SDK im Hintergrund gerufen, nachdem der Webhook quittiert ist."""
    url = speichere_artikel(artikel)
    if not url:
        return False
    # Erst die Rueckmeldung macht die URL in Visibly bekannt; ohne sie kann
    # Visibly den Beitrag spaeter nicht gezielt aktualisieren.
    try:
        VisiblyClient(
            api_key=os.environ.get("VISIBLY_API_KEY", ""),
            base_url=os.environ.get("VISIBLY_BASE_URL", "https://app.visibly-ai.com"),
        ).confirm_published(artikel["id"], url)
    except Exception as e:  # noqa: BLE001 - eine fehlende Rueckmeldung ist kein Datenverlust
        print(f"[visibly] Rueckmeldung fehlgeschlagen: {e}")
    return True


# ─────────────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────────────


def create_app() -> Flask:
    app = Flask(__name__)

    configure_visibly(
        webhook_secret=os.environ.get("VISIBLY_WEBHOOK_SECRET", ""),
        api_key=os.environ.get("VISIBLY_API_KEY", ""),
        base_url=os.environ.get("VISIBLY_BASE_URL", "https://app.visibly-ai.com"),
        on_article_received=_handler,
        background=True,  # quittieren, dann arbeiten
    )
    app.register_blueprint(contentpilot_webhook_bp)

    @app.context_processor
    def _globals() -> dict:
        return {
            "site_name": SITE_NAME,
            "site_description": SITE_DESCRIPTION,
            "site_url": SITE_URL,
            "datum": inhalt.datum_lesbar,
        }

    # ── Listen ───────────────────────────────────────────────────────────────

    @app.get("/")
    def start() -> str:
        seite = inhalt.blaettern(inhalt.alle_posts(), 1)
        return render_template("index.html", seite=seite, titel="Articles")

    @app.get("/page/<int:nummer>")
    def blaetter_seite(nummer: int) -> str:
        alle = inhalt.alle_posts()
        seite = inhalt.blaettern(alle, nummer)
        # Eine Seitenzahl jenseits des Bestands ist ein 404, keine leere Liste:
        # sonst indexieren Suchmaschinen beliebig viele leere Seiten.
        if nummer > seite["pages"]:
            abort(404)
        return render_template("index.html", seite=seite, titel="Articles")

    @app.get("/categories")
    def kategorien() -> str:
        return render_template(
            "terms.html",
            titel="Categories",
            lead="Each category is a content cluster in Visibly, with its own path, "
                 "language and target country.",
            begriffe=inhalt.kategorien(inhalt.alle_posts()),
            basis="/category",
            praefix="",
        )

    @app.get("/category/<name>")
    def kategorie(name: str) -> str:
        gesucht = name.lower()
        posts = [p for p in inhalt.alle_posts() if p.category.lower() == gesucht]
        # Eine leere Kategorie gibt es nicht: sie entsteht erst durch Beitraege.
        if not posts:
            abort(404)
        return render_template("liste.html", titel=name, posts=posts)

    @app.get("/tags")
    def tags() -> str:
        return render_template(
            "terms.html",
            titel="Tags",
            lead="Tags come from the target keywords of each article.",
            begriffe=inhalt.tag_liste(inhalt.alle_posts()),
            basis="/tag",
            praefix="#",
        )

    @app.get("/tag/<name>")
    def tag(name: str) -> str:
        gesucht = name.lower()
        posts = [p for p in inhalt.alle_posts() if any(t.lower() == gesucht for t in p.tags)]
        if not posts:
            abort(404)
        return render_template("liste.html", titel=f"#{name}", posts=posts)

    @app.get("/search")
    def suche() -> str:
        return render_template("search.html", titel="Search")

    # ── Maschinenlesbares ────────────────────────────────────────────────────

    @app.get("/search-index.json")
    def such_index() -> Response:
        antwort = jsonify(inhalt.such_index(inhalt.alle_posts()))
        # Kurz zwischenspeichern: die Suche fragt ihn bei jedem Aufruf, und ein
        # per Webhook neuer Artikel darf hoechstens eine Minute fehlen.
        antwort.headers["Cache-Control"] = "public, max-age=60"
        return antwort

    @app.get("/rss.xml")
    def rss() -> Response:
        posts = inhalt.alle_posts()[:50]
        eintraege = "\n".join(
            f"""    <item>
      <title>{xml_escape(p.title)}</title>
      <link>{xml_escape(p.url)}</link>
      <guid isPermaLink="true">{xml_escape(p.url)}</guid>
      <description>{xml_escape(p.description)}</description>
      {f'<pubDate>{inhalt.rfc822(p.pub_date)}</pubDate>' if inhalt.rfc822(p.pub_date) else ''}
      <category>{xml_escape(p.category)}</category>
    </item>"""
            for p in posts
        )
        feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{xml_escape(SITE_NAME)}</title>
    <link>{xml_escape(SITE_URL)}</link>
    <description>{xml_escape(SITE_DESCRIPTION)}</description>
    <atom:link href="{xml_escape(SITE_URL)}/rss.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>{datetime.now(UTC).strftime('%a, %d %b %Y %H:%M:%S +0000')}</lastBuildDate>
{eintraege}
  </channel>
</rss>"""
        return Response(feed, mimetype="application/rss+xml")

    @app.get("/sitemap.xml")
    def sitemap() -> Response:
        posts = inhalt.alle_posts()
        eintraege = [f"  <url><loc>{xml_escape(SITE_URL)}/</loc><priority>1.0</priority></url>"]
        for p in posts:
            # lastmod zaehlt: ohne das gilt jede Aktualisierung als unsichtbar.
            lastmod = (p.updated_date or p.pub_date or "")[:10]
            eintraege.append(
                f"  <url><loc>{xml_escape(p.url)}</loc>"
                + (f"<lastmod>{lastmod}</lastmod>" if lastmod else "")
                + "<priority>0.8</priority></url>"
            )
        for k in inhalt.kategorien(posts):
            eintraege.append(
                f"  <url><loc>{xml_escape(SITE_URL)}/category/{k['name']}</loc>"
                "<priority>0.5</priority></url>"
            )
        for t in inhalt.tag_liste(posts):
            eintraege.append(
                f"  <url><loc>{xml_escape(SITE_URL)}/tag/{t['name']}</loc>"
                "<priority>0.3</priority></url>"
            )
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "\n".join(eintraege)
            + "\n</urlset>"
        )
        return Response(xml, mimetype="application/xml")

    @app.get("/robots.txt")
    def robots() -> Response:
        # Webhook und Suchindex gehoeren in keinen Index.
        text = (
            "User-agent: *\n"
            "Allow: /\n"
            "Disallow: /webhooks/\n"
            "Disallow: /search\n"
            "Disallow: /search-index.json\n\n"
            f"Sitemap: {SITE_URL}/sitemap.xml\n"
        )
        return Response(text, mimetype="text/plain")

    @app.get("/health")
    def health() -> Response:
        return Response('{"status":"ok"}', mimetype="application/json")

    # ── Artikel (faengt alles Uebrige) ───────────────────────────────────────

    @app.get("/<path:pfad>")
    def artikelseite(pfad: str) -> str:
        gelesen = inhalt.post_lesen(pfad)
        if gelesen is None:
            abort(404)
        post, html, toc = gelesen
        return render_template(
            "post.html",
            post=post,
            html=html,
            toc=toc,
            verwandt=inhalt.verwandte(inhalt.alle_posts(), post),
        )

    @app.errorhandler(404)
    def nicht_gefunden(_e: object) -> tuple[str, int]:
        return render_template("404.html", titel="404"), 404

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))  # noqa: S104
