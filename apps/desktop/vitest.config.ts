// Desktop 单元测试只加载 tests/ 下的 Node 测试，不启动应用构建与样式插件。
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    // 该包只发布 module 字段;Vitest 2 的 Node 入口解析不会像生产 Vite 一样接受它。
    alias: {
      '@lemonneko/crop-empty-pixels': resolve(
        __dirname,
        'node_modules/@lemonneko/crop-empty-pixels/dist/index.js',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
