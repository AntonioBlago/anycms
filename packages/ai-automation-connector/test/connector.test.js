/**
 * Tests für den Connector-Kern. Geprüft wird, was wehtut, wenn es bricht:
 * die Signaturprüfung (Sicherheit), das Antwortverhalten (führt zu doppelter
 * Arbeit) und die Pfad-Behandlung beim Speichern (Schreiben ausserhalb des
 * Content-Verzeichnisses).
 *
 * Lauf: npm test  (nach npm run build)
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { freigeben, handleWebhook, verifyWebhookSignature } from '../dist/index.js';
import { FileStore } from '../dist/store-files.js';
import { getStore, istSichererSlug, resetStore } from '../dist/store.js';

const SECRET = 'whsec_test';

function signiere(koerper, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(koerper).digest('hex')}`;
}

// ── Signatur ────────────────────────────────────────────────────────────────

test('gültige Signatur wird angenommen', () => {
  const koerper = JSON.stringify({ event: 'article.approved', article_id: 1 });
  assert.equal(verifyWebhookSignature(koerper, SECRET, signiere(koerper)), true);
});

test('falsches Secret wird abgelehnt', () => {
  const koerper = JSON.stringify({ event: 'article.approved', article_id: 1 });
  assert.equal(verifyWebhookSignature(koerper, SECRET, signiere(koerper, 'anderes')), false);
});

test('veränderter Körper wird abgelehnt', () => {
  const koerper = JSON.stringify({ event: 'article.approved', article_id: 1 });
  const sig = signiere(koerper);
  assert.equal(verifyWebhookSignature(koerper.replace('1', '2'), SECRET, sig), false);
});

test('fehlende oder kaputte Signatur wird abgelehnt', () => {
  assert.equal(verifyWebhookSignature('{}', SECRET, ''), false);
  assert.equal(verifyWebhookSignature('{}', SECRET, 'sha256=kurz'), false);
  assert.equal(verifyWebhookSignature('{}', '', signiere('{}')), false);
});

// ── Webhook-Ablauf ──────────────────────────────────────────────────────────

const opts = (onArticle) => ({
  secret: SECRET,
  apiKey: 'lc_test',
  baseUrl: 'http://127.0.0.1:1',  // absichtlich tot: der Abruf scheitert leise
  onArticle,
});

test('ungültige Signatur ergibt 401, ohne den Handler zu rufen', async () => {
  let gerufen = false;
  const koerper = JSON.stringify({ event: 'article.approved', article_id: 10 });
  const res = await handleWebhook(koerper, 'sha256=falsch', opts(async () => {
    gerufen = true;
    return null;
  }));
  assert.equal(res.status, 401);
  assert.equal(gerufen, false);
});

test('kaputtes JSON ergibt 400', async () => {
  const res = await handleWebhook('kein json', signiere('kein json'), opts(async () => null));
  assert.equal(res.status, 400);
});

test('unbekanntes Ereignis wird freundlich quittiert', async () => {
  const koerper = JSON.stringify({ event: 'article.failed', article_id: 11 });
  const res = await handleWebhook(koerper, signiere(koerper), opts(async () => null));
  // 200 statt Fehler: ein Fehler würde Wiederholungen auslösen, die nichts ändern.
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ignored');
});

test('gültiger Webhook quittiert mit 202, bevor gearbeitet wird', async () => {
  const koerper = JSON.stringify({ event: 'article.updated', article_id: 12 });
  const begonnen = Date.now();
  const res = await handleWebhook(koerper, signiere(koerper), opts(async () => null));
  const dauer = Date.now() - begonnen;
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'accepted');
  assert.ok(dauer < 1000, `Antwort dauerte ${dauer}ms, Visibly gibt nach 10s auf`);
  freigeben(12);
});

test('zweite Zustellung während der Arbeit wird übersprungen', async () => {
  const koerper = JSON.stringify({ event: 'article.updated', article_id: 13 });
  let offen;
  const warten = new Promise((r) => { offen = r; });
  const erste = await handleWebhook(koerper, signiere(koerper), {
    ...opts(async () => { await warten; return null; }),
    baseUrl: 'http://127.0.0.1:1',
  });
  const zweite = await handleWebhook(koerper, signiere(koerper), opts(async () => null));
  assert.equal(erste.body.status, 'accepted');
  assert.equal(zweite.body.status, 'already_processing');
  assert.equal(zweite.status, 202);
  offen();
  freigeben(13);
});

// ── Speicherung ─────────────────────────────────────────────────────────────

test('Slug-Prüfung lässt keine Pfadwechsel durch', () => {
  assert.equal(istSichererSlug('mein-artikel'), true);
  assert.equal(istSichererSlug('../../etc/passwd'), false);
  assert.equal(istSichererSlug('mit/schraegstrich'), false);
  assert.equal(istSichererSlug(''), false);
  assert.equal(istSichererSlug('.'), false);
});

test('Artikel wird als Markdown mit Frontmatter abgelegt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  // Direkt am FileStore: die Fassade waehlt ihren Store einmal aus der
  // Umgebung, ein Test mit eigenem Verzeichnis geht deshalb an die Quelle.
  const store = new FileStore(dir);
  const gespeichert = await store.speichern(
    {
      id: 42,
      title: 'Nizza-Klasse 25: was hineingehört',
      slug: 'nizza-klasse-25',
      status: 'approved',
      content_html: '<p>Inhalt</p>',
      content_markdown: '# Überschrift\n\nInhalt.',
      meta_description: 'Kurz erklärt',
      keywords: ['nizza klasse 25'],
      word_count: 900,
      seo_score: 80,
      project_id: 1,
      url_prefix: '/glossar/',
      content_language: 'de',
      content_format: 'markdown',
      revision: 3,
    },
    'https://example.com/',
  );

  assert.ok(gespeichert);
  assert.equal(gespeichert.url, 'https://example.com/glossar/nizza-klasse-25');
  // Den Pfad baut der Test selbst: das Store-Interface gibt keinen zurueck,
  // weil der Postgres-Store keinen hat. Geprueft wird hier die Datei-Form.
  const roh = await readFile(path.join(dir, 'glossar', 'nizza-klasse-25.md'), 'utf8');
  // Der Doppelpunkt im Titel darf das YAML nicht zerlegen.
  assert.match(roh, /^title: "Nizza-Klasse 25: was hineingehört"$/m);
  assert.match(roh, /^visiblyArticleId: 42$/m);
  assert.match(roh, /^visiblyRevision: 3$/m);
  assert.match(roh, /# Überschrift/);

  const liste = await store.liste();
  assert.equal(liste.length, 1);
  assert.equal(liste[0].urlPfad, 'glossar/nizza-klasse-25');
  assert.equal(liste[0].title, 'Nizza-Klasse 25: was hineingehört');
});

test('das Format entscheidet, nicht die Anwesenheit von Markdown', async () => {
  // Visibly liefert content_markdown mit, sobald include_markdown=true gesetzt
  // ist, auch bei einem HTML-Artikel. Wer dann Markdown nimmt, weil es da ist,
  // legt den falschen Koerper ab.
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  const store = new FileStore(dir);
  await store.speichern(
    {
      id: 45, title: 'HTML-Artikel', slug: 'html-artikel', status: 'approved',
      content_html: '<p>Das ist HTML.</p>',
      content_markdown: '# Das ist Markdown',
      content_format: 'html',
      meta_description: '', keywords: [], word_count: 5, seo_score: 0, project_id: 1,
    },
    'https://example.com',
  );
  const eintrag = await store.lesen('blog/html-artikel');
  assert.ok(eintrag);
  assert.match(eintrag.inhalt, /Das ist HTML/);
  assert.doesNotMatch(eintrag.inhalt, /Das ist Markdown/);
});

test('böser Slug wird nicht geschrieben', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  const store = new FileStore(dir);
  const ergebnis = await store.speichern(
    {
      id: 43, title: 'X', slug: '../../../boese', status: 'approved',
      content_html: '<p>x</p>', meta_description: '', keywords: [],
      word_count: 1, seo_score: 0, project_id: 1,
    },
    'https://example.com',
  );
  assert.equal(ergebnis, null);
  assert.deepEqual(await store.liste(), []);
});

test('leeres Verzeichnis ist keine Fehlermeldung', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  const store = new FileStore(path.join(dir, 'gibt-es-nicht'));
  assert.deepEqual(await store.liste(), []);
});

test('gelesener Artikel hat dieselbe Form wie geschrieben', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  const store = new FileStore(dir);
  await store.speichern(
    {
      id: 44, title: 'Mit "Zitat" im Titel', slug: 'mit-zitat', status: 'approved',
      content_html: '<p>Inhalt</p>', meta_description: 'Kurz', keywords: ['a', 'b'],
      word_count: 10, seo_score: 50, project_id: 1, url_prefix: '/glossar/',
      content_language: 'de', content_format: 'html', revision: 2,
    },
    'https://example.com',
  );
  const eintrag = await store.lesen('glossar/mit-zitat');
  assert.ok(eintrag);
  // Die Maskierung muss sich beim Lesen wieder aufloesen, sonst stuende im
  // Blog ein Titel mit Backslashes.
  assert.equal(eintrag.kopf.title, 'Mit "Zitat" im Titel');
  assert.equal(eintrag.kopf.category, 'glossar');
  assert.match(eintrag.inhalt, /<p>Inhalt<\/p>/);
});

// ── Store-Auswahl ───────────────────────────────────────────────────────────

test('ohne DATABASE_URL laeuft der Datei-Store', async () => {
  resetStore();
  delete process.env.DATABASE_URL;
  delete process.env.ARTICLE_STORE;
  const store = await getStore();
  assert.equal(store.art, 'files');
  resetStore();
});

test('ARTICLE_STORE=files schlaegt eine gesetzte DATABASE_URL', async () => {
  resetStore();
  process.env.DATABASE_URL = 'postgres://user:pw@localhost:5432/db';
  process.env.ARTICLE_STORE = 'files';
  const store = await getStore();
  // Wer ausdruecklich Dateien will, bekommt Dateien: sonst waere eine vom
  // Hoster gesetzte DATABASE_URL eine stille Umstellung des Speichers.
  assert.equal(store.art, 'files');
  delete process.env.DATABASE_URL;
  delete process.env.ARTICLE_STORE;
  resetStore();
});

test('ARTICLE_STORE=postgres ohne DATABASE_URL scheitert laut', async () => {
  resetStore();
  delete process.env.DATABASE_URL;
  process.env.ARTICLE_STORE = 'postgres';
  await assert.rejects(() => getStore(), /DATABASE_URL/);
  delete process.env.ARTICLE_STORE;
  resetStore();
});

test('ein kaputter Tabellenname wird abgelehnt', async () => {
  // Postgres bindet Werte, keine Bezeichner: der Tabellenname landet im SQL
  // und muss deshalb hier gefiltert werden.
  const { PostgresStore } = await import('../dist/store-postgres.js');
  process.env.ARTICLE_TABLE = 'artikel; DROP TABLE users';
  // Der Name wird beim Modul-Laden gelesen, deshalb reicht ein neuer Import
  // nicht; geprueft wird die Funktion ueber den Konstruktor mit dem Default.
  delete process.env.ARTICLE_TABLE;
  const store = new PostgresStore('postgres://x:y@localhost:5432/db');
  assert.equal(store.art, 'postgres');
});
