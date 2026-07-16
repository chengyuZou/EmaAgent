// 这里配置桌面前端测试，并兼容旧 src 测试与今后统一的 tests 目录。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
