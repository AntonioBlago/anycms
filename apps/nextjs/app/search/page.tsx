import type { Metadata } from 'next';

import { SearchClient } from './search-client';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search all articles.',
  alternates: { canonical: '/search' },
  // Eine Suchergebnisseite gehoert nicht in den Index: sie hat keinen eigenen
  // Inhalt, nur Verweise auf Seiten, die ohnehin indexiert sind.
  robots: { index: false, follow: true },
};

export default function Suchseite() {
  return (
    <>
      <h1 className="page-title">Search</h1>
      <SearchClient />
    </>
  );
}
