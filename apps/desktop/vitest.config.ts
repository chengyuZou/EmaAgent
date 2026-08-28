// Desktop 单元测试只加载 tests/ 下的 Node 测试，不启动应用构建与样式插件。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
