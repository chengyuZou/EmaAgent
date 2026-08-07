// Desktop app UnoCSS config — consumes the shared EmaAgent design system
// from @ema-agent/ui (chromatic water-blue/violet palettes, icons, radius scale,
// glass shortcuts) and adds app-specific scanning + safelist on top.
//
// NOTE: no `unocss` aggregate imports here or in the shared config — the
// aggregate drags oxc-parser's wasm binding into Vite's browser module graph
// (the unocss vite plugin injects this config file into the graph for HMR).
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from '@unocss/core';
import { createExternalPackageIconLoader } from '@iconify/utils/lib/loader/external-pkg';
import lucideIcons from '@iconify-json/lucide/icons.json';
import solarIcons from '@iconify-json/solar/icons.json';

// ── Build-time path assertions ────────────────────────────────────────────────
// Fail fast if a scanned directory is missing — catches typos or deleted
// packages before they silently produce an empty CSS bundle.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCANNED_DIRS = [
  '../desktop-ui/src',
  '../../src/ui',
  '../../src/live2d-react',
  '../../src/builtinTools',
];
for (const rel of SCANNED_DIRS) {
  if (!existsSync(resolve(__dirname, rel))) {
    throw new Error(`[uno] content path not found: ${rel}\n  → run "pnpm install" and verify the package exists.`);
  }
}
import {
  emaSharedPreset,
  emaSharedTheme,
  emaSharedShortcuts,
  emaSharedSafelist,
} from '@ema-agent/ui/uno.config';

// Provider iconKeys arrive as runtime strings from the sidecar API — static
// scanning can't see them, so every definition's iconKey must be safelisted.
const PROVIDER_ICON_SAFELIST = [
  'i-lobe-icons:alibabacloud',
  'i-lobe-icons:claude',
  'i-lobe-icons:deepseek',
  'i-lobe-icons:fireworks',
  'i-lobe-icons:gemini',
  'i-lobe-icons:groq',
  'i-lobe-icons:huggingface',
  'i-lobe-icons:jina',
  'i-lobe-icons:lmstudio',
  'i-lobe-icons:mistral',
  'i-lobe-icons:moonshot',
  'i-lobe-icons:ollama',
  'i-lobe-icons:openai',
  'i-lobe-icons:openrouter',
  'i-lobe-icons:perplexity',
  'i-lobe-icons:siliconcloud',
  'i-lobe-icons:together',
  'i-lobe-icons:xai',
  'i-lobe-icons:zhipu',
];

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
  safelist:  [...emaSharedSafelist, ...PROVIDER_ICON_SAFELIST],
  // Scan the desktop app plus every workspace package that renders UI here.
  // Paths are relative to this config file (apps/desktop/).
  content: {
    filesystem: [
      'src/**/*.{ts,tsx}',
      '../desktop-ui/src/**/*.{ts,tsx}',
      '../../src/ui/**/*.{ts,tsx}',
      '../../src/live2d-react/**/*.{ts,tsx}',
      // Tool 目录里的 UI.tsx(每个复杂 Tool 自带的展示,经 @ema-agent/tool-builtin/ui 出口)
      '../../src/builtinTools/**/*.{ts,tsx}',
    ],
  },
};

export default config;
