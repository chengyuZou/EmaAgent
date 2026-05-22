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

import { defineConfig, presetAttributify, presetIcons, presetTypography, type Preset } from 'unocss';
import presetWind3 from '@unocss/preset-wind3';

// ── Design tokens ───────────────────────────────────────────────────────────

/**
 * Ema's signature pink-white (her hair main color). Used for:
 *   - Main window glow border breathing animation
 *   - Active button highlights
 *   - Focus rings
 *   - Primary brand accents
 *
 * 50-950 scale follows Tailwind convention so existing utilities like
 * `bg-primary-500/20` work out of the box.
 */
export const PINK_WHITE_SCALE = {
  50:  '#fff5f9',
  100: '#ffe9f1',
  200: '#ffd6e6',   // ← the signature shade users see in the glow
  300: '#ffbed4',
  400: '#ff9eba',
  500: '#ff7aa1',
  600: '#ef5582',
  700: '#cf3a66',
  800: '#a82a52',
  900: '#7c1f3e',
  950: '#4a0f24',
} as const;

/**
 * Cool pink-violet accent (secondary). Used for narrative-mode bubbles,
 * memory recall indicators — anything that needs to differ visually from
 * the warm primary without going full opposite color.
 */
export const VIOLET_SCALE = {
  50:  '#f6f3ff',
  100: '#ece6ff',
  200: '#dcceff',
  300: '#c6a8ff',
  400: '#aa7eff',
  500: '#9b5eff',
  600: '#8347e8',
  700: '#6b35bf',
  800: '#552a96',
  900: '#3e1f6c',
  950: '#241140',
} as const;

/**
 * Universal rounding scale. All visual rectangles MUST use one of these.
 * Square corners (border-radius: 0) are forbidden per design rules.
 */
export const RADIUS_SCALE = {
  sm:      '6px',     // tags, dot badges, small chips
  DEFAULT: '8px',     // buttons, inputs, dropdowns
  md:      '10px',    // cards
  lg:      '14px',    // dialogs, popovers, sub-window panels
  xl:      '20px',    // main window itself, hero containers
  pill:    '9999px',  // pill buttons
  full:    '50%',     // circular icon buttons, dots, avatars
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
export function emaSharedPreset(): Preset[] {
  return [
    presetWind3({
      // Tailwind v3 compatibility. We keep `prefersColor: 'media'` off so
      // dark mode is class-driven (toggled via root `.dark` class).
      dark: 'class',
    }),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn:  true,
      extraProperties: {
        'display':         'inline-block',
        'vertical-align':  'middle',
      },
    }),
    presetTypography({
      cssExtend: {
        'pre': { 'border-radius': RADIUS_SCALE.md },
        'code': { 'border-radius': RADIUS_SCALE.sm },
      },
    }),
    // -- Custom animations (preflight keyframes) --
    {
      name: 'ema-animations',
      preflights: [
        {
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
    colors: {
      primary: PINK_WHITE_SCALE,
      violet:  VIOLET_SCALE,
    },
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

export default defineConfig({
  presets:   emaSharedPreset(),
  theme:     emaSharedTheme(),
  shortcuts: emaSharedShortcuts(),
  safelist:  emaSharedSafelist,
  content: {
    pipeline: {
      include: [/src\/.*\.(t|j)sx?$/],
    },
  },
});
