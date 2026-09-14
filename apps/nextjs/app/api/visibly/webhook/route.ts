/**
 * Visibly-Webhook für Next.js (App Router).
 *
 * In Visibly als CMS-Verbindung vom Typ "webhook" eintragen:
 *   https://deine-domain.de/api/visibly/webhook
 */
import { handleWebhook } from '@anycms/visibly-connector';
import { speichereArtikel } from '@anycms/visibly-connector/storage';

// Node-Runtime ist Pflicht: der Connector schreibt Dateien, das kann Edge nicht.
export const runtime = 'nodejs';
// Nichts an dieser Route ist cachebar.
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // Den ROHEN Körper lesen: die Signatur gilt für die gesendeten Bytes. Ein
  // Re-Serialisieren aus geparstem JSON ändert sie und lässt jede gültige
  // Signatur durchfallen.
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
          siteUrl: process.env.SITE_URL ?? 'http://localhost:3000',
        });
        return gespeichert?.url ?? null;
      },
    },
  );

  return Response.json(body, { status });
}
