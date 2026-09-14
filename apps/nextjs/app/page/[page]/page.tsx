import { notFound } from 'next/navigation';

import { getPosts, paginate } from '../../../lib/posts';
import { PostList, Pagination } from '../../post-list';

export const dynamic = 'force-dynamic';

export default async function Seite({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) notFound();

  const alle = await getPosts();
  const seite = paginate(alle, n);
  // Eine Seitenzahl jenseits des Bestands ist ein 404, keine leere Liste:
  // sonst indexieren Suchmaschinen beliebig viele leere Seiten.
  if (n > seite.pages) notFound();

  return (
    <>
      <h1 className="page-title">Articles</h1>
      <p className="page-lead">Page {seite.page} of {seite.pages}</p>
      <PostList posts={seite.items} />
      <Pagination page={seite.page} pages={seite.pages} />
    </>
  );
}
