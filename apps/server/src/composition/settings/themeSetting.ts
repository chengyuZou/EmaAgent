// 桌面主题与正文阅读字体的可调范围（frontend.* 例外，托管于 server，见 src/settings/README）。
import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';

const themeSettingsSchema = z.object({
  hue: z.number().min(0).max(360),
  radius: z.number().min(0).max(3),
  mode: z.enum(['light', 'dark']),
  contentFontPreset: z.enum(['system', 'rounded', 'reading', 'custom']),
  /** 自定义字体族名；限制长度与字符集，防止注入 CSS。 */
  contentFontFamily: z.string().max(80).regex(/^[\p{L}\p{N} _.-]*$/u),
  /** 等宽字体(代码/JSON/终端/工具行); .default 让旧库存值缺字段时也能解析。 */
  monoFontPreset: z.enum(['cascadia', 'jetbrains', 'consolas', 'system', 'custom']).default('cascadia'),
  monoFontFamily: z.string().max(80).regex(/^[\p{L}\p{N} _.-]*$/u).default(''),
  /** 语法高亮配色; auto = 深色 Tokyo Night / 浅色 GitHub。 */
  syntaxThemePreset: z.enum(['auto', 'github', 'tokyonight', 'mono']).default('auto'),
});

export type ThemeSettings = z.infer<typeof themeSettingsSchema>;

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  hue: 200,
  radius: 1,
  mode: 'light',
  contentFontPreset: 'system',
  contentFontFamily: '',
  monoFontPreset: 'cascadia',
  monoFontFamily: '',
  syntaxThemePreset: 'auto',
};

export const themeSetting = defineSetting({
  key: 'frontend.theme',
  apply: 'immediate',
  defaultValue: DEFAULT_THEME_SETTINGS,
  schema: themeSettingsSchema,
});
