// 壁纸常量注册表: 前端只消费, 不另行定义这些数据.
// 本文件必须保持零运行时依赖: 它允许打进桌面浏览器图(见 desktop vite.config alias).
import type { WallpaperImageParams, WallpaperSettings } from './wallpaperSetting.js';

export type WallpaperWindowTarget = 'chat' | 'settings';

export const WALLPAPER_SETTING_KEYS: Record<WallpaperWindowTarget, string> = {
  chat: 'frontend.wallpaper.chat',
  settings: 'frontend.wallpaper.settings',
};

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  enabled: false,
  acrylicEnabled: false,
  activeImage: '',
  images: {},
};

/* 新图入库时的初始调参; 之后每张图各调各的. */
export const DEFAULT_WALLPAPER_IMAGE_PARAMS: WallpaperImageParams = {
  opacity: 0.35,
  blur: 0,
};

/* 壁纸图允许的扩展名; 上传复制进受管目录时只认这几种. */
export const WALLPAPER_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
