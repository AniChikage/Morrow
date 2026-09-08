import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'desktop/renderer', plugins: [react()], server: { port: 5179, strictPort: true }, build: { outDir: '../../.build/ui-preview', emptyOutDir: true } });
