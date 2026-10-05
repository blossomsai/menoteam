import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const root = resolve('docs/prototypes/2026-10-02/team-workbench-v3');

export default defineConfig({
  root,
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(root, 'dist'), emptyOutDir: true },
});
