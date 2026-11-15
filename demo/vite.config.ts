import { defineConfig } from 'vite';

export default defineConfig({
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
