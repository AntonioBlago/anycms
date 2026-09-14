/**
 * Visibly-Webhook für Astro.
 *
 * Diese Datei ist der ganze Connector. Sie lässt sich unverändert in jedes
 * Astro-Projekt mit `output: 'server'` kopieren, auch in ein fertiges Template
 * wie astro-seo-blog-template: nur `speichereArtikel` gegen die Ablage des
 * jeweiligen Projekts tauschen.
 *
 * Trage die URL in Visibly als CMS-Verbindung vom Typ "webhook" ein:
 *   https://deine-domain.de/api/visibly/webhook
 */

import type { APIRoute } from 'astro';
import { handleWebhook } from '@anycms/ai-automation-connector';
import { speichereArtikel } from '@anycms/ai-automation-connector/storage';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Den ROHEN Körper lesen, nicht das geparste JSON: die Signatur gilt für die
  // Bytes, die gesendet wurden. Ein Re-Serialisieren ändert sie (Reihenfolge,
  // Leerzeichen) und lässt jede gültige Signatur durchfallen.
  const roh = await request.text();

  const { status, body } = await handleWebhook(
    roh,
    request.headers.get('x-webhook-signature'),
    {
      secret: process.env.VISIBLY_WEBHOOK_SECRET ?? '',
      apiKey: process.env.VISIBLY_API_KEY ?? '',
      baseUrl: process.env.VISIBLY_BASE_URL,
      onArticle: async (artikel) => {
        const gespeichert = await speichereArtikel(artikel, {
          siteUrl: process.env.SITE_URL ?? 'http://localhost:4321',
        });
        // Die zurückgegebene URL meldet der Connector an Visibly zurück; erst
        // dadurch kann Visibly den Beitrag später gezielt aktualisieren.
        return gespeichert?.url ?? null;
      },
    },
  );

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};
