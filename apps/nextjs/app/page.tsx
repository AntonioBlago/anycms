import { getPosts, paginate, SITE_DESCRIPTION } from '../lib/posts';
import { PostList, Pagination } from './post-list';

// Beitraege kommen per Webhook dazu: nichts hier darf zwischengespeichert werden.
export const dynamic = 'force-dynamic';

export default async function Startseite() {
  const alle = await getPosts();
  const seite = paginate(alle, 1);
  return (
    <>
      <h1 className="page-title">Articles</h1>
      <p className="page-lead">{SITE_DESCRIPTION}</p>
      <PostList posts={seite.items} />
      <Pagination page={seite.page} pages={seite.pages} />
    </>
  );
}
