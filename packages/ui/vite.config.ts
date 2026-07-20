// 为 Ladle 显式加载 UI 的 UnoCSS 配置，避免子进程从错误目录查找。
//
// Ladle reads vite.config.ts from cwd. This file's only job is to wire
// UnoCSS so component story classNames actually generate CSS during
// preview.
//
// `unocss/vite` reads uno.config.ts from the same directory automatically.

import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';
import unoConfig from './uno.config.js';

export default defineConfig({
  plugins: [UnoCSS(unoConfig)],
});
