/**
 * Visibly-Connector für Node-CMS (Astro, Next.js, jedes andere Node-Framework).
 *
 * Der Vertrag in einem Satz: **ein Webhook ist ein Signal, kein Auftrag mit
 * Rückgabewert.** Visibly wartet 10 Sekunden auf die Antwort und wiederholt
 * NICHT, wenn sie ausbleibt (der Request war dann schon da). Wer erst antwortet,
 * wenn der Artikel geschrieben ist, wird deshalb mehrfach beliefert und macht
 * dieselbe Arbeit mehrfach.
 *
 * Deshalb: Signatur prüfen, mit 202 quittieren, danach selbst holen.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Öffentlicher Host von Visibly. Die Pfade sind fest, nur der Host ist frei. */
export const DEFAULT_BASE_URL = 'https://app.visibly-ai.com';

export interface VisiblyArticle {
  id: number;
  title: string;
  slug: string;
  status: string;
  content_html: string;
  content_markdown?: string | null;
  meta_description: string;
  keywords: unknown[];
  word_count: number;
  seo_score: number;
  project_id: number | null;
  /** Cluster-Routing: Pfad-Präfix, Sprache und Zielland des Clusters. */
  plan_id?: number | null;
  url_prefix?: string | null;
  content_language?: string | null;
  target_country?: string | null;
  recommended_page_type?: string;
  /** Zählt bei jedem Schreibvorgang in Visibly hoch. */
  revision?: number;
  content_format?: string;
  published_url?: string;
  scheduled_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WebhookPayload {
  event: string;
  article_id: number;
  title?: string;
  slug?: string;
  project_id?: number;
  scheduled_date?: string | null;
  published_url?: string;
  revision?: number;
  pull_url?: string;
  timestamp?: string;
}

/**
 * HMAC-SHA256 im Vertragsformat `sha256=<hex>`, zeitkonstant verglichen.
 *
 * Der Vergleich MUSS zeitkonstant sein: ein `===` auf Strings bricht beim
 * ersten falschen Zeichen ab und verrät über die Laufzeit, wie viele Zeichen
 * stimmten. Damit lässt sich eine gültige Signatur Zeichen für Zeichen raten.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  secret: string,
  signatureHeader: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  const erwartet = createHmac('sha256', secret)
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
    .digest('hex');
  const geliefert = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7)
    : signatureHeader;
  // timingSafeEqual wirft bei ungleicher Länge, deshalb vorher prüfen.
  if (geliefert.length !== erwartet.length) return false;
  return timingSafeEqual(Buffer.from(geliefert, 'utf8'), Buffer.from(erwartet, 'utf8'));
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Pull-API-Client. Fehler sind ein Rückgabewert (`null` / `[]` / `false`),
 * keine Exception: ein Netzfehler beim Abholen darf den Server nicht umwerfen.
 */
export class VisiblyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = 30_000 }: ClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(pfad: string, init?: RequestInit): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${pfad}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'anycms-visibly-connector/1.0',
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        console.warn(`[visibly] ${pfad} antwortete ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      console.warn(`[visibly] ${pfad} nicht erreichbar:`, err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Einen Artikel samt Inhalt holen. `null` bei jedem Fehler. */
  async fetchArticle(articleId: number, includeMarkdown = true): Promise<VisiblyArticle | null> {
    const daten = await this.request<{ article: VisiblyArticle }>(
      `/api/v1/articles/${articleId}?include_markdown=${includeMarkdown}`,
    );
    return daten?.article ?? null;
  }

  /** Freigegebene Artikel auflisten (für einen Erstabgleich oder als Fallback). */
  async listArticles(status = 'approved', limit = 20, offset = 0): Promise<VisiblyArticle[]> {
    const daten = await this.request<{ articles: VisiblyArticle[] }>(
      `/api/v1/articles?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`,
    );
    return daten?.articles ?? [];
  }

  /**
   * Veröffentlichung zurückmelden. **Erst dadurch kennt Visibly die URL**, und
   * erst dann kann es den Beitrag später gezielt aktualisieren.
   */
  async confirmPublished(articleId: number, publishedUrl: string): Promise<boolean> {
    const daten = await this.request<{ success: boolean }>(
      `/api/v1/articles/${articleId}/confirm`,
      { method: 'POST', body: JSON.stringify({ published_url: publishedUrl }) },
    );
    return Boolean(daten?.success);
  }
}

/**
 * Artikel, die gerade verarbeitet werden. Verhindert, dass eine wiederholte
 * Zustellung dieselbe Arbeit ein zweites Mal auslöst.
 *
 * Prozesslokal: bei mehreren Instanzen hilft nur eine Sperre im Speicher, den
 * sich die Instanzen teilen. Für den Regelfall (ein Container, ein Nutzer
 * klickt zweimal) genügt es und kostet nichts.
 */
const inArbeit = new Set<number>();

export function beanspruchen(articleId: number): boolean {
  if (inArbeit.has(articleId)) return false;
  inArbeit.add(articleId);
  return true;
}

export function freigeben(articleId: number): void {
  inArbeit.delete(articleId);
}

export interface HandleOptions {
  secret: string;
  apiKey: string;
  baseUrl?: string;
  /** Schreibt den Artikel ins CMS und gibt die öffentliche URL zurück. */
  onArticle: (artikel: VisiblyArticle, payload: WebhookPayload) => Promise<string | null>;
  /** Selbst bestätigen? Default true, sobald `onArticle` eine URL liefert. */
  confirm?: boolean;
}

export interface HandleResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Der komplette Webhook-Ablauf, framework-unabhängig: Signatur prüfen, Payload
 * lesen, mit 202 quittieren und die Arbeit danach erledigen.
 *
 * Gibt die Antwort zurück, die der Aufrufer sofort senden soll. Die eigentliche
 * Arbeit läuft als nicht abgewartetes Promise weiter.
 */
export async function handleWebhook(
  rohKoerper: string,
  signatur: string | null,
  opts: HandleOptions,
): Promise<HandleResult> {
  if (!opts.secret) {
    return { status: 500, body: { error: 'webhook_secret_missing' } };
  }
  if (!verifyWebhookSignature(rohKoerper, opts.secret, signatur ?? '')) {
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rohKoerper) as WebhookPayload;
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }

  const { event, article_id: articleId } = payload;

  // "Verbindung testen" in Visibly: kein Artikel dahinter, nichts abzuholen.
  // Ausdruecklich beantworten statt unter "ignored" laufen zu lassen - das
  // liest sich sonst wie "angenommen, aber nichts passiert".
  if (event === 'webhook.test') {
    return { status: 200, body: { status: 'ok', event } };
  }

  if (!articleId || !['article.approved', 'article.updated', 'article.published'].includes(event)) {
    // Unbekannte Ereignisse werden freundlich quittiert: ein Fehler würde den
    // Sender zu Wiederholungen verleiten, die nie etwas ändern.
    return { status: 200, body: { status: 'ignored', event } };
  }

  if (!opts.apiKey) {
    return { status: 500, body: { error: 'api_key_missing' } };
  }
  if (!beanspruchen(articleId)) {
    return { status: 202, body: { status: 'already_processing', article_id: articleId } };
  }

  // Bewusst NICHT abgewartet: die Antwort geht sofort raus.
  void (async () => {
    try {
      const client = new VisiblyClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      const artikel = await client.fetchArticle(articleId);
      if (!artikel) {
        console.warn(`[visibly] Artikel ${articleId} nicht abrufbar`);
        return;
      }
      const url = await opts.onArticle(artikel, payload);
      if (url && opts.confirm !== false) {
        await client.confirmPublished(articleId, url);
      }
    } catch (err) {
      console.error(`[visibly] Verarbeitung von ${articleId} fehlgeschlagen:`, err);
    } finally {
      freigeben(articleId);
    }
  })();

  return { status: 202, body: { status: 'accepted', article_id: articleId } };
}
