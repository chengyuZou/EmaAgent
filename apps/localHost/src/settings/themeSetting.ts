// 定义桌面主题与正文阅读字体的可调范围;frontend.* 域例外,托管于 localHost(见 src/settings/README)。

import { defineSetting } from '@ema-agent/settings';

export type ThemeMode = 'light' | 'dark';
export type ContentFontPreset = 'system' | 'rounded' | 'reading' | 'custom';

export interface ThemeSettings {
  hue: number;
  radius: number;
  mode: ThemeMode;
  contentFontPreset: ContentFontPreset;
  contentFontFamily: string;
}

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  hue: 200,
  radius: 1,
  mode: 'light',
  contentFontPreset: 'system',
  contentFontFamily: '',
};

export const themeSetting = defineSetting<ThemeSettings>({
  key: 'frontend.theme',
  kind: 'object',
  apply: 'immediate',
  defaultValue: DEFAULT_THEME_SETTINGS,
  decode(value: unknown) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_THEME_SETTINGS, ...value };
    if (typeof merged.hue !== 'number' || merged.hue < 0 || merged.hue > 360) return { ok: false };
    if (typeof merged.radius !== 'number' || merged.radius < 0 || merged.radius > 3) return { ok: false };
    if (merged.mode !== 'light' && merged.mode !== 'dark') return { ok: false };
    if (!isFontPreset(merged.contentFontPreset)) return { ok: false };
    if (!isSafeFontFamily(merged.contentFontFamily)) return { ok: false };
    return {
      ok: true,
      value: {
        hue: merged.hue,
        radius: merged.radius,
        mode: merged.mode,
        contentFontPreset: merged.contentFontPreset,
        contentFontFamily: merged.contentFontFamily,
      },
    };
  },
});

function isFontPreset(value: unknown): value is ContentFontPreset {
  return value === 'system'
    || value === 'rounded'
    || value === 'reading'
    || value === 'custom';
}

function isSafeFontFamily(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 80
    && /^[\p{L}\p{N} _.-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
