import { listeArtikel } from '@anycms/ai-automation-connector/storage';

// Die Artikel liegen als Dateien und ändern sich per Webhook: kein Caching.
export const dynamic = 'force-dynamic';

export default async function Startseite() {
  const artikel = await listeArtikel();
  return (
    <>
      <h1>Blog</h1>
      {artikel.length === 0 ? (
        <p className="leer">
          Noch keine Artikel. Sobald du in Visibly einen Artikel freigibst, landet er hier.
        </p>
      ) : (
        artikel.map((a) => (
          <article key={a.urlPfad}>
            <h2><a href={`/${a.urlPfad}`}>{a.title}</a></h2>
            {a.description && <p>{a.description}</p>}
            {a.pubDate && <time dateTime={a.pubDate}>{a.pubDate.slice(0, 10)}</time>}
          </article>
        ))
      )}
    </>
  );
}
