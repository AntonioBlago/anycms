/**
 * End-to-End gegen den gebauten Astro-Server: ein signierter Webhook, ein
 * gefälschter Visibly-Server als Pull-Ziel, und danach muss der Artikel auf
 * der Seite stehen.
 *
 * Geprüft wird die Kette, die in Produktion gebrochen ist: quittiert der
 * Server schnell genug, holt er den Artikel selbst, und meldet er die URL
 * zurück?
 *
 * Lauf:  npm run build && node test/e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECRET = 'whsec_e2e';
const PORT = 4399;
const FAKE_PORT = 4398;
const SITE = `http://127.0.0.1:${PORT}`;

const ARTIKEL = {
  id: 77,
  title: 'Markenrecherche: der erste Schritt',
  slug: 'markenrecherche-erster-schritt',
  status: 'approved',
  content_html: '<p>Vor der Anmeldung steht die Recherche.</p>',
  content_markdown: '## Warum zuerst recherchieren\n\nVor der Anmeldung steht die Recherche.',
  meta_description: 'Warum die Recherche vor der Anmeldung kommt',
  keywords: ['markenrecherche'],
  word_count: 850,
  seo_score: 78,
  project_id: 1,
  url_prefix: '/blog/',
  content_language: 'de',
  content_format: 'markdown',
  revision: 1,
};

const bestaetigt = [];
let contentDir;
let fake;
let server;

async function warteAuf(url, versuche = 60) {
  for (let i = 0; i < versuche; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* noch nicht da */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

try {
  contentDir = await mkdtemp(path.join(tmpdir(), 'anycms-e2e-'));

  // --- Gefälschtes Visibly: liefert den Artikel und nimmt die Bestätigung an.
  fake = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/articles/77/confirm')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        bestaetigt.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, article_id: 77 }));
      });
      return;
    }
    if (req.url?.startsWith('/api/v1/articles/77')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ article: ARTIKEL }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

  // --- Der echte Astro-Server.
  server = spawn(process.execPath, ['./dist/server/entry.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      SITE_URL: SITE,
      CONTENT_DIR: contentDir,
      VISIBLY_WEBHOOK_SECRET: SECRET,
      VISIBLY_API_KEY: 'lc_test',
      VISIBLY_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[astro] ${d}`));

  assert.ok(await warteAuf(SITE), 'Astro-Server ist nicht hochgekommen');

  // --- Leerer Zustand: ehrlich, kein Fehler.
  const leer = await (await fetch(SITE)).text();
  assert.match(leer, /Noch keine Artikel/, 'Leerer Zustand fehlt');

  // --- Webhook: wird schnell quittiert?
  const koerper = JSON.stringify({ event: 'article.approved', article_id: 77 });
  const sig = `sha256=${createHmac('sha256', SECRET).update(koerper).digest('hex')}`;
  const begonnen = Date.now();
  const res = await fetch(`${SITE}/api/visibly/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig },
    body: koerper,
  });
  const dauer = Date.now() - begonnen;
  assert.equal(res.status, 202, `Erwartet 202, bekam ${res.status}`);
  assert.ok(dauer < 2000, `Antwort dauerte ${dauer}ms; Visibly gibt nach 10s auf`);

  // --- Falsche Signatur kommt nicht durch.
  const boese = await fetch(`${SITE}/api/visibly/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'sha256=falsch' },
    body: koerper,
  });
  assert.equal(boese.status, 401, 'Falsche Signatur wurde nicht abgewiesen');

  // --- Die Arbeit lief im Hintergrund: Artikel da, URL zurückgemeldet.
  let seite = '';
  for (let i = 0; i < 40; i++) {
    seite = await (await fetch(SITE)).text();
    if (seite.includes('Markenrecherche')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(seite, /Markenrecherche: der erste Schritt/, 'Artikel nicht in der Liste');

  const detail = await (await fetch(`${SITE}/blog/markenrecherche-erster-schritt`)).text();
  assert.match(detail, /Warum zuerst recherchieren/, 'Markdown wurde nicht gerendert');
  assert.match(detail, /<h2/, 'Markdown wurde nicht zu HTML');

  assert.equal(bestaetigt.length, 1, 'Veröffentlichung wurde nicht zurückgemeldet');
  assert.equal(bestaetigt[0].published_url, `${SITE}/blog/markenrecherche-erster-schritt`);

  const fehlt = await fetch(`${SITE}/blog/gibt-es-nicht`);
  assert.equal(fehlt.status, 404, 'Unbekannter Pfad ergibt keinen 404');

  console.log('E2E bestanden: 202 nach %dms, Artikel abgelegt, URL zurueckgemeldet, 404 sauber', dauer);
} finally {
  server?.kill();
  fake?.close();
  if (contentDir) await rm(contentDir, { recursive: true, force: true });
}
