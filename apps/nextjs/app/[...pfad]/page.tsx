import { leseArtikel } from '@anycms/ai-automation-connector/storage';
import { marked } from 'marked';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function Artikelseite({
  params,
}: {
  params: Promise<{ pfad: string[] }>;
}) {
  const { pfad } = await params;
  const eintrag = await leseArtikel(pfad.join('/'));
  if (!eintrag) notFound();

  // Visibly liefert je nach Cluster Markdown ODER HTML; das Format steht im
  // Frontmatter.
  const html = eintrag.kopf.format === 'markdown'
    ? await marked.parse(eintrag.inhalt)
    : eintrag.inhalt;

  return (
    <>
      <h1>{eintrag.kopf.title}</h1>
      {eintrag.kopf.pubDate && (
        <time dateTime={eintrag.kopf.pubDate}>{eintrag.kopf.pubDate.slice(0, 10)}</time>
      )}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
