import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite builds only the browser half.
 *
 * In development this config is loaded by the Express server, which runs Vite
 * in middleware mode so that the API and the UI share one origin — an embedded
 * app is framed at a single URL, and a second dev port would not be reachable
 * from inside the admin iframe.
 */
export default defineConfig({
  root: fileURLToPath(new URL('src/web', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
