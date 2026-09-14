/**
 * Where articles live: files or Postgres, decided by one environment variable.
 *
 * **Files** are the default. Astro and Next.js read Markdown natively, humans
 * can look at it, there is no schema to migrate, and on Railway a volume is
 * enough instead of a second service.
 *
 * **Postgres** when `DATABASE_URL` is set. Pick it when you run several
 * instances (a volume attaches to exactly one service), when you want the
 * articles in the same backup as the rest of your data, or when a volume is
 * not available on your platform.
 *
 * The choice is made from the environment, not from a config file: on Railway
 * adding a Postgres service sets `DATABASE_URL` for you, and the starter
 * should follow that without a second place to edit.
 */

import type { VisiblyArticle } from './index.js';

export interface ArtikelKopf {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  updatedDate: string;
  lang: string;
  category: string;
  tags: string[];
  format: string;
  urlPfad: string;
}

export interface ArtikelEintrag {
  kopf: Record<string, string>;
  inhalt: string;
}

export interface GespeicherterArtikel {
  slug: string;
  url: string;
}

/**
 * What every backend must do. Three reads and one write: anything more would
 * be a second place to keep in sync for no gain.
 */
export interface Store {
  /** Called once before the first read or write. */
  init(): Promise<void>;
  speichern(artikel: VisiblyArticle, siteUrl: string): Promise<GespeicherterArtikel | null>;
  liste(): Promise<ArtikelKopf[]>;
  lesen(urlPfad: string): Promise<ArtikelEintrag | null>;
  /** For diagnostics and the README: which backend is actually in use. */
  readonly art: 'files' | 'postgres';
}

let gewaehlt: Store | null = null;

/**
 * The store for this process, created once.
 *
 * Postgres wins when `DATABASE_URL` is set, unless `ARTICLE_STORE=files`
 * overrides it. Both are read from the environment so a platform that injects
 * a database URL is followed automatically.
 */
export async function getStore(): Promise<Store> {
  if (gewaehlt) return gewaehlt;

  const erzwungen = (process.env.ARTICLE_STORE ?? '').toLowerCase();
  const hatDb = Boolean(process.env.DATABASE_URL);
  const nutzePostgres = erzwungen === 'postgres' || (hatDb && erzwungen !== 'files');

  if (nutzePostgres) {
    if (!process.env.DATABASE_URL) {
      throw new Error('ARTICLE_STORE=postgres, aber DATABASE_URL fehlt');
    }
    // Spaeter Import: wer Dateien nutzt, soll den Postgres-Treiber nicht laden
    // muessen, und `pg` ist deshalb eine optionale Abhaengigkeit.
    const { PostgresStore } = await import('./store-postgres.js');
    gewaehlt = new PostgresStore(process.env.DATABASE_URL);
  } else {
    const { FileStore } = await import('./store-files.js');
    gewaehlt = new FileStore();
  }

  await gewaehlt.init();
  return gewaehlt;
}

/** Nur fuer Tests: den gewaehlten Store vergessen. */
export function resetStore(): void {
  gewaehlt = null;
}

// ── Gemeinsame Helfer ───────────────────────────────────────────────────────

/**
 * Nur Zeichen, die in einem Dateinamen und in einer URL unstrittig sind.
 *
 * Der Slug kommt aus einem fremden System und landet in einem Pfad: ohne diese
 * Pruefung liesse sich mit `../` aus dem Content-Verzeichnis herausschreiben.
 */
export function istSichererSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,199}$/i.test(slug);
}

/** Die Pfadteile des Cluster-Praefix, jeder einzeln geprueft. */
export function praefixTeile(urlPrefix: string | null | undefined): string[] {
  return (urlPrefix ?? '/blog/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((t) => t && istSichererSlug(t));
}

/** Die Kategorie ist das erste Segment des Cluster-Praefix. */
export function kategorieVon(urlPrefix: string | null | undefined): string {
  return praefixTeile(urlPrefix)[0] ?? 'blog';
}

export function tagsVon(keywords: unknown[] | undefined): string[] {
  return Array.isArray(keywords)
    ? keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    : [];
}

/** Der Textkoerper: Markdown wenn das Format es sagt, sonst HTML. */
export function inhaltVon(artikel: VisiblyArticle): string {
  return artikel.content_format === 'markdown' && artikel.content_markdown
    ? artikel.content_markdown
    : (artikel.content_html ?? '');
}
