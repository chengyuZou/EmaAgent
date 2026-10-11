// Vite 会把 UnoCSS 配置带入浏览器模块. 使用各子包入口, 避免总入口引入
// oxc-parser 的 WASM 依赖.
import type { UserConfig } from '@unocss/core';
import { createExternalPackageIconLoader } from '@iconify/utils/lib/loader/external-pkg';
import { FileSystemIconLoader } from '@iconify/utils/lib/loader/node-loaders';
import { fileURLToPath } from 'node:url';
import lucideIcons from '@iconify-json/lucide/icons.json';
import solarIcons from '@iconify-json/solar/icons.json';
import lobeIconsJson from '@proj-airi/lobe-icons/icons.json';
import {
  emaSharedPreset,
  emaSharedTheme,
  emaSharedShortcuts,
  emaSharedSafelist,
} from '@ema-agent/ui/uno.config';
// 服务来源的 iconKey 来自 API, 静态扫描看不到, 因此构建配置直接读取图标注册表.
// 用户可以填写 lobe-icons 类名, 所以这些图标全部加入保留列表.
import { PROVIDER_ICON_CLASS_SAFELIST } from '../../src/ui/icons/providers/registry.ts';

const LOBE_ICON_SAFELIST = Object.keys((lobeIconsJson as { icons: Record<string, unknown> }).icons)
  .map((name) => `i-lobe-icons:${name}`);

const config: UserConfig = {
  presets: emaSharedPreset({
    iconCollections: {
      ...createExternalPackageIconLoader('@proj-airi/lobe-icons'),
      // 显式传入图标集, 避免开发环境自动发现时额外添加 icon- 前缀导致加载失败.
      lucide: lucideIcons,
      solar: solarIcons,
      review: FileSystemIconLoader(fileURLToPath(new URL('./src/assets/icons', import.meta.url))),
      main: FileSystemIconLoader(fileURLToPath(new URL('./src/assets/icons', import.meta.url))),
      ema: {
        'context-compact': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1m8-11h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1M6 5h4M6 8h5M6 11h3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      },
    },
  }),
  theme:     emaSharedTheme(),
  shortcuts: emaSharedShortcuts(),
  safelist:  [...emaSharedSafelist, ...PROVIDER_ICON_CLASS_SAFELIST, ...LOBE_ICON_SAFELIST],
  // 扫描桌面入口及实际在这里渲染的工作区组件. 路径相对 apps/desktop.
  content: {
    filesystem: [
      'src/**/*.{ts,tsx}',
      '../../src/ui/components/**/*.tsx',
      '../../src/live2d-react/*.tsx',
      '../../src/builtin-tools/tools/**/UI.tsx',
    ],
  },
};

export default config;
