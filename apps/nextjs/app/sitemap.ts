import type { MetadataRoute } from 'next';

import { categories, getPosts, SITE_URL, tags } from '../lib/posts';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await getPosts();

  return [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/categories`, changeFrequency: 'weekly', priority: 0.4 },
    { url: `${SITE_URL}/tags`, changeFrequency: 'weekly', priority: 0.4 },
    ...posts.map((p) => ({
      url: `${SITE_URL}/${p.urlPfad}`,
      // lastModified zaehlt: ohne das gilt jede Aktualisierung als unsichtbar.
      lastModified: p.updatedDate || p.pubDate || undefined,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
    ...categories(posts).map((c) => ({
      url: `${SITE_URL}/category/${encodeURIComponent(c.name)}`,
      changeFrequency: 'weekly' as const,
      priority: 0.5,
    })),
    ...tags(posts).map((t) => ({
      url: `${SITE_URL}/tag/${encodeURIComponent(t.name)}`,
      changeFrequency: 'weekly' as const,
      priority: 0.3,
    })),
  ];
}
