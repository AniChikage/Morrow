import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/main', rollupOptions: { input: resolve('desktop/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/preload', rollupOptions: { input: resolve('desktop/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    root: 'desktop/renderer', plugins: [react()],
    resolve: { alias: { '@': resolve('desktop/renderer'), '@shared': resolve('desktop/shared') } },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: resolve('out/renderer'), rollupOptions: { input: resolve('desktop/renderer/index.html') } }
  }
});
