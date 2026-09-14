/**
 * End-to-end against the built Next.js server.
 *
 * Checks the delivery chain (signed webhook, fast 202, background pull, URL
 * reported back) AND that the blog around it works on the delivered article:
 * SEO metadata, JSON-LD, category and tag pages, search index, RSS, sitemap,
 * robots and pagination.
 *
 * Run:  npm run build && node test/e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECRET = 'whsec_e2e';
const PORT = 3399;
const FAKE_PORT = 3398;
const SITE = `http://127.0.0.1:${PORT}`;

const ARTIKEL = {
  id: 99,
  title: 'Trademark research: the first step',
  slug: 'trademark-research-first-step',
  status: 'approved',
  content_html: '<p>Research comes before filing.</p>',
  content_markdown:
    '## Why research first\n\nResearch comes before filing.\n\n### What the register shows\n\nEverything already protected.',
  meta_description: 'Why research comes before filing',
  keywords: ['trademark research', 'filing'],
  word_count: 850,
  seo_score: 78,
  project_id: 1,
  url_prefix: '/guides/',
  content_language: 'en',
  content_format: 'markdown',
  revision: 1,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-10T10:00:00Z',
};

const bestaetigt = [];
const befunde = [];
let contentDir;
let fake;
let server;

function pruefe(name, ok, zusatz = '') {
  befunde.push(`${ok ? 'OK  ' : 'FEHL'}  ${name}${zusatz ? ` - ${zusatz}` : ''}`);
}

async function warteAuf(url, versuche = 80) {
  for (let i = 0; i < versuche; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* noch nicht da */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const hole = async (pfad) => (await fetch(`${SITE}${pfad}`)).text();

