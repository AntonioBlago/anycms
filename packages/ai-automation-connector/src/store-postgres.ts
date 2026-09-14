/**
 * Postgres backend: articles in one table instead of one directory.
 *
 * Pick this when a volume does not fit: several instances behind a load
 * balancer (a volume attaches to exactly one service), articles that belong in
 * the same backup as the rest of your data, or a platform without volumes.
 *
 * The schema is created on first use. One table, no migration tool: the shape
 * is small enough that a migration framework would be more machinery than the
 * thing it manages.
 */

import type { VisiblyArticle } from './index.js';
import {
  inhaltVon,
  istSichererSlug,
  kategorieVon,
  praefixTeile,
  tagsVon,
  type ArtikelEintrag,
  type ArtikelKopf,
  type GespeicherterArtikel,
  type Store,
} from './store.js';

const TABELLE = process.env.ARTICLE_TABLE ?? 'anycms_articles';

/**
 * Der Tabellenname kommt aus der Umgebung und laesst sich nicht als Parameter
 * binden: Postgres bindet Werte, keine Bezeichner. Also muss er hier hart
 * gefiltert werden, sonst waere er eine SQL-Injektion mit Ansage.
 */
function sichererTabellenname(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) {
    throw new Error(`ARTICLE_TABLE ist kein gueltiger Bezeichner: ${JSON.stringify(name)}`);
  }
  return name;
}

export class PostgresStore implements Store {
  readonly art = 'postgres' as const;
  private pool: import('pg').Pool | null = null;
  private readonly tabelle: string;

  constructor(private readonly url: string) {
    this.tabelle = sichererTabellenname(TABELLE);
  }

  async init(): Promise<void> {
    let pg: typeof import('pg');
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'DATABASE_URL ist gesetzt, aber das Paket "pg" fehlt. '
        + 'Installiere es (npm install pg) oder setze ARTICLE_STORE=files.',
      );
    }
    // pg ist CommonJS: der Default-Export traegt die Klassen.
    const Pool = (pg.default ?? pg).Pool;
    this.pool = new Pool({
      connectionString: this.url,
      // Railway und die meisten verwalteten Datenbanken sprechen TLS mit einem
      // Zertifikat, das der Client nicht kennt. Ohne diese Zeile scheitert die
      // Verbindung mit "self-signed certificate".
      ssl: this.url.includes('localhost') || this.url.includes('127.0.0.1')
        ? undefined
        : { rejectUnauthorized: false },
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tabelle} (
        url_path      TEXT PRIMARY KEY,
        slug          TEXT NOT NULL,
        article_id    INTEGER,
        title         TEXT NOT NULL DEFAULT '',
        description   TEXT NOT NULL DEFAULT '',
        category      TEXT NOT NULL DEFAULT 'blog',
        tags          TEXT[] NOT NULL DEFAULT '{}',
        lang          TEXT NOT NULL DEFAULT 'de',
        format        TEXT NOT NULL DEFAULT 'html',
        body          TEXT NOT NULL DEFAULT '',
        revision      INTEGER NOT NULL DEFAULT 1,
        pub_date      TIMESTAMPTZ,
        updated_date  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Die Liste sortiert immer nach Datum, die Filter gehen ueber Kategorie.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.tabelle}_pub_date_idx ON ${this.tabelle} (pub_date DESC)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.tabelle}_category_idx ON ${this.tabelle} (category)`,
    );
  }

  private get db(): import('pg').Pool {
    if (!this.pool) throw new Error('PostgresStore.init() wurde nicht aufgerufen');
    return this.pool;
  }

  async speichern(
    artikel: VisiblyArticle,
    siteUrl: string,
  ): Promise<GespeicherterArtikel | null> {
    const slug = (artikel.slug ?? '').trim();
    if (!istSichererSlug(slug)) {
      console.warn(`[visibly] Slug abgelehnt: ${JSON.stringify(slug)}`);
      return null;
    }

    const teile = praefixTeile(artikel.url_prefix);
    const urlPfad = [...teile, slug].join('/');
    const jetzt = new Date().toISOString();

    // Der Pfad ist der Schluessel: eine zweite Zustellung desselben Artikels
    // aktualisiert, sie legt keinen zweiten an.
    await this.db.query(
      `INSERT INTO ${this.tabelle}
         (url_path, slug, article_id, title, description, category, tags,
          lang, format, body, revision, pub_date, updated_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (url_path) DO UPDATE SET
         slug = EXCLUDED.slug,
         article_id = EXCLUDED.article_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         tags = EXCLUDED.tags,
         lang = EXCLUDED.lang,
         format = EXCLUDED.format,
         body = EXCLUDED.body,
         revision = EXCLUDED.revision,
         updated_date = EXCLUDED.updated_date`,
      [
        urlPfad,
        slug,
        artikel.id,
        artikel.title ?? '',
        artikel.meta_description ?? '',
        kategorieVon(artikel.url_prefix),
        tagsVon(artikel.keywords),
        artikel.content_language ?? 'de',
        artikel.content_format ?? 'html',
        inhaltVon(artikel),
        artikel.revision ?? 1,
        artikel.created_at ?? jetzt,
        artikel.updated_at ?? jetzt,
      ],
    );

    return { slug, url: `${siteUrl.replace(/\/+$/, '')}/${urlPfad}` };
  }

  async liste(): Promise<ArtikelKopf[]> {
    const res = await this.db.query(
      `SELECT url_path, slug, title, description, category, tags, lang, format,
              pub_date, updated_date
         FROM ${this.tabelle}
        ORDER BY pub_date DESC NULLS LAST, url_path`,
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      slug: String(r.slug),
      urlPfad: String(r.url_path),
      title: String(r.title ?? ''),
      description: String(r.description ?? ''),
      category: String(r.category ?? 'blog'),
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      lang: String(r.lang ?? 'de'),
      format: String(r.format ?? 'html'),
      pubDate: iso(r.pub_date),
      updatedDate: iso(r.updated_date) || iso(r.pub_date),
    }));
  }

  async lesen(urlPfad: string): Promise<ArtikelEintrag | null> {
    // Der Pfad kommt aus der URL: auch hier gilt die Slug-Regel, damit ein
    // Aufruf nichts anderes adressieren kann als einen Artikel.
    const teile = urlPfad.split('/').filter(Boolean);
    if (!teile.length || !teile.every((t) => istSichererSlug(t))) return null;

    const res = await this.db.query(
      `SELECT url_path, slug, title, description, category, tags, lang, format,
              body, pub_date, updated_date
         FROM ${this.tabelle} WHERE url_path = $1`,
      [teile.join('/')],
    );
    if (res.rowCount === 0) return null;

    const r = res.rows[0] as Record<string, unknown>;
    return {
      // Dieselbe Form wie beim Datei-Store: die Seiten sollen nicht wissen
      // muessen, woher ein Artikel kommt.
      kopf: {
        title: String(r.title ?? ''),
        description: String(r.description ?? ''),
        slug: String(r.slug),
        category: String(r.category ?? 'blog'),
        lang: String(r.lang ?? 'de'),
        format: String(r.format ?? 'html'),
        pubDate: iso(r.pub_date),
        updatedDate: iso(r.updated_date) || iso(r.pub_date),
        tags: JSON.stringify(Array.isArray(r.tags) ? r.tags : []),
      },
      inhalt: String(r.body ?? ''),
    };
  }
}

/** Ein Zeitstempel als ISO-String; leer, wenn keiner da ist. */
function iso(wert: unknown): string {
  if (!wert) return '';
  if (wert instanceof Date) return wert.toISOString();
  return String(wert);
}
