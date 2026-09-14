// @ts-check
import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

// `output: 'server'` ist Pflicht, nicht Geschmack: der Webhook ist eine echte
// Route, die zur Laufzeit antworten muss. Ein statischer Build hat keine.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: process.env.SITE_URL ?? 'http://localhost:4321',
});
