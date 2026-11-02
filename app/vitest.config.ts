import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Threads start faster than forks on Windows and avoid worker start-up timeouts.
    pool: 'threads',
    // Warehouse tests run real MySQL queries; under a full run on a busy machine some take close to
    // five seconds, so the default limit failed tests that were only slow.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'apps/*/test/**/*.test.{ts,tsx}'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    coverage: { include: ['packages/*/src/**'], reporter: ['text-summary'] },
  },
});
