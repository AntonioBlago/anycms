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
import { istSichererSlug, listeArtikel, speichereArtikel } from '../dist/storage.js';

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
  const gespeichert = await speichereArtikel(
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
      revision: 3,
    },
    { siteUrl: 'https://example.com/', dir },
  );

  assert.ok(gespeichert);
  assert.equal(gespeichert.url, 'https://example.com/glossar/nizza-klasse-25');
  const roh = await readFile(gespeichert.pfad, 'utf8');
  // Der Doppelpunkt im Titel darf das YAML nicht zerlegen.
  assert.match(roh, /^title: "Nizza-Klasse 25: was hineingehört"$/m);
  assert.match(roh, /^visiblyArticleId: 42$/m);
  assert.match(roh, /^visiblyRevision: 3$/m);
  assert.match(roh, /# Überschrift/);

  const liste = await listeArtikel(dir);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].urlPfad, 'glossar/nizza-klasse-25');
  assert.equal(liste[0].title, 'Nizza-Klasse 25: was hineingehört');
});

test('böser Slug wird nicht geschrieben', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  const ergebnis = await speichereArtikel(
    {
      id: 43, title: 'X', slug: '../../../boese', status: 'approved',
      content_html: '<p>x</p>', meta_description: '', keywords: [],
      word_count: 1, seo_score: 0, project_id: 1,
    },
    { siteUrl: 'https://example.com', dir },
  );
  assert.equal(ergebnis, null);
  assert.deepEqual(await listeArtikel(dir), []);
});

test('leeres Verzeichnis ist keine Fehlermeldung', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anycms-'));
  assert.deepEqual(await listeArtikel(path.join(dir, 'gibt-es-nicht')), []);
});
