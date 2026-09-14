'use client';

import { useEffect, useMemo, useState } from 'react';

interface Eintrag {
  title: string;
  description: string;
  url: string;
  category: string;
  tags: string[];
  body: string;
}

/**
 * Volltextsuche im Browser.
 *
 * Der Index kommt einmal als JSON und wird danach lokal durchsucht: bei einem
 * Blog dieser Groesse ist das schneller als jeder Serveraufruf und braucht
 * keinen Suchdienst. Ab einigen tausend Beitraegen waere ein Index-Dienst die
 * richtige Antwort.
 */
export function SearchClient() {
  const [index, setIndex] = useState<Eintrag[] | null>(null);
  const [frage, setFrage] = useState('');

  useEffect(() => {
    let abgebrochen = false;
    fetch('/api/search-index.json')
      .then((r) => r.json())
      .then((d) => { if (!abgebrochen) setIndex(d as Eintrag[]); })
      .catch(() => { if (!abgebrochen) setIndex([]); });
    return () => { abgebrochen = true; };
  }, []);

  const treffer = useMemo(() => {
    const q = frage.trim().toLowerCase();
    if (!q || !index) return [];
    // Jedes Wort muss vorkommen, irgendwo: "trademark research" findet auch
    // einen Artikel, der die beiden Woerter getrennt fuehrt.
    const woerter = q.split(/\s+/);
    return index
      .map((e) => {
        const heu = `${e.title} ${e.description} ${e.category} ${e.tags.join(' ')} ${e.body}`.toLowerCase();
        if (!woerter.every((w) => heu.includes(w))) return null;
        // Titeltreffer wiegen schwerer als Fundstellen im Fliesstext.
        const punkte =
          woerter.filter((w) => e.title.toLowerCase().includes(w)).length * 3 +
          woerter.filter((w) => e.description.toLowerCase().includes(w)).length * 2 +
          1;
        return { eintrag: e, punkte };
      })
      .filter((x): x is { eintrag: Eintrag; punkte: number } => x !== null)
      .sort((a, b) => b.punkte - a.punkte)
      .map((x) => x.eintrag);
  }, [frage, index]);

  return (
    <>
      <input
        className="search-input"
        type="search"
        value={frage}
        onChange={(e) => setFrage(e.target.value)}
        placeholder={index === null ? 'Loading index…' : 'Search articles…'}
        disabled={index === null}
        autoFocus
      />

      {frage.trim() !== '' && (
        <p className="search-count">
          {treffer.length} result{treffer.length === 1 ? '' : 's'}
        </p>
      )}

      {treffer.length > 0 && (
        <ul className="post-list">
          {treffer.map((e) => (
            <li key={e.url} className="post-card">
              <h2><a href={e.url}>{e.title}</a></h2>
              {e.description && <p>{e.description}</p>}
              <div className="meta">
                <span className="chip">{e.category}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {frage.trim() !== '' && treffer.length === 0 && index !== null && (
        <div className="empty"><p>Nothing found for “{frage}”.</p></div>
      )}
    </>
  );
}
