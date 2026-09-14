/**
 * Artikel als Markdown-Dateien ablegen.
 *
 * Warum Dateien und keine Datenbank: Astro und Next.js lesen Markdown nativ,
 * Menschen können hineinsehen, es gibt kein Schema zu migrieren, und auf
 * Railway genügt ein Volume statt eines zweiten Dienstes.
 *
 * **Das Verzeichnis MUSS auf einem Volume liegen.** Railways Dateisystem ist
 * sonst flüchtig: Container neu, Artikel weg. `CONTENT_DIR` zeigt deshalb per
 * Default auf `/data/content`, den üblichen Mount-Punkt.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { VisiblyArticle } from './index.js';

export const CONTENT_DIR = process.env.CONTENT_DIR ?? '/data/content';

/**
 * Nur Zeichen, die in einem Dateinamen unstrittig sind.
 *
 * Der Slug kommt aus einem fremden System und landet in einem Pfad: ohne
 * diese Prüfung liesse sich mit `../` aus dem Content-Verzeichnis
 * herausschreiben.
 */
export function istSichererSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,199}$/i.test(slug);
}

/** Frontmatter-Werte maskieren: ein Doppelpunkt im Titel zerlegt sonst das YAML. */
function yamlWert(wert: unknown): string {
  if (wert === null || wert === undefined) return '';
  const s = String(wert);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface GespeicherterArtikel {
  slug: string;
  pfad: string;
  url: string;
}

export interface SpeicherOptionen {
  /** Öffentliche Basis-URL der Seite, für die Rückmeldung an Visibly. */
  siteUrl: string;
  /** Verzeichnis; Default `CONTENT_DIR`. */
  dir?: string;
}

/**
 * Einen Artikel als Markdown mit Frontmatter schreiben.
 *
 * Der Dateiname ist der Slug, also ist ein zweiter Aufruf für denselben
 * Artikel ein Überschreiben und kein Duplikat. Der Pfad-Präfix des Clusters
 * (`url_prefix`) wird zum Unterverzeichnis: so landet `/glossar/` getrennt von
 * `/blog/`, und die URL entsteht nach derselben Regel.
 */
export async function speichereArtikel(
  artikel: VisiblyArticle,
  { siteUrl, dir = CONTENT_DIR }: SpeicherOptionen,
): Promise<GespeicherterArtikel | null> {
  const slug = (artikel.slug || '').trim();
  if (!istSichererSlug(slug)) {
    console.warn(`[visibly] Slug abgelehnt: ${JSON.stringify(slug)}`);
    return null;
  }

  const praefix = (artikel.url_prefix || '/blog/').replace(/^\/+|\/+$/g, '');
  // Auch der Präfix kommt von aussen und darf nicht aus dem Verzeichnis führen.
  const sicherePraefixTeile = praefix
    .split('/')
    .filter((t) => t && istSichererSlug(t));
  const unterverzeichnis = path.join(dir, ...sicherePraefixTeile);
  await mkdir(unterverzeichnis, { recursive: true });

  const inhalt = artikel.content_markdown?.trim() || artikel.content_html || '';
  const frontmatter = [
    '---',
    `title: ${yamlWert(artikel.title)}`,
    `description: ${yamlWert(artikel.meta_description)}`,
    `slug: ${yamlWert(slug)}`,
    `pubDate: ${yamlWert(artikel.created_at ?? new Date().toISOString())}`,
    `updatedDate: ${yamlWert(artikel.updated_at ?? new Date().toISOString())}`,
    `lang: ${yamlWert(artikel.content_language ?? 'de')}`,
    `visiblyArticleId: ${artikel.id}`,
    // Die Revision zählt in Visibly bei jedem Schreibvorgang hoch. Sie hier zu
    // führen macht sichtbar, welcher Stand vorliegt.
    `visiblyRevision: ${artikel.revision ?? 1}`,
    `format: ${yamlWert(artikel.content_format ?? 'html')}`,
    ...(Array.isArray(artikel.keywords) && artikel.keywords.length
      ? [`keywords: [${artikel.keywords.map((k) => yamlWert(k)).join(', ')}]`]
      : []),
    '---',
    '',
    inhalt,
    '',
  ].join('\n');

  const pfad = path.join(unterverzeichnis, `${slug}.md`);
  await writeFile(pfad, frontmatter, 'utf8');

  const pfadTeil = [...sicherePraefixTeile, slug].join('/');
  const url = `${siteUrl.replace(/\/+$/, '')}/${pfadTeil}`;
  return { slug, pfad, url };
}

export interface ArtikelKopf {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  lang: string;
  pfad: string;
  urlPfad: string;
}

/** Alle abgelegten Artikel lesen, neueste zuerst. */
export async function listeArtikel(dir = CONTENT_DIR): Promise<ArtikelKopf[]> {
  const gefunden: ArtikelKopf[] = [];

  async function durchlaufe(verzeichnis: string, teile: string[]): Promise<void> {
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
        const pfad = path.join(verzeichnis, e.name);
        const roh = await readFile(pfad, 'utf8');
        const kopf = lieskopf(roh);
        const slug = e.name.replace(/\.md$/, '');
        gefunden.push({
          slug,
          title: kopf.title ?? slug,
          description: kopf.description ?? '',
          pubDate: kopf.pubDate ?? '',
          lang: kopf.lang ?? 'de',
          pfad,
          urlPfad: [...teile, slug].join('/'),
        });
      }
    }
  }

  await durchlaufe(dir, []);
  return gefunden.sort((a, b) => (a.pubDate < b.pubDate ? 1 : -1));
}

/** Frontmatter lesen. Bewusst genügsam: nur `schlüssel: "wert"` je Zeile. */
function lieskopf(roh: string): Record<string, string> {
  const treffer = roh.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!treffer) return {};
  const aus: Record<string, string> = {};
  for (const zeile of treffer[1].split(/\r?\n/)) {
    const m = zeile.match(/^(\w+):\s*(.*)$/);
    if (m) aus[m[1]] = m[2].replace(/^"|"$/g, '').replace(/\\"/g, '"');
  }
  return aus;
}

/** Einen Artikel mit Inhalt lesen; `null`, wenn es ihn nicht gibt. */
export async function leseArtikel(
  urlPfad: string,
  dir = CONTENT_DIR,
): Promise<{ kopf: Record<string, string>; inhalt: string } | null> {
  const teile = urlPfad.split('/').filter(Boolean);
  if (!teile.length || !teile.every((t) => istSichererSlug(t))) return null;
  const pfad = path.join(dir, ...teile.slice(0, -1), `${teile[teile.length - 1]}.md`);
  try {
    const roh = await readFile(pfad, 'utf8');
    const kopf = lieskopf(roh);
    const inhalt = roh.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return { kopf, inhalt };
  } catch {
    return null;
  }
}
