import { getPosts, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../../lib/posts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** XML-Sonderzeichen maskieren: ein & im Titel zerlegt sonst den ganzen Feed. */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(): Promise<Response> {
  const posts = (await getPosts()).slice(0, 50);
  const items = posts
    .map((p) => {
      const url = `${SITE_URL}/${p.urlPfad}`;
      const datum = p.pubDate ? new Date(p.pubDate).toUTCString() : '';
      return `    <item>
      <title>${xml(p.title)}</title>
      <link>${xml(url)}</link>
      <guid isPermaLink="true">${xml(url)}</guid>
      <description>${xml(p.description)}</description>
      ${datum ? `<pubDate>${datum}</pubDate>` : ''}
      <category>${xml(p.category)}</category>
    </item>`;
    })
    .join('\n');

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(SITE_NAME)}</title>
    <link>${xml(SITE_URL)}</link>
    <description>${xml(SITE_DESCRIPTION)}</description>
    <atom:link href="${xml(SITE_URL)}/rss.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(feed, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
