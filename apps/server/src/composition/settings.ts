// 设置一族：SettingsStore 构造时注册全部业务包设置定义与组（原 SettingsCatalog 已并入 Store）。
import { AGENT_LIMITS_SETTINGS } from '@ema-agent/agent';
import {
  attachmentCacheMaxBytesSetting,
} from '@ema-agent/attachments';
import { COMPACT_SETTINGS, compactGroup } from '@ema-agent/compact';
import {
  kbAlphaSetting,
  kbDefaultTopKSetting,
  kbRerankBlendWeightSetting,
  kbResultMaxCharsSetting,
} from '@ema-agent/knowledge';
import { narrativeQueryModeSetting, narrativeStartOnLaunchSetting } from '@ema-agent/narrative';
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
import { terminalShellExecutableSetting } from '../settings/terminalSetting.js';
import { themeSetting } from '../settings/themeSetting.js';
import { chatWallpaperSetting, settingsWallpaperSetting } from '../settings/wallpaperSetting.js';
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
  kbAlphaSetting,
  kbDefaultTopKSetting,
  kbRerankBlendWeightSetting,
  kbResultMaxCharsSetting,
  narrativeQueryModeSetting,
  narrativeStartOnLaunchSetting,
  disabledProjectSourcesSetting,
  disabledToolsSetting,
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
  workspaceInstructionFilesSetting,
  themeSetting,
  eventDisplaySetting,
  terminalShellExecutableSetting,
  chatWallpaperSetting,
  settingsWallpaperSetting,
  sandboxNetworkSetting,
] as const;

/**
 * 构造类型化设置入口。定义与组在构造时全量注册，重复 key 启动期 fail-fast。
 * knowledge 的模型绑定设置随 Provider 折叠改为 model_bindings 表，不再是 settings key。
 */
export function openSettings(profileDb: Database): SettingsComposition {
  const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite), {
    definitions: SETTINGS_DEFINITIONS,
    groups: [
      compactGroup,
    ],
  });
  return { settings, wallpaperImages: new WallpaperImages(wallpapersDir()) };
}
