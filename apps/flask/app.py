"""anycms Flask-Starter: Blog, der Visibly-Artikel empfängt.

Der Connector ist hier kein eigener Code, sondern das Paket
``ai-content-autopilot`` (ab 1.1.0). Es prüft die HMAC-Signatur, quittiert mit
HTTP 202 und holt den Artikel danach im Hintergrund über die Pull-API. Genau
diese Reihenfolge ist der Punkt: Visibly wartet 10 Sekunden auf die Antwort und
wiederholt NICHT, wenn sie ausbleibt. Wer erst antwortet, wenn der Artikel
geschrieben ist, wird mehrfach beliefert und macht dieselbe Arbeit mehrfach.

Artikel liegen als Markdown-Dateien unter ``CONTENT_DIR``. **Das Verzeichnis
muss auf einem Railway-Volume liegen**, sonst sind die Artikel nach dem
nächsten Deploy weg.
"""
from __future__ import annotations

import os
import re
from datetime import UTC, datetime
from pathlib import Path

import markdown
from ai_content_autopilot import configure_visibly, contentpilot_webhook_bp
from ai_content_autopilot.client import VisiblyClient
from flask import Flask, Response, abort, render_template

CONTENT_DIR = Path(os.environ.get("CONTENT_DIR", "/data/content"))
SITE_URL = os.environ.get("SITE_URL", "http://localhost:8080").rstrip("/")

#: Slug-Prüfung. Der Slug kommt aus einem fremden System und landet in einem
#: Pfad: ohne diese Prüfung liesse sich mit ``../`` aus dem Verzeichnis
#: herausschreiben.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,199}$", re.IGNORECASE)


def _yaml_wert(wert: object) -> str:
    """Frontmatter maskieren: ein Doppelpunkt im Titel zerlegt sonst das YAML."""
    s = "" if wert is None else str(wert)
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _sichere_teile(pfad: str) -> list[str]:
    """Pfadteile, die alle der Slug-Regel genügen; sonst leer."""
    teile = [t for t in pfad.split("/") if t]
    return teile if teile and all(SLUG_RE.match(t) for t in teile) else []


def speichere_artikel(artikel: dict) -> str | None:
    """Artikel als Markdown ablegen und die öffentliche URL zurückgeben.

    Der Dateiname ist der Slug: ein zweiter Aufruf für denselben Artikel
    überschreibt, er dupliziert nicht.
    """
    slug = (artikel.get("slug") or "").strip()
    if not SLUG_RE.match(slug):
        print(f"[visibly] Slug abgelehnt: {slug!r}")
        return None

    praefix = (artikel.get("url_prefix") or "/blog/").strip("/")
    teile = [t for t in praefix.split("/") if t and SLUG_RE.match(t)]
    ordner = CONTENT_DIR.joinpath(*teile)
    ordner.mkdir(parents=True, exist_ok=True)

    inhalt = (artikel.get("content_markdown") or "").strip() or artikel.get("content_html") or ""
    jetzt = datetime.now(UTC).isoformat()
    kopf = "\n".join(
        [
            "---",
            f"title: {_yaml_wert(artikel.get('title'))}",
            f"description: {_yaml_wert(artikel.get('meta_description'))}",
            f"slug: {_yaml_wert(slug)}",
            f"pubDate: {_yaml_wert(artikel.get('created_at') or jetzt)}",
            f"updatedDate: {_yaml_wert(artikel.get('updated_at') or jetzt)}",
            f"lang: {_yaml_wert(artikel.get('content_language') or 'de')}",
            f"visiblyArticleId: {artikel.get('id')}",
            f"visiblyRevision: {artikel.get('revision') or 1}",
            f"format: {_yaml_wert(artikel.get('content_format') or 'html')}",
            "---",
            "",
        ]
    )
    (ordner / f"{slug}.md").write_text(kopf + inhalt + "\n", encoding="utf-8")
    return f"{SITE_URL}/{'/'.join([*teile, slug])}"


def _lies_kopf(roh: str) -> tuple[dict[str, str], str]:
    """Frontmatter + Rest. Bewusst genügsam: nur ``schlüssel: "wert"`` je Zeile."""
    treffer = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", roh, re.S)
    if not treffer:
        return {}, roh
    kopf: dict[str, str] = {}
    for zeile in treffer.group(1).splitlines():
        m = re.match(r"^(\w+):\s*(.*)$", zeile)
        if m:
            kopf[m.group(1)] = m.group(2).strip('"').replace('\\"', '"')
    return kopf, roh[treffer.end():]


def liste_artikel() -> list[dict[str, str]]:
    """Alle abgelegten Artikel, neueste zuerst."""
    gefunden: list[dict[str, str]] = []
    if not CONTENT_DIR.exists():
        return gefunden  # noch nichts empfangen ist kein Fehler
    for datei in CONTENT_DIR.rglob("*.md"):
        kopf, _ = _lies_kopf(datei.read_text(encoding="utf-8"))
        rel = datei.relative_to(CONTENT_DIR).with_suffix("")
        gefunden.append(
            {
                "title": kopf.get("title") or datei.stem,
                "description": kopf.get("description", ""),
                "pubDate": kopf.get("pubDate", ""),
                "urlPfad": rel.as_posix(),
            }
        )
    return sorted(gefunden, key=lambda a: a["pubDate"], reverse=True)


def _handler(artikel: dict) -> bool:
    """Wird vom SDK im Hintergrund gerufen, nachdem der Webhook quittiert ist."""
    url = speichere_artikel(artikel)
    if not url:
        return False
    # Erst die Rückmeldung macht die URL in Visibly bekannt; ohne sie kann
    # Visibly den Beitrag später nicht gezielt aktualisieren.
    try:
        VisiblyClient(
            api_key=os.environ.get("VISIBLY_API_KEY", ""),
            base_url=os.environ.get("VISIBLY_BASE_URL", "https://app.visibly-ai.com"),
        ).confirm_published(artikel["id"], url)
    except Exception as e:  # noqa: BLE001 - eine fehlende Rueckmeldung ist kein Datenverlust
        print(f"[visibly] Rueckmeldung fehlgeschlagen: {e}")
    return True


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

    @app.get("/")
    def start() -> str:
        return render_template("index.html", artikel=liste_artikel())

    @app.get("/health")
    def health() -> Response:
        return Response('{"status":"ok"}', mimetype="application/json")

    @app.get("/<path:pfad>")
    def artikelseite(pfad: str) -> str:
        teile = _sichere_teile(pfad)
        if not teile:
            abort(404)
        datei = CONTENT_DIR.joinpath(*teile[:-1], f"{teile[-1]}.md")
        if not datei.is_file():
            abort(404)
        kopf, inhalt = _lies_kopf(datei.read_text(encoding="utf-8"))
        # Visibly liefert je nach Cluster Markdown ODER HTML.
        gerendert = (
            markdown.markdown(inhalt, extensions=["extra"])
            if kopf.get("format") == "markdown"
            else inhalt
        )
        return render_template("artikel.html", kopf=kopf, inhalt=gerendert)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))  # noqa: S104
