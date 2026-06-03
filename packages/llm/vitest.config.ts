import { defineConfig } from 'vitest/config';

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
];

const runLiveTests = process.env['EMA_AGENT_RUN_LIVE_TESTS'] === '1';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: runLiveTests ? DEFAULT_EXCLUDE : [...DEFAULT_EXCLUDE, 'tests/live-*.test.ts'],
  },
});
