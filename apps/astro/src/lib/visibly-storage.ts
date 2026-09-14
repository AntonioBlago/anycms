/**
 * Writes Visibly articles into this template's own post format.
 *
 * The template reads MDX from `public/data/posts/` (English at the root, other
 * languages in a `<lang>/` subfolder) with a rich frontmatter block. Writing
 * exactly that shape means every feature of the template works on delivered
 * articles without further wiring: search, RSS, sitemap, categories, tags,
 * related posts, reading time, structured data.
 *
 * On Railway `POSTS_DIR` points at a mounted volume, so the filesystem being
 * ephemeral does not matter.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Articles are English unless the cluster says otherwise (template default). */
const DEFAULT_LANGUAGE = 'en';

export { POSTS_DIR } from './posts-dir';
import { POSTS_DIR as ZIEL } from './posts-dir';

/**
 * Slug und Sprachkennung landen in einem Dateipfad und kommen aus einem
 * fremden System: ohne diese Pruefung schriebe ein `../` ausserhalb des
 * Verzeichnisses.
 */
export function isSafeSegment(wert: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,199}$/i.test(wert);
}

/** Frontmatter-Werte maskieren: ein Doppelpunkt im Titel zerlegt sonst das YAML. */
function yamlString(wert: unknown): string {
  if (wert === null || wert === undefined) return '""';
  return `"${String(wert).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlList(werte: unknown[]): string {
  return `[${werte.map((w) => yamlString(w)).join(',')}]`;
}

export interface VisiblyArticleLike {
  id: number;
  title?: string;
  slug?: string;
  meta_description?: string;
  content_html?: string;
  content_markdown?: string | null;
  content_format?: string;
  keywords?: unknown[];
  url_prefix?: string | null;
  content_language?: string | null;
  recommended_page_type?: string;
  revision?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface StoredPost {
  slug: string;
  language: string;
  filePath: string;
  url: string;
}

export interface StoreOptions {
  siteUrl: string;
  postsDir?: string;
  /** Posts arrive as drafts unless told otherwise. */
  draft?: boolean;
  /** Author id from the template's authors list. */
  author?: string;
}

/**
 * Write one article as MDX in the template's format.
 *
 * The filename is the slug, so a second delivery of the same article
 * overwrites rather than duplicating.
 */
export async function storeArticle(
  artikel: VisiblyArticleLike,
  { siteUrl, postsDir = ZIEL, draft = false, author = 'admin' }: StoreOptions,
): Promise<StoredPost | null> {
  const slug = (artikel.slug ?? '').trim();
  if (!isSafeSegment(slug)) {
    console.warn(`[visibly] rejected slug: ${JSON.stringify(slug)}`);
    return null;
  }

  const roh = (artikel.content_language ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  const language = isSafeSegment(roh) ? roh : DEFAULT_LANGUAGE;

  // The template keeps the default language at the root and every other
  // language in its own folder; getAllBlogPosts looks in exactly those places.
  const verzeichnis =
    language === DEFAULT_LANGUAGE ? postsDir : path.join(postsDir, language);
  await mkdir(verzeichnis, { recursive: true });

  const jetzt = new Date().toISOString();
  const erstellt = artikel.created_at ?? jetzt;
  const geaendert = artikel.updated_at ?? jetzt;

  // The template renders MDX. Visibly sends HTML or Markdown depending on the
  // cluster; both are valid MDX bodies, so neither needs converting.
  const body =
    artikel.content_format === 'markdown' && artikel.content_markdown
      ? artikel.content_markdown
      : (artikel.content_html ?? '');

  const keywords = Array.isArray(artikel.keywords)
    ? artikel.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    : [];

  // The cluster prefix doubles as the category: a Visibly cluster and a blog
  // category are the same idea, so /glossary/ articles group themselves.
  const kategorie =
    (artikel.url_prefix ?? '').replace(/^\/+|\/+$/g, '').split('/')[0] || 'blog';

  const frontmatter = [
    '---',
    `title: ${yamlString(artikel.title ?? slug)}`,
    `description: ${yamlString(artikel.meta_description ?? '')}`,
    `publishDate: ${erstellt}`,
    `updateDate: ${geaendert}`,
    `author: ${yamlString(author)}`,
    `category: ${yamlString(isSafeSegment(kategorie) ? kategorie : 'blog')}`,
    `tags: ${yamlList(keywords)}`,
    'featured: false',
    `draft: ${draft ? 'true' : 'false'}`,
    'heroImage: ""',
    `seoTitle: ${yamlString(artikel.title ?? '')}`,
    `seoDescription: ${yamlString(artikel.meta_description ?? '')}`,
    `seoKeywords: ${yamlString(keywords.join(', '))}`,
    // Own fields, so a second delivery finds its post and the state is visible.
    `visiblyArticleId: ${artikel.id}`,
    `visiblyRevision: ${artikel.revision ?? 1}`,
    '---',
    '',
    body,
    '',
  ].join('\n');

  const filePath = path.join(verzeichnis, `${slug}.mdx`);
  await writeFile(filePath, frontmatter, 'utf8');

  // The template serves posts at /blog/<slug>, non-default languages at
  // /<lang>/blog/<slug>.
  const pfad =
    language === DEFAULT_LANGUAGE ? `blog/${slug}` : `${language}/blog/${slug}`;
  return {
    slug,
    language,
    filePath,
    url: `${siteUrl.replace(/\/+$/, '')}/${pfad}`,
  };
}