try {
  contentDir = await mkdtemp(path.join(tmpdir(), 'anycms-next-e2e-'));

  fake = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/articles/99/confirm')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        bestaetigt.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, article_id: 99 }));
      });
      return;
    }
    if (req.url?.startsWith('/api/v1/articles/99')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ article: ARTIKEL }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

  // server.js liegt in der WURZEL des standalone-Ordners: dieses Repo ist kein
  // npm-Workspace, also erkennt Next.js keine Monorepo-Wurzel.
  server = spawn(process.execPath, ['.next/standalone/server.js'], {
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(PORT),
      SITE_URL: SITE,
      SITE_NAME: 'Test Blog',
      CONTENT_DIR: contentDir,
      VISIBLY_WEBHOOK_SECRET: SECRET,
      VISIBLY_API_KEY: 'lc_test',
      VISIBLY_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`));

  assert.ok(await warteAuf(SITE), 'Next.js-Server ist nicht hochgekommen');

  // ── Leerer Zustand ───────────────────────────────────────────────────────
  pruefe('Leerer Zustand ist ehrlich', (await hole('/')).includes('No articles yet'));

  // ── Zustellung ───────────────────────────────────────────────────────────
  const koerper = JSON.stringify({ event: 'article.approved', article_id: 99 });
  const sig = `sha256=${createHmac('sha256', SECRET).update(koerper).digest('hex')}`;
  const begonnen = Date.now();
  const res = await fetch(`${SITE}/api/visibly/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig },
    body: koerper,
  });
  const dauer = Date.now() - begonnen;
  pruefe('Webhook quittiert mit 202', res.status === 202, `bekam ${res.status}`);
  pruefe('Antwort kommt sofort', dauer < 2000, `${dauer}ms`);

  const boese = await fetch(`${SITE}/api/visibly/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'sha256=falsch' },
    body: koerper,
  });
  pruefe('Falsche Signatur wird abgewiesen', boese.status === 401);

  // ── Warten, bis der Hintergrundlauf durch ist ────────────────────────────
  let start = '';
  for (let i = 0; i < 40; i++) {
    start = await hole('/');
    if (start.includes('Trademark research')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  pruefe('Artikel steht in der Liste', start.includes('Trademark research: the first step'));
  pruefe('Lesezeit wird angezeigt', /\d+ min read/.test(start));
  pruefe('URL wurde zurueckgemeldet', bestaetigt.length === 1);
  pruefe(
    'Gemeldete URL stimmt',
    bestaetigt[0]?.published_url === `${SITE}/guides/trademark-research-first-step`,
    String(bestaetigt[0]?.published_url),
  );

  // ── Artikelseite: SEO ────────────────────────────────────────────────────
  const detail = await hole('/guides/trademark-research-first-step');
  pruefe('Markdown wurde gerendert', detail.includes('<h2'));
  pruefe('Ueberschriften haben Anker', /<h2[^>]*id="why-research-first"/.test(detail));
  pruefe('Inhaltsverzeichnis erscheint', detail.includes('Contents'));
  pruefe('Canonical gesetzt', detail.includes(`${SITE}/guides/trademark-research-first-step"`));
  pruefe('Meta-Description gesetzt', detail.includes('Why research comes before filing'));
  pruefe('Open Graph gesetzt', detail.includes('og:title') || detail.includes('property="og:'));
  pruefe('JSON-LD BlogPosting', detail.includes('"@type":"BlogPosting"'));
  pruefe('JSON-LD Breadcrumb', detail.includes('"@type":"BreadcrumbList"'));
  pruefe('dateModified im JSON-LD', detail.includes('"dateModified"'));
  pruefe('Kategorie verlinkt', detail.includes('/category/guides'));
  pruefe('Tags verlinkt', detail.includes('/tag/trademark%20research'));

  // ── Uebersichtsseiten ────────────────────────────────────────────────────
  pruefe('Kategorie-Seite listet den Artikel',
    (await hole('/category/guides')).includes('Trademark research'));
  pruefe('Tag-Seite listet den Artikel',
    (await hole('/tag/filing')).includes('Trademark research'));
  pruefe('Kategorien-Uebersicht kennt die Kategorie',
    (await hole('/categories')).includes('guides'));
  pruefe('Tag-Uebersicht kennt das Tag',
    (await hole('/tags')).includes('filing'));

  // ── Feeds und Index ──────────────────────────────────────────────────────
  const rss = await hole('/rss.xml');
  pruefe('RSS enthaelt den Artikel', rss.includes('trademark-research-first-step'));
  pruefe('RSS ist wohlgeformt', rss.startsWith('<?xml') && rss.includes('</rss>'));
  const sitemap = await hole('/sitemap.xml');
  pruefe('Sitemap enthaelt den Artikel', sitemap.includes('trademark-research-first-step'));
  pruefe('Sitemap fuehrt lastmod', sitemap.includes('<lastmod>'));
  const robots = await hole('/robots.txt');
  pruefe('robots.txt verweist auf die Sitemap', robots.includes('sitemap.xml'));
  pruefe('robots.txt sperrt die Suche', robots.includes('/search'));
  const index = await hole('/api/search-index.json');
  pruefe('Suchindex enthaelt den Artikel', index.includes('Trademark research'));
  pruefe('Suchindex traegt den Text', index.includes('Research comes before filing'));

  // ── Das Styling muss wirklich ausgeliefert werden ────────────────────────
  // `output: standalone` kopiert .next/static NICHT mit. Ohne diesen Schritt
  // startet der Server, liefert HTML und laedt kein CSS: im Build gruen, im
  // Browser nackt. Real passiert beim ersten Screenshot dieses Starters.
  const cssPfade = [...start.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
  pruefe('Seite bindet ein Stylesheet ein', cssPfade.length > 0);
  if (cssPfade.length) {
    const cssRes = await fetch(`${SITE}${cssPfade[0]}`);
    const css = await cssRes.text();
    pruefe('Stylesheet wird ausgeliefert', cssRes.status === 200, `HTTP ${cssRes.status}`);
    pruefe('Stylesheet traegt die Variablen', css.includes('--accent'));
  }

  // ── Fehlerfaelle ─────────────────────────────────────────────────────────
  pruefe('Unbekannter Artikel ergibt 404',
    (await fetch(`${SITE}/guides/gibt-es-nicht`)).status === 404);
  pruefe('Leere Kategorie ergibt 404',
    (await fetch(`${SITE}/category/gibtsnicht`)).status === 404);
  pruefe('Seite jenseits des Bestands ergibt 404',
    (await fetch(`${SITE}/page/99`)).status === 404);
  pruefe('Suchseite laedt', (await fetch(`${SITE}/search`)).status === 200);

  console.log(befunde.join('\n'));
  const fehler = befunde.filter((b) => b.startsWith('FEHL'));
  console.log(`\n${befunde.length - fehler.length}/${befunde.length} bestanden (202 nach ${dauer}ms)`);
  if (fehler.length) process.exitCode = 1;
} finally {
  server?.kill();
  fake?.close();
  if (contentDir) await rm(contentDir, { recursive: true, force: true });
}
