import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';
import { DEFAULT_THEME_SETTINGS, THEME_SETTING_KEY } from './themeCatalog.js';

const themeSettingsSchema = z.object({
  hue: z.number().min(0).max(360),
  radius: z.number().min(0).max(3),
  mode: z.enum(['light', 'dark', 'system']),
  /** 正文字体族名; 空串 = 跟随系统. 限制长度与字符集, 防止注入 CSS. */
  readingFont: z.string().max(80).regex(/^[\p{L}\p{N} _.-]*$/u),
  /** 等宽字体族名(代码/JSON/终端/工具行); 空串 = 跟随系统等宽; .default 兼容缺字段的旧库. */
  codeFont: z.string().max(80).regex(/^[\p{L}\p{N} _.-]*$/u).default('Consolas'),
  /** 语法高亮配色; 每套自带代码块底色, 不跟随明暗模式. */
  syntaxTheme: z.enum([
    'github', 'onelight', 'solarized-light',
    'tokyonight', 'onedark', 'dracula', 'monokai', 'nord', 'gruvbox', 'catppuccin', 'solarized-dark',
    'mono',
  ]).default('github'),
  /** 主题色跟随角色立绘动态取色; 开启后手动色相只做回退. */
  hueDynamic: z.boolean().default(false),
});

export type ThemeSettings = z.infer<typeof themeSettingsSchema>;

export const themeSetting = defineSetting({
  key: THEME_SETTING_KEY,
  apply: 'immediate',
  defaultValue: DEFAULT_THEME_SETTINGS,
  schema: themeSettingsSchema,
});
