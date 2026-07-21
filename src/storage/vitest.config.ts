// 配置 Storage Repository 与 Migration 集成测试。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
