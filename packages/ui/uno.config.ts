// ── EmaAgent shared UnoCSS preset ───────────────────────────────────────────
//
// Single source of truth for design tokens. Consumed by:
//   - packages/ui            (component library + Ladle stories)
//   - packages/desktop-ui    (business components)
//   - apps/desktop           (main window + sub-windows)
//
// Usage in a downstream uno.config.ts:
//
//   import { defineConfig } from 'unocss';
//   import { emaSharedPreset } from '@ema-agent/ui/uno.config';
//   export default defineConfig({
//     presets: [...emaSharedPreset()],
//     content: { pipeline: { include: [/src\/.*\.(t|j)sx?$/] } },
//   });
//
// IMPORTANT: do NOT add app-specific safelist or content globs here. This
// file is shared across the workspace — anything app-specific belongs in
// that app's own uno.config.ts.

// Import presets from their own packages, NOT the `unocss` aggregate entry —
// the aggregate re-exports every transformer, and transformer-attributify-jsx
// drags oxc-parser's wasm binding into Vite's browser module graph (the
// unocss vite plugin injects this config file into the graph for HMR).
import type { Preset, UserConfig } from '@unocss/core';
import presetAttributify from '@unocss/preset-attributify';
import presetIcons from '@unocss/preset-icons';
import presetTypography from '@unocss/preset-typography';
import presetWind3 from '@unocss/preset-wind3';
import {
  createPresetChromatic,
  EMA_PRIMARY_HUE,
  EMA_VIOLET_OFFSET,
  VAR_HUE,
} from './src/uno-preset-chromatic.js';

/** CSS variable that scales all rounded-* values at runtime. */
export const VAR_RADIUS = '--ema-radius';

/**
 * Universal rounding scale driven by --ema-radius (default 1).
 * Set --ema-radius: 0 for sharp UI, 1.5 for softer look.
 * pill/full are fixed — they never scale with the radius var.
 */
export const RADIUS_SCALE = {
  sm:      `calc(6px  * var(${VAR_RADIUS}))`,  // tags, dot badges, small chips
  DEFAULT: `calc(8px  * var(${VAR_RADIUS}))`,  // buttons, inputs, dropdowns
  md:      `calc(10px * var(${VAR_RADIUS}))`,  // cards
  lg:      `calc(14px * var(${VAR_RADIUS}))`,  // dialogs, popovers, sub-window panels
  xl:      `calc(20px * var(${VAR_RADIUS}))`,  // main window itself, hero containers
  pill:    '9999px',                            // pill buttons — always full pill
  full:    '50%',                               // circular icon buttons, dots, avatars
} as const;

/** Default text font stack — mixed CJK + Latin */
export const FONT_FAMILY = {
  sans: '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", system-ui, sans-serif',
  mono: 'Consolas, Monaco, "Courier New", monospace',
} as const;

// ── Safelist ────────────────────────────────────────────────────────────────

/**
 * Generate dynamic color classes that UnoCSS can't infer from static source
 * scanning. Without this, classes assembled at runtime (e.g.
 * `bg-primary-${level}`) wouldn't be in the final CSS.
 *
 * Keep this conservative — every class here adds to CSS bundle size.
 */
function buildSafelist(): string[] {
  const out: string[] = [];

  // Primary / violet at all scales × common utilities
  const scales = ['50','100','200','300','400','500','600','700','800','900','950'];
  const utilities = ['bg', 'text', 'border', 'ring'];
  const opacities = ['', '/10', '/20', '/30', '/50', '/70', '/80'];

  for (const color of ['primary', 'violet']) {
    for (const util of utilities) {
      for (const s of scales) {
        for (const o of opacities) {
          out.push(`${util}-${color}-${s}${o}`);
        }
      }
    }
  }

  // Status colors used by Callout / Badge
  for (const sem of ['green', 'red', 'amber', 'sky']) {
    for (const s of ['100', '500', '900']) {
      out.push(`bg-${sem}-${s}/20`);
      out.push(`text-${sem}-${s}`);
      out.push(`border-${sem}-${s}/40`);
    }
  }

  return out;
}

// ── The preset itself ──────────────────────────────────────────────────────

