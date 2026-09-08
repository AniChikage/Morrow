import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['desktop/**/*.test.{ts,tsx}'], environment: 'node', testTimeout: 10000 } });
