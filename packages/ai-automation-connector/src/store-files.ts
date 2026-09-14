/**
 * File backend: one Markdown file per article, frontmatter on top.
 *
 * The default. Astro and Next.js read this natively, humans can look at it and
 * edit it, there is no schema to migrate, and on Railway a mounted volume is
 * enough instead of a second service. Same format Hugo, Jekyll, Eleventy and
 * Astro content collections use.
 *
 * **The directory must be on a volume.** Railway's container filesystem is
 * otherwise ephemeral: new deploy, articles gone.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export const CONTENT_DIR = process.env.CONTENT_DIR ?? '/data/content';

/** Frontmatter-Werte maskieren: ein Doppelpunkt im Titel zerlegt sonst das YAML. */
function yamlWert(wert: unknown): string {
  if (wert === null || wert === undefined) return '""';
  return `"${String(wert).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class FileStore implements Store {
  readonly art = 'files' as const;

  constructor(private readonly dir: string = CONTENT_DIR) {}

  async init(): Promise<void> {
    // Das Verzeichnis darf fehlen: "noch nichts empfangen" ist kein Fehler,
    // und angelegt wird es beim ersten Schreiben.
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
    const verzeichnis = path.join(this.dir, ...teile);
    await mkdir(verzeichnis, { recursive: true });

    const jetzt = new Date().toISOString();
    const tags = tagsVon(artikel.keywords);
    const frontmatter = [
      '---',
      `title: ${yamlWert(artikel.title)}`,
      `description: ${yamlWert(artikel.meta_description)}`,
      `slug: ${yamlWert(slug)}`,
      `category: ${yamlWert(kategorieVon(artikel.url_prefix))}`,
      `pubDate: ${yamlWert(artikel.created_at ?? jetzt)}`,
      `updatedDate: ${yamlWert(artikel.updated_at ?? jetzt)}`,
      `lang: ${yamlWert(artikel.content_language ?? 'de')}`,
      `visiblyArticleId: ${artikel.id}`,
      `visiblyRevision: ${artikel.revision ?? 1}`,
      `format: ${yamlWert(artikel.content_format ?? 'html')}`,
      // Tags stehen IMMER da, auch leer: ein fehlender Schlüssel und eine
      // leere Liste sind für den Leser zwei verschiedene Aussagen.
      `tags: [${tags.map((k) => yamlWert(k)).join(', ')}]`,
      '---',
      '',
      inhaltVon(artikel),
      '',
    ].join('\n');

    // Der Dateiname ist der Slug: eine zweite Zustellung überschreibt,
    // sie dupliziert nicht.
    await writeFile(path.join(verzeichnis, `${slug}.md`), frontmatter, 'utf8');

    const urlPfad = [...teile, slug].join('/');
    return { slug, url: `${siteUrl.replace(/\/+$/, '')}/${urlPfad}` };
  }

  async liste(): Promise<ArtikelKopf[]> {
    const gefunden: ArtikelKopf[] = [];

    const durchlaufe = async (verzeichnis: string, teile: string[]): Promise<void> => {
      let eintraege;
      try {
        eintraege = await readdir(verzeichnis, { withFileTypes: true });
      } catch {
        return; // Verzeichnis gibt es noch nicht: "keine Artikel", kein Fehler.
      }
      for (const e of eintraege) {
        if (e.isDirectory()) {
          await durchlaufe(path.join(verzeichnis, e.name), [...teile, e.name]);
        } else if (e.name.endsWith('.md')) {
          const roh = await readFile(path.join(verzeichnis, e.name), 'utf8');
          const kopf = lieskopf(roh);
          const slug = e.name.replace(/\.md$/, '');
          gefunden.push({
            slug,
            urlPfad: [...teile, slug].join('/'),
            title: kopf.title ?? slug,
            description: kopf.description ?? '',
            category: kopf.category ?? teile[0] ?? 'blog',
            tags: leseListe(kopf.tags),
            lang: kopf.lang ?? 'de',
            format: kopf.format ?? 'html',
            pubDate: kopf.pubDate ?? '',
            updatedDate: kopf.updatedDate ?? kopf.pubDate ?? '',
          });
        }
      }
    };

    await durchlaufe(this.dir, []);
    return gefunden.sort((a, b) => (a.pubDate < b.pubDate ? 1 : -1));
  }

  async lesen(urlPfad: string): Promise<ArtikelEintrag | null> {
    const teile = urlPfad.split('/').filter(Boolean);
    if (!teile.length || !teile.every((t) => istSichererSlug(t))) return null;
    const pfad = path.join(this.dir, ...teile.slice(0, -1), `${teile[teile.length - 1]}.md`);
    try {
      const roh = await readFile(pfad, 'utf8');
      return {
        kopf: lieskopf(roh),
        inhalt: roh.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Eine Frontmatter-Liste `["a", "b"]` lesen.
 *
 * Bewusst kein YAML-Parser: das Format schreibt dieselbe Datei, die es liest,
 * und eine Abhängigkeit für eine Zeile in eckigen Klammern wäre teuer bezahlt.
 * Unlesbares ergibt eine leere Liste, nie einen Absturz.
 */
export function leseListe(roh: string | undefined): string[] {
  if (!roh) return [];
  const inhalt = roh.trim().replace(/^\[|\]$/g, '').trim();
  if (!inhalt) return [];
  return inhalt
    .split(',')
    .map((t) => yamlString(t))
    .filter(Boolean);
}

/**
 * Einen Frontmatter-Wert entpacken.
 *
 * Die äußeren Anführungszeichen einzeln abzuziehen und danach zu entmaskieren
 * ist falsch: bei `"was \"x\""` zählt das letzte `"` zum Escape, und übrig
 * bliebe ein einzelner Backslash. Ein Titel mit Zitat kam so verstümmelt
 * heraus (gefunden beim Vergleich mit dem Postgres-Store).
 */
export function yamlString(roh: string): string {
  const wert = roh.trim();
  if (wert.length >= 2 && wert.startsWith('"') && wert.endsWith('"')) {
    // In einem Durchgang: sequentielle replace-Aufrufe verschlucken sich an
    // einem maskierten Backslash vor einem Zitat.
    return wert.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return wert;
}

/** Frontmatter lesen. Bewusst genügsam: nur `schlüssel: "wert"` je Zeile. */
export function lieskopf(roh: string): Record<string, string> {
  const treffer = roh.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!treffer) return {};
  const aus: Record<string, string> = {};
  for (const zeile of treffer[1].split(/\r?\n/)) {
    const m = zeile.match(/^(\w+):\s*(.*)$/);
    if (m) aus[m[1]] = yamlString(m[2]);
  }
  return aus;
}
