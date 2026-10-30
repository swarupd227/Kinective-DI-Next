import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { csp, experienceLayerProxy } from '../../build/csp.ts';

export default defineConfig({
  plugins: [react(), csp()],
  server: { port: 5174, strictPort: true, proxy: experienceLayerProxy },
  preview: { port: 4174, strictPort: true, proxy: experienceLayerProxy },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    // Scripts are never inlined as data: URLs: the CSP allows scripts from 'self' only, and the
    // voice capture worklet is loaded by URL (spec 7.2).
    assetsInlineLimit: (file) => (/\.[cm]?js$/.test(file) ? false : undefined),
  },
});
