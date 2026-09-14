import type { MetadataRoute } from 'next';

import { SITE_URL } from '../lib/posts';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Der Webhook und der Suchindex gehoeren in keinen Index.
      disallow: ['/api/', '/search'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
