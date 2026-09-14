"""End-to-End für den Flask-Starter.

Geprüft wird die Kette, die in Produktion gebrochen ist: quittiert der Server
schnell genug (202), holt er den Artikel selbst, landet er auf der Seite, und
meldet er die URL zurück?

Lauf:  python test_e2e.py
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

ARTIKEL = {
    "id": 88,
    "title": "Markenrecherche: der erste Schritt",
    "slug": "markenrecherche-erster-schritt",
    "status": "approved",
    "content_html": "<p>Vor der Anmeldung steht die Recherche.</p>",
    "content_markdown": "## Warum zuerst recherchieren\n\nVor der Anmeldung steht die Recherche.",
    "meta_description": "Warum die Recherche vor der Anmeldung kommt",
    "keywords": ["markenrecherche"],
    "word_count": 850,
    "seo_score": 78,
    "project_id": 1,
    "url_prefix": "/blog/",
    "content_language": "de",
    "content_format": "markdown",
    "revision": 1,
}

bestaetigt: list[dict] = []


class FakeVisibly(BaseHTTPRequestHandler):
    """Gefälschtes Visibly: liefert den Artikel, nimmt die Bestätigung an."""

    def do_GET(self) -> None:  # noqa: N802 - von BaseHTTPRequestHandler vorgegeben
        if self.path.startswith("/api/v1/articles/88"):
            self._json({"article": ARTIKEL})
        else:
            self._json({}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/api/v1/articles/88/confirm"):
            laenge = int(self.headers.get("Content-Length", 0))
            bestaetigt.append(json.loads(self.rfile.read(laenge) or b"{}"))
            self._json({"success": True, "article_id": 88})
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
        VISIBLY_WEBHOOK_SECRET=SECRET,
        VISIBLY_API_KEY="lc_test",
        VISIBLY_BASE_URL=f"http://127.0.0.1:{FAKE_PORT}",
        CONTENTPILOT_WEBHOOK_SECRET=SECRET,  # das SDK liest diesen Namen
    )

    fake = HTTPServer(("127.0.0.1", FAKE_PORT), FakeVisibly)
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    import app as anwendung  # nach den Env-Variablen importieren

    flask_app = anwendung.create_app()
    client = flask_app.test_client()

    befunde: list[str] = []

    def pruefe(name: str, ok: bool, zusatz: str = "") -> None:
        befunde.append(f"{'OK  ' if ok else 'FEHL'}  {name}{(' - ' + zusatz) if zusatz else ''}")

    # --- Leerer Zustand ------------------------------------------------------
    start = client.get("/")
    pruefe("Startseite laedt", start.status_code == 200)
    pruefe("Leerer Zustand ist ehrlich", "Noch keine Artikel" in start.get_data(as_text=True))

    # --- Webhook -------------------------------------------------------------
    koerper = json.dumps({"event": "article.approved", "article_id": 88}).encode()
    sig = "sha256=" + hmac.new(SECRET.encode(), koerper, hashlib.sha256).hexdigest()

    begonnen = time.monotonic()
    res = client.post(
        "/webhooks/visibly", data=koerper,
        headers={"Content-Type": "application/json", "X-Webhook-Signature": sig},
    )
    dauer = time.monotonic() - begonnen
    pruefe("Webhook quittiert mit 202", res.status_code == 202, f"bekam {res.status_code}")
    pruefe("Antwort kommt sofort", dauer < 2.0, f"{dauer:.2f}s; Visibly gibt nach 10s auf")

    boese = client.post(
        "/webhooks/visibly", data=koerper,
        headers={"Content-Type": "application/json", "X-Webhook-Signature": "sha256=falsch"},
    )
    pruefe("Falsche Signatur wird abgewiesen", boese.status_code == 401)

    # --- Die Arbeit lief im Hintergrund --------------------------------------
    seite = ""
    for _ in range(40):
        seite = client.get("/").get_data(as_text=True)
        if "Markenrecherche" in seite:
            break
        time.sleep(0.25)
    pruefe("Artikel steht in der Liste", "Markenrecherche: der erste Schritt" in seite)

    detail = client.get("/blog/markenrecherche-erster-schritt")
    text = detail.get_data(as_text=True)
    pruefe("Artikelseite laedt", detail.status_code == 200)
    pruefe("Markdown wurde gerendert", "<h2" in text)
    pruefe("Inhalt ist da", "Vor der Anmeldung" in text)

    pruefe("URL wurde zurueckgemeldet", len(bestaetigt) == 1, f"{len(bestaetigt)} Meldungen")
    if bestaetigt:
        pruefe(
            "Gemeldete URL stimmt",
            bestaetigt[0].get("published_url") == f"{SITE}/blog/markenrecherche-erster-schritt",
            str(bestaetigt[0].get("published_url")),
        )

    pruefe("Unbekannter Pfad ergibt 404", client.get("/blog/gibt-es-nicht").status_code == 404)
    pruefe("Pfadwechsel wird abgewiesen", client.get("/blog/../../etc").status_code in (308, 404))

    fake.shutdown()
    print("\n".join(befunde))
    misserfolge = [b for b in befunde if b.startswith("FEHL")]
    print(f"\n{len(befunde) - len(misserfolge)}/{len(befunde)} bestanden")
    return 1 if misserfolge else 0


if __name__ == "__main__":
    sys.exit(main())
