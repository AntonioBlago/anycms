import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  formatDate,
  getPost,
  getPosts,
  relatedPosts,
  SITE_NAME,
  SITE_URL,
} from '../../lib/posts';

export const dynamic = 'force-dynamic';

/**
 * Per-article metadata: title, description, canonical, Open Graph, Twitter.
 *
 * Without a canonical, the same article is reachable under several paths and
 * competes with itself in search results.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ pfad: string[] }> },
): Promise<Metadata> {
  const { pfad } = await params;
  const post = await getPost(pfad.join('/'));
  if (!post) return { title: 'Not found' };

  const url = `${SITE_URL}/${post.urlPfad}`;
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.description,
      url,
      siteName: SITE_NAME,
      publishedTime: post.pubDate || undefined,
      modifiedTime: post.updatedDate || undefined,
      tags: post.tags,
    },
    twitter: { card: 'summary_large_image', title: post.title, description: post.description },
  };
}

export default async function Artikelseite({
  params,
}: {
  params: Promise<{ pfad: string[] }>;
}) {
  const { pfad } = await params;
  const post = await getPost(pfad.join('/'));
  if (!post) notFound();

  const alle = await getPosts();
  const verwandt = relatedPosts(alle, post);
  const url = `${SITE_URL}/${post.urlPfad}`;

  // BlogPosting plus Breadcrumb: das ist, was Suchmaschinen aus einem Artikel
  // tatsaechlich auslesen. dateModified gehoert dazu, sonst gilt jede
  // Aktualisierung als unsichtbar.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.description,
        url,
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
        datePublished: post.pubDate || undefined,
        dateModified: post.updatedDate || post.pubDate || undefined,
        inLanguage: post.lang,
        keywords: post.tags.join(', ') || undefined,
        articleSection: post.category,
        publisher: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
          {
            '@type': 'ListItem',
            position: 2,
            name: post.category,
            item: `${SITE_URL}/category/${encodeURIComponent(post.category)}`,
          },
          { '@type': 'ListItem', position: 3, name: post.title, item: url },
        ],
      },
    ],
  };

  return (
    <article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <header className="post-header">
        <a className="chip chip-accent" href={`/category/${encodeURIComponent(post.category)}`}>
          {post.category}
        </a>
        <h1>{post.title}</h1>
        {post.description && <p className="lead">{post.description}</p>}
        <div className="meta">
          {post.pubDate && <time dateTime={post.pubDate}>{formatDate(post.pubDate, post.lang)}</time>}
          <span className="dot">·</span>
          <span>{`${post.readingMinutes} min read`}</span>
          {post.updatedDate && post.updatedDate !== post.pubDate && (
            <>
              <span className="dot">·</span>
              <span>updated {formatDate(post.updatedDate, post.lang)}</span>
            </>
          )}
        </div>
      </header>

      {/* Ein Inhaltsverzeichnis mit einer Ueberschrift ist keins. */}
      {post.toc.length > 1 && (
        <details className="toc" open>
          <summary>Contents</summary>
          <ol>
            {post.toc.map((h) => (
              <li key={h.id} className={`level-${h.level}`}>
                <a href={`#${h.id}`}>{h.text}</a>
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* Der Inhalt stammt aus dem eigenen Visibly-Konto und ist bereits HTML. */}
      <div className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />

      {post.tags.length > 0 && (
        <div className="chip-row">
          {post.tags.map((t) => (
            <a key={t} className="chip" href={`/tag/${encodeURIComponent(t.toLowerCase())}`}>
              #{t}
            </a>
          ))}
        </div>
      )}

      {verwandt.length > 0 && (
        <footer className="post-footer">
          <h2>Related articles</h2>
          <ul className="post-list">
            {verwandt.map((p) => (
              <li key={p.urlPfad} className="post-card">
                <h2><a href={`/${p.urlPfad}`}>{p.title}</a></h2>
                <div className="meta">
                  <span>{`${p.readingMinutes} min read`}</span>
                </div>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}
