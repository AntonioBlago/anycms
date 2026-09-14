# anycms

Blog-Starter, die Artikel aus dem [Visibly Content Autopilot](https://app.visibly-ai.com)
empfangen. Drei Frameworks, ein Vertrag, jeder auf Railway deploybar.

| Starter | Stack | Nimm den, wenn … |
|---|---|---|
| [`apps/astro`](apps/astro) | Astro 5 (SSR, Node-Adapter) | du eine schnelle, inhaltslastige Seite willst |
| [`apps/nextjs`](apps/nextjs) | Next.js 15 (App Router) | du React ohnehin einsetzt |
| [`apps/flask`](apps/flask) | Flask 3 + [`ai-content-autopilot`](https://pypi.org/project/ai-content-autopilot/) | dein Team Python schreibt |

Alle drei tun dasselbe: Webhook entgegennehmen, Artikel selbst abholen, als
Markdown ablegen, Blog rendern, die veröffentlichte URL zurückmelden.

## Wie es funktioniert

```
Visibly: Artikel freigegeben
        │
        │  POST /api/visibly/webhook   (HMAC-SHA256 signiert)
        ▼
   [1] Signatur prüfen                 ← falsch? 401, Ende
   [2] HTTP 202 "accepted" antworten   ← SOFORT, ohne zu arbeiten
        │
        └── im Hintergrund:
            [3] GET /api/v1/articles/{id}      Artikel holen
            [4] als Markdown ablegen            CONTENT_DIR (Volume!)
            [5] POST /articles/{id}/confirm     URL zurückmelden
```

**Schritt 2 ist der entscheidende.** Visibly wartet 10 Sekunden auf die Antwort
und wiederholt die Zustellung **nicht**, wenn sie ausbleibt: der Request war ja
schon da. Wer erst antwortet, wenn der Artikel geschrieben ist, wird mehrfach
beliefert und macht dieselbe Arbeit mehrfach. Bei einem CMS, das die Artikel
übersetzt, ist das die mehrfache Rechnung. Genau dieser Fehler wurde am
14.09.2026 in Produktion gemessen: drei Zustellversuche für einen Artikel
wurden zu drei Übersetzungsläufen.

Erst **Schritt 5** macht die URL in Visibly bekannt. Ohne sie kann Visibly den
Beitrag später nicht gezielt aktualisieren.

## Einrichten

### 1. In Visibly

Projekt → Content → CMS-Verbindungen → neue Verbindung vom Typ **Webhook**:

- **Webhook-URL:** `https://deine-domain.de/api/visibly/webhook`
  (Flask: `https://deine-domain.de/webhooks/visibly`)
- **Secret:** frei wählbar, gleich gleich in die Umgebung eintragen
- **Events:** `article.approved`, `article.updated`

Dazu einen API-Key unter Einstellungen → API-Key erzeugen (`lc_…`), oder im
Projekt einen projektgebundenen Key (`cp_…`).

### 2. Umgebungsvariablen

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `VISIBLY_WEBHOOK_SECRET` | ja | Dasselbe Secret wie in der Verbindung |
| `VISIBLY_API_KEY` | ja | `lc_…` oder `cp_…` für die Pull-API |
| `SITE_URL` | ja | Öffentliche Basis-URL, z. B. `https://blog.example.com` |
| `CONTENT_DIR` | nein | Wo Artikel liegen. Default `/data/content` |
| `VISIBLY_BASE_URL` | nein | Nur für abweichende Installationen |

Flask liest zusätzlich `CONTENTPILOT_WEBHOOK_SECRET` (der Name, den das SDK
erwartet) — setze beide auf denselben Wert.

### 3. Auf Railway

1. Neues Projekt aus diesem Repo, Root-Verzeichnis auf `/` lassen.
2. **Variable `RAILWAY_DOCKERFILE_PATH`** auf `apps/<starter>/Dockerfile` setzen.
3. **Volume anlegen und auf `/data` mounten.** Ohne Volume ist Railways
   Dateisystem flüchtig: Container neu, Artikel weg.
4. Die Variablen aus der Tabelle eintragen.

Alternativ liegt in jedem Starter eine `railway.json` mit demselben Aufbau.

## Lokal ausprobieren

```bash
# Connector einmal bauen (Astro und Next.js hängen daran)
cd packages/connector-node && npm install && npm run build && npm test

# Astro
cd apps/astro && npm install && npm run build
CONTENT_DIR=/tmp/anycms SITE_URL=http://localhost:4321 \
  VISIBLY_WEBHOOK_SECRET=test VISIBLY_API_KEY=lc_test npm start

# Next.js
cd apps/nextjs && npm install && npm run build && npm start

# Flask
cd apps/flask && pip install -r requirements.txt && python app.py
```

Jeder Starter bringt einen End-to-End-Test mit, der einen signierten Webhook
gegen einen gefälschten Visibly-Server schickt und prüft, dass der Artikel
danach auf der Seite steht:

```bash
cd packages/connector-node && npm test          # 13 Unit-Tests
cd apps/astro   && npm run build && node test/e2e.mjs
cd apps/nextjs  && npm run build && node test/e2e.mjs
cd apps/flask   && python test_e2e.py
```

## Du hast schon ein CMS?

Der Connector ist bewusst eine einzige Datei. Kopiere sie in dein Projekt und
tausche das Ablegen gegen deinen eigenen Speicher:

- **Astro:** [`apps/astro/src/pages/api/visibly/webhook.ts`](apps/astro/src/pages/api/visibly/webhook.ts)
  — funktioniert unverändert in jedem Astro-Projekt mit `output: 'server'`,
  auch in fertigen Vorlagen wie
  [astro-seo-blog-template](https://github.com/kevingabeci/astro-seo-blog-template).
- **Next.js:** [`apps/nextjs/app/api/visibly/webhook/route.ts`](apps/nextjs/app/api/visibly/webhook/route.ts)
  — Node-Runtime ist Pflicht, Edge kann keine Dateien schreiben.
- **Flask/Django/FastAPI:** `pip install ai-content-autopilot` und den
  Blueprint registrieren, siehe [`apps/flask/app.py`](apps/flask/app.py).

## Mehrsprachig

Ein Visibly-Artikel trägt genau **eine** Sprache; es gibt keinen
Übersetzungs-Endpunkt. Zwei Wege:

1. **Dein CMS übersetzt.** Du bekommst den Quellartikel und erzeugst die
   übrigen Sprachen selbst.
2. **Ein Cluster je Sprache.** In Visibly bekommt jeder Cluster eigene Sprache,
   eigenes Zielland und einen eigenen Pfad-Präfix. Jeder Artikel kommt dann mit
   `content_language`, `target_country` und `url_prefix` an, und die Starter
   legen ihn unter dem passenden Pfad ab.

Die `hreflang`-Verknüpfung baut **dein CMS**: Visibly liefert Slug, Präfix und
Sprache als Bauplan, die fertige URL entsteht bei dir. Details in
[`docs/VISIBLY.md`](docs/VISIBLY.md).

## Lizenz

MIT
