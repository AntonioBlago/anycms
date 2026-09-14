import { searchIndex } from '../../../lib/posts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Der Index, aus dem die Suche im Browser arbeitet. */
export async function GET(): Promise<Response> {
  return Response.json(await searchIndex(), {
    // Kurz zwischenspeichern: die Suche fragt ihn bei jedem Seitenaufruf,
    // und ein per Webhook neuer Artikel darf hoechstens eine Minute fehlen.
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
}
