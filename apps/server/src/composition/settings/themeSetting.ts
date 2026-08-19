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
});

export type ThemeSettings = z.infer<typeof themeSettingsSchema>;

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  hue: 200,
  radius: 1,
  mode: 'light',
  contentFontPreset: 'system',
  contentFontFamily: '',
};

export const themeSetting = defineSetting<ThemeSettings>({
  key: 'frontend.theme',
  apply: 'immediate',
  defaultValue: DEFAULT_THEME_SETTINGS,
  schema: themeSettingsSchema,
});
