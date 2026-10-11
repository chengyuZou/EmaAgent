// 桌面测试不启动应用构建与样式插件, 需要 DOM 的测试自行指定 JSDOM.
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    // 该包只发布 module 字段, Vitest 2 的 Node 入口解析不接受它.
    alias: {
      '@lemonneko/crop-empty-pixels': resolve(
        __dirname,
        'node_modules/@lemonneko/crop-empty-pixels/dist/index.js',
      ),
      '@ema-agent/server/settings/wallpaperCatalog.js': resolve(
        __dirname,
        '../server/src/settings/wallpaperCatalog.ts',
      ),
      '@ema-agent/server/settings/themeCatalog.js': resolve(
        __dirname,
        '../server/src/settings/themeCatalog.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'src/**/tests/*.test.ts',
      'src/**/tests/*.test.tsx',
    ],
  },
});
