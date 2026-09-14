import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getPosts } from '../../../lib/posts';
import { PostList } from '../../post-list';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  const lesbar = decodeURIComponent(name);
  return {
    title: `Tag: ${lesbar}`,
    description: `All articles tagged ${lesbar}.`,
    alternates: { canonical: `/tag/${name}` },
  };
}

export default async function Tag({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const gesucht = decodeURIComponent(name).toLowerCase();
  const posts = (await getPosts()).filter((p) =>
    p.tags.some((t) => t.toLowerCase() === gesucht),
  );
  if (posts.length === 0) notFound();

  return (
    <>
      <h1 className="page-title">#{decodeURIComponent(name)}</h1>
      <p className="page-lead">{posts.length} article{posts.length === 1 ? '' : 's'}</p>
      <PostList posts={posts} />
    </>
  );
}
