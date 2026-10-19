// 桌面测试不启动应用构建与样式插件, 需要 DOM 的测试自行指定 JSDOM.
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    // 该包只发布 module 字段, Vitest 2 的 Node 入口解析不接受它.
    alias: {
      '@ema-agent/settings/definition': resolve(__dirname, '../../src/settings/types.ts'),
      '@ema-agent/agent/settings': resolve(__dirname, '../../src/agent/settings.ts'),
      '@ema-agent/attachments/settings': resolve(__dirname, '../../src/attachments/settings.ts'),
      '@ema-agent/compact/settings': resolve(__dirname, '../../src/compact/settings.ts'),
      '@ema-agent/permission/settings': resolve(__dirname, '../../src/permission/settings.ts'),
      '@ema-agent/skills/settings': resolve(__dirname, '../../src/skills/settings.ts'),
      '@ema-agent/tools/settings': resolve(__dirname, '../../src/tools/settings.ts'),
      '@ema-agent/sandbox/settings': resolve(__dirname, '../../src/sandbox/settings.ts'),
      '@ema-agent/vishot-capture/settings': resolve(__dirname, '../../src/vishot-capture/settings.ts'),
      '@ema-agent/tools/background/settings': resolve(__dirname, '../../src/tools/background/settings.ts'),
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
      '@ema-agent/server/settings': resolve(__dirname, '../server/src/settings/definitions.ts'),
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
