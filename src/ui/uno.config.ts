// ── EmaAgent shared UnoCSS preset ───────────────────────────────────────────
//
// Single source of truth for design tokens. Consumed by:
//   - src/ui            (component library + Ladle stories)
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
  VAR_RADIUS,
} from './uno-preset-chromatic.js';

/**
 * Universal rounding scale - references the tokens.css radius variables
 * (apps/desktop-ui/src/styles/tokens.css) so Uno rounded-* and hand-written
 * CSS resolve the same --ema-radius multiplier. pill/full stay fixed.
 */
export const RADIUS_SCALE = {
  sm:      'var(--ema-radius-sm)',    // tags, dot badges, small chips
  DEFAULT: 'var(--ema-radius-xs)',    // bare `rounded` - smallest default radius
  md:      'var(--ema-radius-md)',    // cards
  lg:      'var(--ema-radius-lg)',    // dialogs, popovers, sub-window panels
  xl:      'var(--ema-radius-xl)',    // main window itself, hero containers
  pill:    'var(--ema-radius-pill)',  // pill buttons - fixed 999px
  full:    '50%',                     // circular icon buttons, dots, avatars
} as const;

/**
 * Text font stacks - reference tokens.css variables so Uno font-mono/font-sans
 * and CSS var(--ema-font-*) resolve to the same faces.
 */
export const FONT_FAMILY = {
  sans: 'var(--ema-font-ui)',
  mono: 'var(--ema-font-mono)',
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
        primary: 0,                // stays at EMA_PRIMARY_HUE (200 = water-blue)
        violet:  EMA_VIOLET_OFFSET, // 200 + 85 = 285 = violet
      },
    }) as unknown as Preset,
    // 仅识别 un-* 属性，避免把 React 的 icon/items/options props 误判成工具类。
    presetAttributify({ prefixedOnly: true, prefix: 'un-' }),
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
    // -- Universal box-sizing reset --
    //
    // UnoCSS (unlike Tailwind's `@tailwind base`) does NOT auto-inject this.
    // Without it, form elements (textarea/input/select/button) fall back to
    // the UA stylesheet's `content-box`, so `w-full` + `px-*`/`pr-*` padding
    // ADDS to the declared width instead of being absorbed by it — the
    // element silently renders wider than its parent. Cost a full afternoon
    // chasing a "phantom rounded box" next to ChatInput's textarea that
    // turned out to be exactly this overflow (see chat history 2026-06-16).
    {
      name: 'ema-reset',
      preflights: [
        {
          getCSS: () => `*, ::before, ::after { box-sizing: border-box; }`,
        },
      ],
    },
    // -- Shape system: --ema-radius scales all rounded-* values at runtime --
    // Fact source is tokens.css; this preflight only guarantees the variable
    // exists in environments (e.g. Ladle) that do not load desktop-ui styles.
    {
      name: 'ema-shape',
      preflights: [
        {
          getCSS: () => `:root { ${VAR_RADIUS}: 1; }`,
        },
      ],
    },
    // -- Custom animations: theme entries so animate-* UnoCSS utilities remain
    //    available as aliases. Keyframes live exclusively in style.css.
    {
      name: 'ema-animations',
      theme: {
        animation: {
          'fade-in':     'ema-fade-in     150ms ease-out both',
          'fade-out':    'ema-fade-out    100ms ease-in  forwards',
          'scale-in':    'ema-scale-in    150ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-up':    'ema-slide-up    220ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-down':  'ema-slide-down  220ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-right': 'ema-slide-right 220ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-left':  'ema-slide-left  220ms cubic-bezier(0.16,1,0.3,1) both',
          // Progress 流光(Progress 组件专用;@keyframes 在下方 preflight 定义)
          'progress-shine': 'progress-shine 2s cubic-bezier(0.35,0.08,0.04,0.99) infinite',
        },
      },
      preflights: [
        {
          // progress-shine is Progress-component-only; not in style.css.
          getCSS: () => `
@keyframes progress-shine {
  0%   { opacity: 0.4; transform: scale(0, 1); }
  100% { opacity: 0;   transform: scale(1, 1); }
}
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
    // Frosted glass panel — floating dock, popovers, dialogs
    'panel-glass': 'bg-[var(--ema-surface-4)] backdrop-blur-md border border-[var(--ema-border)] shadow-lg',
    // Lighter glass for cards inside a surface (settings cards, provider grid)
    'card-glass': 'bg-[var(--ema-surface-2)] backdrop-blur-sm border border-[var(--ema-border)]',
    // Focus ring on interactive elements (token-driven, adapts to light/dark)
    'focus-ring': 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ema-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ema-bg)]',
    // Standard interactive transition — 250ms matches AIRI's feel
    'transition-ema': 'transition-all duration-250 ease-in-out',
    // Press-scale feedback (AIRI active:scale-95/98 pattern)
    'press':    'active:scale-[0.95] transition-transform duration-100',
    'press-sm': 'active:scale-[0.98] transition-transform duration-100',
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
