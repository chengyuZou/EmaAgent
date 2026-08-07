// 为 UnoCSS 生成可运行时换色的色阶与亮度、饱和度修饰符。
//
// Adapted from @proj-airi/unocss-preset-chromatic (D:\Github\chromatic).
// Generates OKLCH-based color scales driven by CSS custom properties so the
// full `primary` + `violet` palettes update at runtime from a single hue var.
//
// Runtime contract:
//   --chromatic-hue      base hue in degrees (user-settable)
//   --chromatic-bri      brightness multiplier (default 1)
//   --chromatic-sat      saturation multiplier (default 1)
//   --chromatic-chroma-* per-shade chroma derived from base chroma
//
// Usage in uno.config.ts:
//   import { createPresetChromatic, EMA_PRIMARY_HUE, EMA_VIOLET_OFFSET } from './uno-preset-chromatic.js';
//   const chromatic = createPresetChromatic();
//   chromatic({ baseHue: EMA_PRIMARY_HUE, colors: { primary: 0, violet: EMA_VIOLET_OFFSET } })

// Import from @unocss/core, NOT the `unocss` aggregate: this file is reached
// at runtime by utils/theme.ts (browser graph), and the aggregate entry drags
// every transformer — including oxc-parser's wasm binding — into the bundle.
import type { CSSEntries, VariantObject } from '@unocss/core';
import { definePreset, LAYER_PREFLIGHTS } from '@unocss/core';

// ── EmaAgent default hues ─────────────────────────────────────────────────────

/** Ema's default water-blue (cyan). Change this to shift the whole theme. */
export const EMA_PRIMARY_HUE = 200;

/**
 * Violet secondary hue offset from primary.
 * 200 + 85 = 285° ≈ violet/purple — stays ~85° "ahead" of primary.
 * Matches tokens.css --ema-violet (285° at the default hue).
 */
export const EMA_VIOLET_OFFSET = 85;

// ── CSS variable names ────────────────────────────────────────────────────────

export const VAR_HUE        = '--chromatic-hue';
export const VAR_BRIGHTNESS = '--chromatic-bri';
export const VAR_SATURATION = '--chromatic-sat';
/** CSS variable that scales all rounded-* values at runtime (tokens.css defines it). */
export const VAR_RADIUS = '--ema-radius';

export type Shade = 'DEFAULT' | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

export const VAR_CHROMA_SHADES = {
  DEFAULT: '--chromatic-chroma',
  50:      '--chromatic-chroma-50',
  100:     '--chromatic-chroma-100',
  200:     '--chromatic-chroma-200',
  300:     '--chromatic-chroma-300',
  400:     '--chromatic-chroma-400',
  500:     '--chromatic-chroma-500',
  600:     '--chromatic-chroma-600',
  700:     '--chromatic-chroma-700',
  800:     '--chromatic-chroma-800',
  900:     '--chromatic-chroma-900',
  950:     '--chromatic-chroma-950',
} as const satisfies Record<Shade, string>;

// ── Preset options ────────────────────────────────────────────────────────────

