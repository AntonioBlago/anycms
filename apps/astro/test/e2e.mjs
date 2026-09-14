/**
 * End-to-end against the built Astro server: a signed webhook, a fake Visibly
 * as the pull target, and afterwards the article has to be a real post in this
 * template, with all its features working on it.
 *
 * This checks the chain that broke in production: does the server acknowledge
 * fast enough, does it fetch the article itself, does the template pick the
 * post up, and does it report the URL back?
 *
 * Run:  npm run build && node test/e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECRET = 'whsec_e2e';
const PORT = 4399;
const FAKE_PORT = 4398;
const SITE = `http://127.0.0.1:${PORT}`;

const ARTIKEL = {
  id: 77,
  title: 'Trademark research: the first step',
  slug: 'trademark-research-first-step',
  status: 'approved',
  content_html: '<p>Research comes before filing.</p>',
  content_markdown: '## Why research first\n\nResearch comes before filing.',
  meta_description: 'Why research comes before filing',
  keywords: ['trademark research', 'filing'],
  word_count: 850,
  seo_score: 78,
  project_id: 1,
  url_prefix: '/guides/',
  content_language: 'en',
  content_format: 'markdown',
  revision: 1,
};

const bestaetigt = [];
let postsDir;
let fake;
let server;

async function warteAuf(url, versuche = 80) {
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
  postsDir = await mkdtemp(path.join(tmpdir(), 'anycms-astro-e2e-'));

  // --- Fake Visibly: liefert den Artikel, nimmt die Bestaetigung an ---------
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

  server = spawn(process.execPath, ['./dist/server/entry.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      SITE_URL: SITE,
      POSTS_DIR: postsDir,
      VISIBLY_WEBHOOK_SECRET: SECRET,
      VISIBLY_API_KEY: 'lc_test',
      VISIBLY_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      VISIBLY_PUBLISH_DIRECTLY: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[astro] ${d}`));

  assert.ok(await warteAuf(SITE), 'Astro-Server ist nicht hochgekommen');

  // --- Webhook: wird schnell quittiert? -------------------------------------
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

  const boese = await fetch(`${SITE}/api/visibly/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'sha256=falsch' },
    body: koerper,
  });
  assert.equal(boese.status, 401, 'Falsche Signatur wurde nicht abgewiesen');

  // --- Die Datei muss im Format DIESER Vorlage liegen -----------------------
  let mdx = '';
  for (let i = 0; i < 40; i++) {
    try {
      mdx = await readFile(path.join(postsDir, 'trademark-research-first-step.mdx'), 'utf8');
      break;
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert.ok(mdx, 'Kein MDX geschrieben');
  // Genau diese Felder liest die Vorlage; fehlt eines, faellt der Post aus
  // Suche, RSS oder Kategorie-Seiten heraus, ohne dass es auffaellt.
  for (const feld of ['title:', 'description:', 'publishDate:', 'updateDate:',
                      'author:', 'category:', 'tags:', 'draft:', 'seoTitle:']) {
    assert.match(mdx, new RegExp(`^${feld}`, 'm'), `Frontmatter-Feld fehlt: ${feld}`);
  }
  // Der Cluster-Praefix wird zur Kategorie: /guides/ -> guides
  assert.match(mdx, /^category: "guides"$/m, 'Cluster-Praefix wurde nicht zur Kategorie');
  assert.match(mdx, /^draft: false$/m, 'VISIBLY_PUBLISH_DIRECTLY wurde nicht beachtet');
  assert.match(mdx, /^visiblyArticleId: 77$/m);
  assert.match(mdx, /^tags: \["trademark research","filing"\]$/m, 'Keywords wurden nicht zu Tags');

  // --- Und die Vorlage muss ihn ausliefern ---------------------------------
  let seite = '';
  for (let i = 0; i < 40; i++) {
    seite = await (await fetch(`${SITE}/blog/trademark-research-first-step`)).text();
    if (seite.includes('Trademark research')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(seite, /Trademark research: the first step/, 'Beitrag wird nicht ausgeliefert');
  assert.match(seite, /Research comes before filing/, 'Inhalt fehlt');

  // Die Vorlagen-Funktionen muessen den Beitrag ebenfalls kennen.
  const rss = await (await fetch(`${SITE}/rss.xml`)).text();
  assert.match(rss, /trademark-research-first-step/, 'Beitrag fehlt im RSS-Feed');
  const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
  assert.match(sitemap, /trademark-research-first-step/, 'Beitrag fehlt in der Sitemap');
  const suche = await (await fetch(`${SITE}/api/search-index.json`)).text();
  assert.match(suche, /Trademark research/, 'Beitrag fehlt im Suchindex');

  assert.equal(bestaetigt.length, 1, 'Veröffentlichung wurde nicht zurückgemeldet');
  assert.equal(bestaetigt[0].published_url, `${SITE}/blog/trademark-research-first-step`);

  console.log(
    'E2E bestanden: 202 nach %dms, MDX im Vorlagen-Format, Beitrag in Seite, RSS, Sitemap und Suche, URL zurueckgemeldet',
    dauer,
  );
} finally {
  server?.kill();
  fake?.close();
  if (postsDir) await rm(postsDir, { recursive: true, force: true });
}
