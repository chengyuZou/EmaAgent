// Desktop 通过 Vite alias 直接加载本文件, 不得引入 Node 运行依赖.
import type { WallpaperSettings, WallpaperImageParams } from './wallpaperSetting.js';

export const WALLPAPER_SETTING_KEY = 'frontend.wallpaper';

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  enabled: false,
  materialMode: 'translucent',
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
