import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';
import { DEFAULT_WALLPAPER_SETTINGS, WALLPAPER_SETTING_KEYS } from './wallpaperCatalog.js';

const wallpaperImageParamsSchema = z.object({
  /** 该图的不透明度, 0-1. */
  opacity: z.number().min(0).max(1).default(0.35),
  /** 该图的模糊半径 px, 0-40. */
  blur: z.number().min(0).max(40).default(0),
});

const wallpaperSettingsSchema = z.object({
  /** 壁纸开关; 关闭时显示默认桌布, 图片与参数全部保留. */
  enabled: z.boolean().default(false),
  /** 界面表面的材质, 与图片自身的不透明度和模糊分开. */
  materialMode: z.enum(['translucent', 'frosted']).default('translucent'),
  /** 当前壁纸资源名; 空串 = 无壁纸, 显示默认桌布. */
  activeImage: z.string().max(120).default(''),
  /** 每张图各自的调参, 键 = 资源名(壁纸文件夹内带后缀的文件名). */
  images: z.record(z.string(), wallpaperImageParamsSchema).default({}),
});

export type WallpaperImageParams = z.infer<typeof wallpaperImageParamsSchema>;
export type WallpaperSettings = z.infer<typeof wallpaperSettingsSchema>;
export type MaterialMode = WallpaperSettings['materialMode'];

export const chatWallpaperSetting = defineSetting({
  key: WALLPAPER_SETTING_KEYS.chat,
  apply: 'immediate',
  defaultValue: DEFAULT_WALLPAPER_SETTINGS,
  schema: wallpaperSettingsSchema,
});

export const settingsWallpaperSetting = defineSetting({
  key: WALLPAPER_SETTING_KEYS.settings,
  apply: 'immediate',
  defaultValue: DEFAULT_WALLPAPER_SETTINGS,
  schema: wallpaperSettingsSchema,
});
