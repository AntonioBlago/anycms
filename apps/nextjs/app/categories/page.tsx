import type { Metadata } from 'next';

import { categories, getPosts } from '../../lib/posts';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Categories',
  description: 'All article categories.',
  alternates: { canonical: '/categories' },
};

export default async function Kategorien() {
  const liste = categories(await getPosts());
  return (
    <>
      <h1 className="page-title">Categories</h1>
      <p className="page-lead">
        Each category is a content cluster in Visibly, with its own path, language
        and target country.
      </p>
      {liste.length === 0 ? (
        <div className="empty"><p>No categories yet.</p></div>
      ) : (
        <div className="chip-row">
          {liste.map((c) => (
            <a key={c.name} className="chip" href={`/category/${encodeURIComponent(c.name)}`}>
              {c.name} <span style={{ opacity: 0.6 }}>{c.count}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
