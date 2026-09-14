/**
 * Tests für den Postgres-Store gegen eine ECHTE Datenbank.
 *
 * Ein Fake-Client würde nur die eigene Logik prüfen, nicht das SQL: Tippfehler
 * im Schema, ein falsches ON CONFLICT oder ein Typ, den Postgres anders liest
 * als gedacht, fielen erst im Betrieb auf.
 *
 * Läuft nur mit `TEST_DATABASE_URL`, sonst werden die Tests übersprungen. Der
 * Container dafür:
 *
 *   docker run -d --name anycms-pg -e POSTGRES_PASSWORD=testpw \
 *     -e POSTGRES_DB=anycms_test -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:testpw@127.0.0.1:55432/anycms_test \
 *     node --test test/postgres.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const URL = process.env.TEST_DATABASE_URL;
const ueberspringen = { skip: URL ? false : 'TEST_DATABASE_URL nicht gesetzt' };

/** Eine eigene Tabelle je Lauf: parallele Läufe stören sich nicht. */
function frischerStore(suffix) {
  process.env.ARTICLE_TABLE = `anycms_test_${suffix}`;
  return import('../dist/store-postgres.js').then(async (m) => {
    // Das Modul liest ARTICLE_TABLE beim Laden; der Cache-Buster erzwingt ein
    // neues Modul mit dem neuen Namen.
    const frisch = await import(`../dist/store-postgres.js?v=${suffix}`);
    const store = new frisch.PostgresStore(URL);
    await store.init();
    return store;
  });
}

const artikel = (ueber = {}) => ({
  id: 1,
  title: 'Nizza-Klasse 25: was hineingehört',
  slug: 'nizza-klasse-25',
  status: 'approved',
  content_html: '<p>Inhalt</p>',
  content_markdown: '## Überschrift\n\nInhalt.',
  content_format: 'markdown',
  meta_description: 'Kurz erklärt',
  keywords: ['nizza klasse 25', 'marke'],
  word_count: 900,
  seo_score: 80,
  project_id: 1,
  url_prefix: '/glossar/',
  content_language: 'de',
  revision: 3,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-05T10:00:00.000Z',
  ...ueber,
});

test('Schema wird angelegt und ein Artikel ist danach lesbar', ueberspringen, async () => {
  const store = await frischerStore('a');
  const gespeichert = await store.speichern(artikel(), 'https://example.com/');
  assert.ok(gespeichert);
  assert.equal(gespeichert.url, 'https://example.com/glossar/nizza-klasse-25');

  const eintrag = await store.lesen('glossar/nizza-klasse-25');
  assert.ok(eintrag);
  // Umlaute und Doppelpunkte müssen unverändert zurückkommen: sie sind der
  // Regelfall, nicht die Ausnahme.
  assert.equal(eintrag.kopf.title, 'Nizza-Klasse 25: was hineingehört');
  assert.equal(eintrag.kopf.category, 'glossar');
  assert.equal(eintrag.kopf.format, 'markdown');
  assert.match(eintrag.inhalt, /## Überschrift/);
  assert.deepEqual(JSON.parse(eintrag.kopf.tags), ['nizza klasse 25', 'marke']);
});

test('zweite Zustellung aktualisiert, sie dupliziert nicht', ueberspringen, async () => {
  const store = await frischerStore('b');
  await store.speichern(artikel(), 'https://example.com');
  await store.speichern(
    artikel({ title: 'Neuer Titel', revision: 4, content_markdown: '## Neu' }),
    'https://example.com',
  );

  const liste = await store.liste();
  assert.equal(liste.length, 1, 'aus zwei Zustellungen wurden zwei Zeilen');
  assert.equal(liste[0].title, 'Neuer Titel');
  const eintrag = await store.lesen('glossar/nizza-klasse-25');
  assert.match(eintrag.inhalt, /## Neu/);
});

test('Liste kommt neueste zuerst', ueberspringen, async () => {
  const store = await frischerStore('c');
  await store.speichern(
    artikel({ id: 1, slug: 'alt', created_at: '2026-01-01T00:00:00.000Z' }),
    'https://example.com',
  );
  await store.speichern(
    artikel({ id: 2, slug: 'neu', created_at: '2026-09-01T00:00:00.000Z' }),
    'https://example.com',
  );
  const liste = await store.liste();
  assert.deepEqual(liste.map((p) => p.slug), ['neu', 'alt']);
});

test('böser Slug wird nicht geschrieben', ueberspringen, async () => {
  const store = await frischerStore('d');
  const ergebnis = await store.speichern(
    artikel({ slug: '../../../boese' }),
    'https://example.com',
  );
  assert.equal(ergebnis, null);
  assert.deepEqual(await store.liste(), []);
});

test('ein Lesepfad ausserhalb der Slug-Regel ergibt null', ueberspringen, async () => {
  const store = await frischerStore('e');
  await store.speichern(artikel(), 'https://example.com');
  assert.equal(await store.lesen('../../etc/passwd'), null);
  assert.equal(await store.lesen(''), null);
});

test('ein Artikel ohne Tags liefert eine leere Liste, nicht null', ueberspringen, async () => {
  const store = await frischerStore('f');
  await store.speichern(artikel({ keywords: [] }), 'https://example.com');
  const liste = await store.liste();
  // Nicht null und nicht undefined: die Seiten iterieren darüber.
  assert.deepEqual(liste[0].tags, []);
});

test('HTML-Artikel speichert HTML, auch wenn Markdown mitkommt', ueberspringen, async () => {
  const store = await frischerStore('g');
  await store.speichern(
    artikel({ content_format: 'html', content_html: '<p>Das ist HTML.</p>' }),
    'https://example.com',
  );
  const eintrag = await store.lesen('glossar/nizza-klasse-25');
  assert.match(eintrag.inhalt, /Das ist HTML/);
  assert.doesNotMatch(eintrag.inhalt, /Überschrift/);
});

test('ein kaputter Tabellenname wird abgelehnt', ueberspringen, async () => {
  // Postgres bindet Werte, keine Bezeichner: der Tabellenname landet im SQL
  // und muss deshalb gefiltert werden, sonst wäre er eine Injektion mit Ansage.
  process.env.ARTICLE_TABLE = 'artikel"; DROP TABLE users; --';
  const m = await import('../dist/store-postgres.js?v=boese');
  assert.throws(() => new m.PostgresStore(URL), /ARTICLE_TABLE/);
  delete process.env.ARTICLE_TABLE;
});
