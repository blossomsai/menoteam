import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = resolve('src/local/web');

export default defineConfig({
  root: webRoot,
  base: '/local/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(webRoot, 'src') } },
  build: {
    outDir: resolve('dist/local/web'),
    emptyOutDir: true,
    rollupOptions: { output: {
      entryFileNames: 'assets/[name]-[hash].js',
      chunkFileNames: 'assets/[name]-[hash].js',
      assetFileNames: 'assets/[name]-[hash][extname]',
    } },
  },
});
