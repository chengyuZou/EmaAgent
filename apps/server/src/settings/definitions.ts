// This entry is also loaded by Desktop. Import definitions, never server startup or file access.
import { AGENT_LIMITS_SETTINGS } from '@ema-agent/agent/settings';
import { attachmentCacheMaxBytesSetting } from '@ema-agent/attachments/settings';
import { MEDIA_SETTINGS } from '@ema-agent/context/settings';
export { maxMediaItemsSetting, maxMediaMiBSetting } from '@ema-agent/context/settings';
import { COMPACT_SETTINGS, compactGroup } from '@ema-agent/compact/settings';
import { PERMISSION_SETTINGS } from '@ema-agent/permission/settings';
import { disabledProjectSourcesSetting, workspaceInstructionFilesSetting } from '@ema-agent/skills/settings';
import { disabledToolsSetting } from '@ema-agent/tools/settings';
import { maxConcurrentBackgroundSetting, maxRuntimeHoursBackgroundSetting } from '@ema-agent/tools/background/settings';
import { sandboxNetworkSetting } from '@ema-agent/sandbox/settings';
import { vishotCaptureEnabledSetting, vishotCaptureIntervalSecondsSetting } from '@ema-agent/vishot-capture/settings';
import { eventDisplaySetting } from './eventDisplaySetting.js';
import { narrativeQueryModeSetting } from './narrativeSetting.js';
import { terminalShellExecutableSetting } from './terminalSetting.js';
import { themeSetting } from './themeSetting.js';
import { wallpaperSetting } from './wallpaperSetting.js';

export type { SettingDefinition } from '@ema-agent/settings/definition';
export { maxIterationsSetting, maxConcurrentSubagentsSetting } from '@ema-agent/agent/settings';
export {
  compactBufferRatioSetting,
  compactKeepRecentToolResultsSetting,
  compactMaximumConsecutiveFailuresSetting,
  compactRetainRatioSetting,
  compactManualMinRatioSetting,
} from '@ema-agent/compact/settings';
export {
  permissionAskTimeoutSetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserDenySetting,
  permissionRulesUserAskSetting,
  permissionRulesProjectAllowSetting,
  permissionRulesProjectDenySetting,
  permissionRulesProjectAskSetting,
} from '@ema-agent/permission/settings';
export { WORKSPACE_INSTRUCTION_FILE_CANDIDATES } from '@ema-agent/skills/settings';
export {
  attachmentCacheMaxBytesSetting,
  disabledProjectSourcesSetting,
  workspaceInstructionFilesSetting,
  disabledToolsSetting,
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
  sandboxNetworkSetting,
  vishotCaptureEnabledSetting,
  vishotCaptureIntervalSecondsSetting,
  eventDisplaySetting,
  narrativeQueryModeSetting,
  terminalShellExecutableSetting,
  themeSetting,
  wallpaperSetting,
};

export const SETTINGS_DEFINITIONS = [
  ...AGENT_LIMITS_SETTINGS,
  ...COMPACT_SETTINGS,
  ...MEDIA_SETTINGS,
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
  vishotCaptureEnabledSetting,
  vishotCaptureIntervalSecondsSetting,
] as const;

export const SETTINGS_GROUPS = [compactGroup];
