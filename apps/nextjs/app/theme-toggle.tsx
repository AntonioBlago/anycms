'use client';

import { useEffect, useState } from 'react';

/**
 * Dark-Mode-Schalter.
 *
 * Der Anfangszustand kommt aus der Klasse am <html>, die das Bootstrap-Skript
 * im Layout schon VOR dem ersten Paint gesetzt hat. Ihn hier aus localStorage
 * zu lesen, waere doppelte Wahrheit und flackerte beim Hydrieren.
 */
export function ThemeToggle() {
  const [dunkel, setDunkel] = useState<boolean | null>(null);

  useEffect(() => {
    setDunkel(document.documentElement.classList.contains('dark'));
  }, []);

  const umschalten = () => {
    const neu = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', neu);
    try {
      localStorage.setItem('theme', neu ? 'dark' : 'light');
    } catch {
      // Privates Fenster oder gesperrte Site-Daten: die Auswahl gilt fuer
      // diese Sitzung, mehr ist hier nicht zu retten.
    }
    setDunkel(neu);
  };

  return (
    <button
      type="button"
      onClick={umschalten}
      className="theme-toggle"
      // Vor dem ersten Effekt ist der Zustand unbekannt: ein neutrales Label
      // ist ehrlicher als eine geratene Richtung.
      aria-label={dunkel === null ? 'Toggle theme' : dunkel ? 'Switch to light' : 'Switch to dark'}
    >
      {dunkel === null ? '◐' : dunkel ? '☀' : '☾'}
    </button>
  );
}
