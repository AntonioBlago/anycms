import type { ReactNode } from 'react';

export const metadata = {
  title: 'Blog',
  description: 'Artikel aus dem Visibly Content Autopilot',
};

const stil = `
  :root { color-scheme: light dark; --akzent: #f6571e; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem;
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 46rem; margin-inline: auto;
  }
  a { color: var(--akzent); }
  header { border-bottom: 1px solid #8884; padding-bottom: 1rem; margin-bottom: 2rem; }
  header a { text-decoration: none; font-weight: 600; color: inherit; }
  article + article { border-top: 1px solid #8883; margin-top: 1.5rem; padding-top: 1.5rem; }
  h1 { line-height: 1.2; }
  time { color: #8889; font-size: .875rem; }
  .leer { color: #8889; }
  img { max-width: 100%; height: auto; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <style dangerouslySetInnerHTML={{ __html: stil }} />
        <header><a href="/">Blog</a></header>
        <main>{children}</main>
      </body>
    </html>
  );
}
