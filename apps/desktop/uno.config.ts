// Desktop app UnoCSS config — consumes the shared EmaAgent design system
// from @ema-agent/ui (chromatic water-blue/violet palettes, icons, radius scale,
// glass shortcuts) and adds app-specific scanning + safelist on top.
//
// NOTE: no `unocss` aggregate imports here or in the shared config — the
// aggregate drags oxc-parser's wasm binding into Vite's browser module graph
// (the unocss vite plugin injects this config file into the graph for HMR).
import type { UserConfig } from '@unocss/core';
import { createExternalPackageIconLoader } from '@iconify/utils/lib/loader/external-pkg';
import lucideIcons from '@iconify-json/lucide/icons.json';
import solarIcons from '@iconify-json/solar/icons.json';
import lobeIconsJson from '@proj-airi/lobe-icons/icons.json';
import {
  emaSharedPreset,
  emaSharedTheme,
  emaSharedShortcuts,
  emaSharedSafelist,
} from '@ema-agent/ui/uno.config';
// Provider iconKey 是 Server API 的运行时字符串，静态扫描看不到；safelist 从
// 图标注册表同源推导（构建期配置直接读源码，不经包出口）。
// 用户可手写 lobe-icons 类名作 Provider 图标，故 lobe-icons 全量进 safelist（837 个品牌图标）。
import { PROVIDER_ICON_CLASS_SAFELIST } from '../../src/ui/icons/providers/registry.ts';

const LOBE_ICON_SAFELIST = Object.keys((lobeIconsJson as { icons: Record<string, unknown> }).icons)
  .map((name) => `i-lobe-icons:${name}`);

const config: UserConfig = {
  presets: emaSharedPreset({
    iconCollections: {
      ...createExternalPackageIconLoader('@proj-airi/lobe-icons'),
      // 显式传 lucide/solar collection,绕过 preset-icons 自动发现(自动发现时 dev 给 icon
      // 名加 "icon-" 前缀 -> lucide:icon-git-fork failed to load,icon 不显示)
      lucide: lucideIcons,
      solar: solarIcons,
    },
  }),
  theme:     emaSharedTheme(),
  shortcuts: emaSharedShortcuts(),
  safelist:  [...emaSharedSafelist, ...PROVIDER_ICON_CLASS_SAFELIST, ...LOBE_ICON_SAFELIST],
  // Scan the desktop app plus every workspace package that renders UI here.
  // Paths are relative to this config file (apps/desktop/).
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
