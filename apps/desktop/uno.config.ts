// Desktop app UnoCSS config — consumes the shared EmaAgent design system
// from @ema-agent/ui (chromatic pink/violet palettes, icons, radius scale,
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

// ── Build-time path assertions ────────────────────────────────────────────────
// Fail fast if a scanned directory is missing — catches typos or deleted
// packages before they silently produce an empty CSS bundle.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCANNED_DIRS = [
  '../../packages/desktop-ui/src',
  '../../packages/ui/src',
  '../../packages/live2d-react/src',
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
    iconCollections: createExternalPackageIconLoader('@proj-airi/lobe-icons'),
  }),
  theme:     emaSharedTheme(),
  shortcuts: emaSharedShortcuts(),
  safelist:  [...emaSharedSafelist, ...PROVIDER_ICON_SAFELIST],
  // Scan the desktop app plus every workspace package that renders UI here.
  // Paths are relative to this config file (apps/desktop/).
  content: {
    filesystem: [
      'src/**/*.{ts,tsx}',
      '../../packages/desktop-ui/src/**/*.{ts,tsx}',
      '../../packages/ui/src/**/*.{ts,tsx}',
      '../../packages/live2d-react/src/**/*.{ts,tsx}',
    ],
  },
};

export default config;
