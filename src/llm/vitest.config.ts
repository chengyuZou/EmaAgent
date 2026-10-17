import { defineConfig } from 'vitest/config';

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
];

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: DEFAULT_EXCLUDE,
  },
});