export interface PresetChromaticOptions {
  baseHue: number;
  /** color name → hue offset in degrees from baseHue. */
  colors:  Record<string, number>;
  /** Bake colors to static HEX at build time. Default false (use CSS vars). */
  bakeColors?: boolean;
  modifierUtilityPrefixes?: string[];
  modifierVariantName?:     string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const DEFAULT_MODIFIER_UTILITY_PREFIXES = ['bg', 'text', 'border', 'ring', 'fill', 'stroke'];
const percentRE = /^\d{1,3}(?:\.\d+)?$/;
const modifierTokenRE = /([*~])(\d{1,3}(?:\.\d+)?)/gy;

export interface ChromaticModifierMatch {
  base: string;
  brightness?: string;
  saturation?: string;
}

function escapeRegExp(raw: string): string {
  return raw.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createColorUtilityPrefixRE(prefixes: string[]): RegExp {
  const sanitized = prefixes.map(p => p.trim()).filter(Boolean).map(escapeRegExp);
  return sanitized.length ? new RegExp(`^(?:${sanitized.join('|')})-`) : /^$/;
}

function toRatio(raw: string): string {
  const parsed  = Number.parseFloat(raw);
  const bounded = Number.isFinite(parsed) ? Math.min(200, Math.max(0, parsed)) : 100;
  return `${Number((bounded / 100).toFixed(4))}`;
}

export function parseChromaticModifiers(matcher: string): ChromaticModifierMatch | undefined {
  const modifierStart = matcher.search(/[*~]/);
  if (modifierStart <= 0) return undefined;

  const base = matcher.slice(0, modifierStart);
  const suffix = matcher.slice(modifierStart);
  let brightness: string | undefined;
  let saturation: string | undefined;
  let cursor = 0;

  modifierTokenRE.lastIndex = 0;
  while (cursor < suffix.length) {
    modifierTokenRE.lastIndex = cursor;
    const match = modifierTokenRE.exec(suffix);
    if (!match || match.index !== cursor) return undefined;

    const operator = match[1];
    const rawValue = match[2];
    if (!rawValue || !percentRE.test(rawValue)) return undefined;
    if (operator === '*') {
      if (brightness !== undefined) return undefined;
      brightness = rawValue;
    } else {
      if (saturation !== undefined) return undefined;
      saturation = rawValue;
    }
    cursor = modifierTokenRE.lastIndex;
  }

  return brightness || saturation ? { base, brightness, saturation } : undefined;
}

/**
 * Variant that enables per-utility brightness/saturation modifiers:
 *   bg-primary-500*120  → brightness 120%
 *   bg-primary-500~80   → saturation 80%
 *   bg-primary-500*110~90 → both
 */
function variantChromaticAdjustments(
  utilityPrefixes: string[] = DEFAULT_MODIFIER_UTILITY_PREFIXES,
  name = 'chromatic-modifiers',
): VariantObject {
  const colorUtilityPrefixRE = createColorUtilityPrefixRE(utilityPrefixes);

  return {
    name,
    match(matcher: string) {
      if (!colorUtilityPrefixRE.test(matcher)) return;

      const modifiers = parseChromaticModifiers(matcher);
      if (!modifiers) return;
      const { base, brightness, saturation } = modifiers;

      return {
        matcher: base,
        body: (body: CSSEntries) => {
          if (!body.length) return body;
          const next = [...body];
          if (brightness) next.push([VAR_BRIGHTNESS, toRatio(brightness)]);
          if (saturation) next.push([VAR_SATURATION, toRatio(saturation)]);
          return next;
        },
      };
    },
  };
}

// ── Color shade generators ────────────────────────────────────────────────────

function lightness(level: number): string {
  return `clamp(0%, calc(${level}% * var(${VAR_BRIGHTNESS})), 100%)`;
}

function chroma(level: string): string {
  return `calc(${level} * var(${VAR_SATURATION}))`;
}

/**
 * CSS-variable-based color shades. The actual hue value is resolved at runtime
 * from `--chromatic-hue`, so changing that var updates the full palette.
 */
export function createVarBasedColorShades(hueOffset: number): Record<Shade, string> {
  const h = (o: number): string => `calc(var(${VAR_HUE}) + ${o})`;
  return {
    DEFAULT: `oklch(${lightness(62)} ${chroma(`var(${VAR_CHROMA_SHADES.DEFAULT})`)} ${h(hueOffset)} / %alpha)`,
    50:  `color-mix(in srgb, oklch(${lightness(95)} ${chroma(`var(${VAR_CHROMA_SHADES[50]})`)} ${h(hueOffset)} / %alpha) 30%, oklch(100% 0 360 / %alpha))`,
    100: `color-mix(in srgb, oklch(${lightness(95)} ${chroma(`var(${VAR_CHROMA_SHADES[100]})`)} ${h(hueOffset)} / %alpha) 80%, oklch(100% 0 360 / %alpha))`,
    200: `oklch(${lightness(90)} ${chroma(`var(${VAR_CHROMA_SHADES[200]})`)} ${h(hueOffset)} / %alpha)`,
    300: `oklch(${lightness(85)} ${chroma(`var(${VAR_CHROMA_SHADES[300]})`)} ${h(hueOffset)} / %alpha)`,
    400: `oklch(${lightness(74)} ${chroma(`var(${VAR_CHROMA_SHADES[400]})`)} ${h(hueOffset)} / %alpha)`,
    500: `oklch(${lightness(62)} ${chroma(`var(${VAR_CHROMA_SHADES[500]})`)} ${h(hueOffset)} / %alpha)`,
    600: `oklch(${lightness(54)} ${chroma(`var(${VAR_CHROMA_SHADES[600]})`)} ${h(hueOffset)} / %alpha)`,
    700: `oklch(${lightness(49)} ${chroma(`var(${VAR_CHROMA_SHADES[700]})`)} ${h(hueOffset)} / %alpha)`,
    800: `oklch(${lightness(42)} ${chroma(`var(${VAR_CHROMA_SHADES[800]})`)} ${h(hueOffset)} / %alpha)`,
    900: `oklch(${lightness(37)} ${chroma(`var(${VAR_CHROMA_SHADES[900]})`)} ${h(hueOffset)} / %alpha)`,
    950: `oklch(${lightness(29)} ${chroma(`var(${VAR_CHROMA_SHADES[950]})`)} ${h(hueOffset)} / %alpha)`,
  };
}

/**
 * Statically baked color shades. Hue is fixed at build time.
 * Use when CSS variable runtime switching is not needed (e.g. SSR, extensions).
 */
export function createBakedColorShades(baseHue: number, hueOffset: number): Record<Shade, string> {
  const defaultChroma = 0.18 + Math.cos(baseHue * Math.PI / 180) * 0.04;
  const hue = baseHue + hueOffset;
  return {
    DEFAULT: `oklch(${lightness(62)} ${chroma(`${defaultChroma}`)} ${hue} / %alpha)`,
    50:  `color-mix(in srgb, oklch(${lightness(95)} ${chroma(`${defaultChroma * 0.3}`)} ${hue} / %alpha) 30%, oklch(100% 0 360 / %alpha))`,
    100: `color-mix(in srgb, oklch(${lightness(95)} ${chroma(`${defaultChroma * 0.5}`)} ${hue} / %alpha) 80%, oklch(100% 0 360 / %alpha))`,
    200: `oklch(${lightness(90)} ${chroma(`${defaultChroma * 0.6}`)} ${hue} / %alpha)`,
    300: `oklch(${lightness(85)} ${chroma(`${defaultChroma * 0.75}`)} ${hue} / %alpha)`,
    400: `oklch(${lightness(74)} ${chroma(`${defaultChroma * 0.85}`)} ${hue} / %alpha)`,
    500: `oklch(${lightness(62)} ${chroma(`${defaultChroma}`)} ${hue} / %alpha)`,
    600: `oklch(${lightness(54)} ${chroma(`${defaultChroma * 1.15}`)} ${hue} / %alpha)`,
    700: `oklch(${lightness(49)} ${chroma(`${defaultChroma * 1.1}`)} ${hue} / %alpha)`,
    800: `oklch(${lightness(42)} ${chroma(`${defaultChroma * 0.85}`)} ${hue} / %alpha)`,
    900: `oklch(${lightness(37)} ${chroma(`${defaultChroma * 0.7}`)} ${hue} / %alpha)`,
    950: `oklch(${lightness(29)} ${chroma(`${defaultChroma * 0.5}`)} ${hue} / %alpha)`,
  };
}

// ── Preset factory ────────────────────────────────────────────────────────────

export function createPresetChromatic(calledFromExtension = false) {
  return definePreset<PresetChromaticOptions>((options) => ({
    name: 'ema-chromatic',
    ...(options && {
      variants: [
        variantChromaticAdjustments(
          options.modifierUtilityPrefixes,
          options.modifierVariantName,
        ),
      ],
      theme: {
        colors: Object.entries(options.colors).reduce<Record<string, Record<Shade, string>>>(
          (acc, [key, hueOffset]) => {
            const offset = hueOffset as number;
            acc[key] = (options.bakeColors ?? false) || calledFromExtension
              ? createBakedColorShades(options.baseHue, offset)
              : createVarBasedColorShades(offset);
            return acc;
          },
          {},
        ),
      },
      preflights: [
        {
          layer: LAYER_PREFLIGHTS,
          getCSS() {
            return `
:root {
  ${VAR_HUE}: ${options.baseHue};
  ${VAR_BRIGHTNESS}: 1;
  ${VAR_SATURATION}: 1;
  ${VAR_CHROMA_SHADES.DEFAULT}: calc(0.18 + (cos(var(${VAR_HUE}) * 3.14159265 / 180) * 0.04));
  ${VAR_CHROMA_SHADES[50]}:  calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.3);
  ${VAR_CHROMA_SHADES[100]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.5);
  ${VAR_CHROMA_SHADES[200]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.6);
  ${VAR_CHROMA_SHADES[300]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.75);
  ${VAR_CHROMA_SHADES[400]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.85);
  ${VAR_CHROMA_SHADES[500]}: var(${VAR_CHROMA_SHADES.DEFAULT});
  ${VAR_CHROMA_SHADES[600]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 1.15);
  ${VAR_CHROMA_SHADES[700]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 1.1);
  ${VAR_CHROMA_SHADES[800]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.85);
  ${VAR_CHROMA_SHADES[900]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.7);
  ${VAR_CHROMA_SHADES[950]}: calc(var(${VAR_CHROMA_SHADES.DEFAULT}) * 0.5);
}
            `.trim();
          },
        },
      ],
    }),
  }));
}
