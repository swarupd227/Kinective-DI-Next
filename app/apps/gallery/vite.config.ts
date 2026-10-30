import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { csp, experienceLayerProxy } from '../../build/csp.ts';

export default defineConfig({
  plugins: [react(), csp()],
  server: { port: 5173, strictPort: true, proxy: experienceLayerProxy },
  preview: { port: 4173, strictPort: true, proxy: experienceLayerProxy },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
});
