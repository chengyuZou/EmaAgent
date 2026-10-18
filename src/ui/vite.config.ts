// Ladle 从当前包读取此配置; 显式传入 UnoCSS 配置以生成组件预览需要的类.

import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';
import unoConfig from './uno.config.js';

export default defineConfig({
  plugins: [UnoCSS(unoConfig)],
});
