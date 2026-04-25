import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks', // isolate each test file in a separate process (real net servers)
  },
});
