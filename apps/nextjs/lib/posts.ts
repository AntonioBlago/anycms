/**
 * Content layer: everything the pages need from the articles on disk.
 *
 * Articles are Markdown files written by the connector. This module turns them
 * into the shapes the blog renders: lists, filters, pagination, reading time,
 * related posts and a search index.
 *
 * Deliberately no cache. Articles arrive at runtime via webhook; a cache would
 * have to be invalidated by exactly the code path that must stay simple, and a
 * blog of this size reads its directory in single-digit milliseconds.
 */

import { listeArtikel, leseArtikel, type ArtikelKopf } from '@anycms/ai-automation-connector/storage';

export interface Post extends ArtikelKopf {
  /** Minutes, rounded up. Never 0: even three words take a moment. */
  readingMinutes: number;
}

export interface PostDetail extends Post {
  html: string;
  /** Headings for the table of contents, in document order. */
  toc: { id: string; text: string; level: number }[];
}

/** Words per minute for an average reader of technical prose. */
const WPM = 220;

export const SITE_URL = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
export const SITE_NAME = process.env.SITE_NAME ?? 'Blog';
export const SITE_DESCRIPTION =
  process.env.SITE_DESCRIPTION ?? 'Articles delivered by the AI Automation Connector.';

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readingMinutes(text: string): number {
  const woerter = text ? text.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(woerter / WPM));
}

/** Slug for a heading anchor. Keeps umlauts readable rather than dropping them. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** All posts, newest first. */
export async function getPosts(): Promise<Post[]> {
  const kopf = await listeArtikel();
  const out: Post[] = [];
  for (const k of kopf) {
    const eintrag = await leseArtikel(k.urlPfad);
    out.push({ ...k, readingMinutes: readingMinutes(textOf(eintrag?.inhalt ?? '')) });
  }
  return out;
}

/** One post with rendered HTML and its table of contents. */
export async function getPost(urlPfad: string): Promise<PostDetail | null> {
  const eintrag = await leseArtikel(urlPfad);
  if (!eintrag) return null;

  const { marked } = await import('marked');
  const kopf = eintrag.kopf;

  // Visibly sends HTML or Markdown depending on the cluster; the frontmatter
  // says which. Rendering HTML through a Markdown parser would mangle it.
  let html =
    kopf.format === 'markdown' ? await marked.parse(eintrag.inhalt) : eintrag.inhalt;

  // Anchors for the table of contents, added to the rendered HTML so both
  // Markdown and HTML sources get them.
  const toc: { id: string; text: string; level: number }[] = [];
  html = html.replace(
    /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_m: string, level: string, attrs: string, inner: string) => {
      const text = textOf(inner);
      const id = headingId(text);
      if (id) toc.push({ id, text, level: Number(level) });
      return `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
    },
  );

  const teile = urlPfad.split('/').filter(Boolean);
  return {
    slug: teile[teile.length - 1] ?? '',
    title: kopf.title ?? '',
    description: kopf.description ?? '',
    pubDate: kopf.pubDate ?? '',
    updatedDate: kopf.updatedDate ?? kopf.pubDate ?? '',
    lang: kopf.lang ?? 'de',
    category: kopf.category ?? teile[0] ?? 'blog',
    tags: parseTags(kopf.tags),
    format: kopf.format ?? 'html',
    urlPfad,
    readingMinutes: readingMinutes(textOf(eintrag.inhalt)),
    html,
    toc,
  };
}

function parseTags(roh: string | undefined): string[] {
  if (!roh) return [];
  return roh
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * Posts related to this one, most overlapping tags first.
 *
 * Tags only: a shared category means little when every post shares it, and
 * without shared tags there is nothing honest to claim. An empty list is a
 * better answer than three arbitrary posts.
 */
export function relatedPosts(alle: Post[], aktuell: Post, limit = 3): Post[] {
  const meine = new Set(aktuell.tags.map((t) => t.toLowerCase()));
  if (meine.size === 0) return [];
  return alle
    .filter((p) => p.urlPfad !== aktuell.urlPfad)
    .map((p) => ({
      post: p,
      treffer: p.tags.filter((t) => meine.has(t.toLowerCase())).length,
    }))
    .filter((x) => x.treffer > 0)
    .sort((a, b) => b.treffer - a.treffer || (a.post.pubDate < b.post.pubDate ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.post);
}

export interface Seite<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, perPage = 10): Seite<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const sicher = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((sicher - 1) * perPage, sicher * perPage),
    page: sicher,
    pages,
    total,
  };
}

/** Distinct categories with their post counts, largest first. */
export function categories(alle: Post[]): { name: string; count: number }[] {
  const zaehler = new Map<string, number>();
  for (const p of alle) zaehler.set(p.category, (zaehler.get(p.category) ?? 0) + 1);
  return [...zaehler.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Distinct tags with their post counts, largest first. */
export function tags(alle: Post[]): { name: string; count: number }[] {
  const zaehler = new Map<string, number>();
  for (const p of alle) {
    for (const t of p.tags) {
      const key = t.toLowerCase();
      zaehler.set(key, (zaehler.get(key) ?? 0) + 1);
    }
  }
  return [...zaehler.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Search index for the client: small enough to ship, enough to match on. */
export async function searchIndex(): Promise<
  { title: string; description: string; url: string; category: string; tags: string[]; body: string }[]
> {
  const posts = await listeArtikel();
  const out = [];
  for (const p of posts) {
    const eintrag = await leseArtikel(p.urlPfad);
    out.push({
      title: p.title,
      description: p.description,
      url: `/${p.urlPfad}`,
      category: p.category,
      tags: p.tags,
      // Cap the body: a search index that ships whole articles costs more
      // bandwidth than the search is worth.
      body: textOf(eintrag?.inhalt ?? '').slice(0, 2000),
    });
  }
  return out;
}

export function formatDate(iso: string, lang = 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