/**
 * Returns the array of presets + theme + safelist + shortcuts to spread into
 * a downstream `defineConfig({...})`. We return a config object factory
 * rather than a finalized config so each consumer can add their own
 * `content` globs and additional presets.
 */
export interface EmaSharedPresetOptions {
  /** Extra iconify collections (e.g. lobe-icons via createExternalPackageIconLoader). */
  iconCollections?: Record<string, unknown>;
}

export function emaSharedPreset(options: EmaSharedPresetOptions = {}): Preset[] {
  const chromatic = createPresetChromatic();
  return [
    presetWind3({
      // Tailwind v3 compatibility. We keep `prefersColor: 'media'` off so
      // dark mode is class-driven (toggled via root `.dark` class).
      dark: 'class',
    }),
    // OKLCH dynamic color system — primary (pink) + violet derived from one hue var.
    // Changing --chromatic-hue at runtime shifts both palettes simultaneously.
    chromatic({
      baseHue: EMA_PRIMARY_HUE,
      colors: {
        primary: 0,                // stays at EMA_PRIMARY_HUE (350 = pink)
        violet:  EMA_VIOLET_OFFSET, // 350 + (-65) = 285 = violet
      },
    }) as unknown as Preset,
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn:  true,
      extraProperties: {
        'display':         'inline-block',
        'vertical-align':  'middle',
      },
      ...(options.iconCollections
        ? { collections: options.iconCollections as never }
        : {}),
    }),
    presetTypography({
      cssExtend: {
        'pre': { 'border-radius': RADIUS_SCALE.md },
        'code': { 'border-radius': RADIUS_SCALE.sm },
      },
    }),
    // -- Shape system: --ema-radius scales all rounded-* values at runtime --
    {
      name: 'ema-shape',
      preflights: [
        {
          getCSS: () => `:root { ${VAR_RADIUS}: 1; }`,
        },
      ],
    },
    // -- Custom animations: keyframes + theme entries for animate-* utilities --
    {
      name: 'ema-animations',
      theme: {
        animation: {
          'fade-in':  'ema-fade-in  150ms ease-out',
          'fade-out': 'ema-fade-out 100ms ease-in  forwards',
          'scale-in': 'ema-scale-in 150ms ease-out',
        },
      },
      preflights: [
        {
          getCSS: () => `
@keyframes progress-shine {
  0%   { opacity: 0.4; transform: scale(0, 1); }
  100% { opacity: 0;   transform: scale(1, 1); }
}
@keyframes ema-fade-in  { from { opacity: 0; } to { opacity: 1; } }
@keyframes ema-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes ema-scale-in { from { opacity: 0; scale: 0.95; } to { opacity: 1; scale: 1; } }
          `.trim(),
        },
      ],
    },
  ];
}

/**
 * The shared theme object — `colors`, `borderRadius`, `fontFamily`.
 * Spread this into the consumer's `defineConfig({ theme: { ... } })`.
 */
export function emaSharedTheme() {
  return {
    // primary + violet colors are injected by the chromatic preset in emaSharedPreset().
    // Do NOT re-declare them here — explicit theme keys override preset theme keys in
    // UnoCSS, which would shadow the CSS-variable-based oklch() expressions.
    borderRadius: RADIUS_SCALE,
    fontFamily:   FONT_FAMILY,
  };
}

/** Shorthand class shortcuts available everywhere. */
export function emaSharedShortcuts() {
  return {
    // Frosted glass panel — used by floating dock, popovers, dialogs
    'panel-glass': 'bg-neutral-900/75 backdrop-blur-md border border-primary-200/15 shadow-lg',
    // Pink-white focus ring on interactive elements
    'focus-ring': 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900',
    // Standard interactive transition
    'transition-ema': 'transition-all duration-150 ease-out',
  };
}

/** Safelist export — see buildSafelist comment for rationale. */
export const emaSharedSafelist = buildSafelist();

// ── This package's own config (used by Ladle preview) ──────────────────────

const config: UserConfig = {
  presets:   emaSharedPreset(),
  theme:     emaSharedTheme(),
  shortcuts: emaSharedShortcuts(),
  safelist:  emaSharedSafelist,
  content: {
    pipeline: {
      include: [/src\/.*\.(t|j)sx?$/],
    },
  },
};

export default config;
