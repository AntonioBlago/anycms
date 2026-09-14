import { formatDate, type Post } from '../lib/posts';

/** Eine Beitragsliste mit Datum, Lesezeit, Kategorie und Tags. */
export function PostList({ posts }: { posts: Post[] }) {
  if (posts.length === 0) {
    return (
      <div className="empty">
        <p>No articles yet.</p>
        <p>
          Approve one in Visibly and it appears here within seconds. The webhook
          endpoint is <code>/api/visibly/webhook</code>.
        </p>
      </div>
    );
  }
  return (
    <ul className="post-list">
      {posts.map((p) => (
        <li key={p.urlPfad} className="post-card">
          <h2><a href={`/${p.urlPfad}`}>{p.title}</a></h2>
          {p.description && <p>{p.description}</p>}
          <div className="meta">
            {p.pubDate && <time dateTime={p.pubDate}>{formatDate(p.pubDate, p.lang)}</time>}
            <span className="dot">·</span>
            {/* Ein einziger Textknoten: React schoebe sonst einen
                Kommentar zwischen Zahl und Wort. */}
            <span>{`${p.readingMinutes} min read`}</span>
            <span className="dot">·</span>
            <a className="chip" href={`/category/${encodeURIComponent(p.category)}`}>{p.category}</a>
            {p.tags.slice(0, 3).map((t) => (
              <a key={t} className="chip" href={`/tag/${encodeURIComponent(t.toLowerCase())}`}>#{t}</a>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Seitennavigation. Erscheint nur, wenn es wirklich mehrere Seiten gibt. */
export function Pagination({ page, pages, basis = '' }: { page: number; pages: number; basis?: string }) {
  if (pages <= 1) return null;
  const url = (n: number) => (n === 1 ? basis || '/' : `${basis}/page/${n}`);
  return (
    <nav className="pagination" aria-label="Pagination">
      {page > 1 && <a href={url(page - 1)}>← prev</a>}
      {Array.from({ length: pages }, (_, i) => i + 1).map((n) =>
        n === page ? (
          <span key={n} className="current" aria-current="page">{n}</span>
        ) : (
          <a key={n} href={url(n)}>{n}</a>
        ),
      )}
      {page < pages && <a href={url(page + 1)}>next →</a>}
    </nav>
  );
}
