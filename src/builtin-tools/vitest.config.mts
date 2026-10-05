// Diff 的透明底回归需要实际 CSS 文本, 不使用 jsdom 模式默认的空样式替身.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    css: { include: [/fileDiff\.css/] },
  },
});
