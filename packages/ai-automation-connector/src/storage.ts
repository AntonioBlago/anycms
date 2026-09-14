/**
 * The storage facade the starters import.
 *
 * It delegates to whichever backend `getStore()` picked: Markdown files by
 * default, Postgres when `DATABASE_URL` is set. Pages should not have to know
 * which one is running, so both return the same shapes.
 */

import type { VisiblyArticle } from './index.js';
import { getStore } from './store.js';

export { CONTENT_DIR, leseListe, lieskopf } from './store-files.js';
export { getStore, istSichererSlug, resetStore } from './store.js';
export type { ArtikelEintrag, ArtikelKopf, GespeicherterArtikel, Store } from './store.js';

export interface SpeicherOptionen {
  /** Öffentliche Basis-URL der Seite, für die Rückmeldung an Visibly. */
  siteUrl: string;
}

/** Einen Artikel ablegen und die öffentliche URL zurückgeben. */
export async function speichereArtikel(
  artikel: VisiblyArticle,
  { siteUrl }: SpeicherOptionen,
): Promise<{ slug: string; url: string } | null> {
  const store = await getStore();
  return store.speichern(artikel, siteUrl);
}

/** Alle abgelegten Artikel, neueste zuerst. */
export async function listeArtikel() {
  const store = await getStore();
  return store.liste();
}

/** Einen Artikel mit Inhalt lesen; `null`, wenn es ihn nicht gibt. */
export async function leseArtikel(urlPfad: string) {
  const store = await getStore();
  return store.lesen(urlPfad);
}

/** Welches Backend laeuft gerade: fuer Diagnose und Startmeldungen. */
export async function storeArt(): Promise<'files' | 'postgres'> {
  return (await getStore()).art;
}
