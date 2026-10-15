import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = resolve('src/workbench/web');

export default defineConfig({
  root: webRoot,
  base: '/workbench/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve('src/local/web/src') } },
  build: {
    outDir: resolve('dist/workbench/web'),
    emptyOutDir: true,
    rollupOptions: { output: {
      entryFileNames: 'assets/[name]-[hash].js',
      chunkFileNames: 'assets/[name]-[hash].js',
      assetFileNames: 'assets/[name]-[hash][extname]',
    } },
  },
});
