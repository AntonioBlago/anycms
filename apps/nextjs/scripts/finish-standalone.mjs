/**
 * Macht den standalone-Build lauffaehig.
 *
 * `output: 'standalone'` legt einen fertigen Server ab, kopiert aber NICHT
 * `.next/static` und `public` dazu: das erwartet Next.js vom Deployment. Ohne
 * diesen Schritt startet der Server, liefert HTML aus und laedt kein CSS, und
 * der Unterschied faellt erst im Browser auf, nicht im Build und nicht in
 * einem Test, der nur HTML prueft.
 */
import { cp, access } from 'node:fs/promises';
import path from 'node:path';

const wurzel = process.cwd();
const standalone = path.join(wurzel, '.next', 'standalone');

for (const [von, nach] of [
  [path.join(wurzel, '.next', 'static'), path.join(standalone, '.next', 'static')],
  [path.join(wurzel, 'public'), path.join(standalone, 'public')],
]) {
  try {
    await access(von);
  } catch {
    continue; // public/ ist optional
  }
  await cp(von, nach, { recursive: true });
  console.log(`kopiert: ${path.relative(wurzel, von)} -> ${path.relative(wurzel, nach)}`);
}
