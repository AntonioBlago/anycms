/** @type {import('next').NextConfig} */
export default {
  // Der Connector liest und schreibt Dateien: das geht nur im Node-Runtime,
  // nicht im Edge-Runtime. Standalone macht das Railway-Image klein.
  output: 'standalone',
};
