// SettingsStore 构造时注册全部业务包的设置定义与分组.
import { AGENT_LIMITS_SETTINGS } from '@ema-agent/agent';
import {
  attachmentCacheMaxBytesSetting,
} from '@ema-agent/attachments';
import { COMPACT_SETTINGS, compactGroup } from '@ema-agent/compact';
import { PERMISSION_SETTINGS } from '@ema-agent/permission';
import { SettingsStore } from '@ema-agent/settings';
import {
  disabledProjectSourcesSetting,
  workspaceInstructionFilesSetting,
} from '@ema-agent/skills';
import { SettingsRepo, type Database } from '@ema-agent/storage';
import {
  disabledToolsSetting,
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
} from '@ema-agent/tools';
import { sandboxNetworkSetting } from '@ema-agent/sandbox';
import { eventDisplaySetting } from '../settings/eventDisplaySetting.js';
import { narrativeQueryModeSetting } from '../settings/narrativeSetting.js';
import { terminalShellExecutableSetting } from '../settings/terminalSetting.js';
import { themeSetting } from '../settings/themeSetting.js';
import { wallpaperSetting } from '../settings/wallpaperSetting.js';
import { WallpaperImages } from '../settings/wallpaperImages.js';
import { wallpapersDir } from '../platform/paths.js';

export interface SettingsComposition {
  readonly settings: SettingsStore;
  readonly wallpaperImages: WallpaperImages;
}

export const SETTINGS_DEFINITIONS = [
  ...AGENT_LIMITS_SETTINGS,
  ...COMPACT_SETTINGS,
  ...PERMISSION_SETTINGS,
  attachmentCacheMaxBytesSetting,
  narrativeQueryModeSetting,
  disabledProjectSourcesSetting,
  disabledToolsSetting,
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
  workspaceInstructionFilesSetting,
  themeSetting,
  eventDisplaySetting,
  terminalShellExecutableSetting,
  wallpaperSetting,
  sandboxNetworkSetting,
] as const;

/**
 * 构造类型化设置入口, 定义和分组一次注册, 重复 key 在启动时直接报错.
 */
export function openSettings(profileDb: Database): SettingsComposition {
  const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite), {
    definitions: SETTINGS_DEFINITIONS,
    groups: [
      compactGroup,
    ],
  });
  const wallpaperImages = new WallpaperImages(wallpapersDir());
  // 在路由开始接收请求前完成文件迁移, 保持资源名与 SQL 中的图片参数配对.
  wallpaperImages.migrateSettingsGallery();
  return { settings, wallpaperImages };
}
