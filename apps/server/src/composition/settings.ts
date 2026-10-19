import { SettingsStore } from '@ema-agent/settings';
import { SettingsRepo, type Database } from '@ema-agent/storage';
import { SETTINGS_DEFINITIONS, SETTINGS_GROUPS } from '../settings/definitions.js';
import { WallpaperImages } from '../settings/wallpaperImages.js';
import { wallpapersDir } from '../platform/paths.js';

export interface SettingsComposition {
  readonly settings: SettingsStore;
  readonly wallpaperImages: WallpaperImages;
}

/**
 * 构造类型化设置入口, 定义和分组一次注册, 重复 key 在启动时直接报错.
 */
export function openSettings(profileDb: Database): SettingsComposition {
  const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite), {
    definitions: SETTINGS_DEFINITIONS,
    groups: SETTINGS_GROUPS,
  });
  const wallpaperImages = new WallpaperImages(wallpapersDir());
  // 在路由开始接收请求前完成文件迁移, 保持资源名与 SQL 中的图片参数配对.
  wallpaperImages.migrateSettingsGallery();
  return { settings, wallpaperImages };
}
