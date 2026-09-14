import type { Metadata } from 'next';

import { getPosts, tags } from '../../lib/posts';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Tags',
  description: 'All article tags.',
  alternates: { canonical: '/tags' },
};

export default async function Tags() {
  const liste = tags(await getPosts());
  return (
    <>
      <h1 className="page-title">Tags</h1>
      <p className="page-lead">Tags come from the target keywords of each article.</p>
      {liste.length === 0 ? (
        <div className="empty"><p>No tags yet.</p></div>
      ) : (
        <div className="chip-row">
          {liste.map((t) => (
            <a key={t.name} className="chip" href={`/tag/${encodeURIComponent(t.name)}`}>
              #{t.name} <span style={{ opacity: 0.6 }}>{t.count}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
