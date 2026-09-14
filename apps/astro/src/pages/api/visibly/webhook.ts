/**
 * Visibly webhook for this template.
 *
 * Paste this URL into Visibly as a CMS connection of type "webhook":
 *   https://your-domain.com/api/visibly/webhook
 *
 * The whole connector is this file plus `src/lib/visibly-storage.ts`. Drop
 * both into any Astro project with `output: 'server'` and swap `storeArticle`
 * for however that project stores posts.
 */

import type { APIRoute } from 'astro';
import { handleWebhook } from '@anycms/ai-automation-connector';

import { storeArticle } from '../../../lib/visibly-storage';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Read the RAW body, not parsed JSON: the signature covers the bytes that
  // were sent. Re-serializing changes key order and whitespace, and every
  // valid signature would fail.
  const raw = await request.text();

  const { status, body } = await handleWebhook(
    raw,
    request.headers.get('x-webhook-signature'),
    {
      secret: process.env.VISIBLY_WEBHOOK_SECRET ?? '',
      apiKey: process.env.VISIBLY_API_KEY ?? '',
      baseUrl: process.env.VISIBLY_BASE_URL,
      onArticle: async (article) => {
        const stored = await storeArticle(article, {
          siteUrl: process.env.SITE_URL ?? 'http://localhost:4321',
          // Articles land as drafts unless you opt into publishing directly.
          draft: process.env.VISIBLY_PUBLISH_DIRECTLY !== 'true',
          author: process.env.VISIBLY_AUTHOR ?? 'admin',
        });
        // The returned URL goes back to Visibly; only then can Visibly target
        // this post for later updates.
        return stored?.url ?? null;
      },
    },
  );

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};
