/**
 * Where blog posts live on disk.
 *
 * ANYCMS PATCH: the template hard-coded `process.cwd()/public/data/posts` in
 * six places. On Railway that path is inside the container and therefore
 * ephemeral: new deploy, articles gone. `POSTS_DIR` lets it point at a mounted
 * volume instead, and lets tests point it at a temporary folder.
 *
 * Without this, delivered articles would survive exactly until the next deploy.
 */
import path from 'node:path';

export const POSTS_DIR =
  process.env.POSTS_DIR ?? path.join(process.cwd(), 'public', 'data', 'posts');
