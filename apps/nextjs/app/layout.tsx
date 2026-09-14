import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../lib/posts';
import { ThemeToggle } from './theme-toggle';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
  },
  twitter: { card: 'summary_large_image', title: SITE_NAME, description: SITE_DESCRIPTION },
  alternates: {
    canonical: '/',
    types: { 'application/rss+xml': `${SITE_URL}/rss.xml` },
  },
};

/**
 * Applied before the first paint, so the page never flashes the wrong theme.
 * A React effect would run after hydration, which is exactly one frame too
 * late and looks broken on every reload.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var gespeichert = localStorage.getItem('theme');
    var dunkel = gespeichert
      ? gespeichert === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dunkel) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <link rel="alternate" type="application/rss+xml" title={SITE_NAME} href="/rss.xml" />
      </head>
      <body>
        <header className="site-header">
          <div className="wrap header-inner">
            <a href="/" className="brand">
              <span className="brand-mark">&gt;_</span>
              {SITE_NAME}
            </a>
            <nav className="nav">
              <a href="/">Articles</a>
              <a href="/categories">Categories</a>
              <a href="/tags">Tags</a>
              <a href="/search">Search</a>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="site-footer">
          <div className="wrap footer-inner">
            <span>
              Published automatically by the{' '}
              <a href="https://github.com/AntonioBlago/anycms">AI Automation Connector</a>
            </span>
            <a href="/rss.xml">RSS</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
