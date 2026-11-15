import { defineConfig } from 'vite';

// Project pages are served from /<repo>/ while a custom domain or Vercel serves
// from /. The base is injected so the same build works for both targets.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  server: {
    port: 5174,
  },
});
