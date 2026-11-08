import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths: the same build works at a domain root (trace.savannahfruits.com)
  // and under a sub-path such as GitHub Pages (babasuhuyini.github.io/SavannahTrace/).
  // Safe because the app routes with #/ and never needs server-side paths.
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 2000 },
});
