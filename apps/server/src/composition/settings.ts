// 设置一族：SettingsStore 构造时注册全部业务包设置定义与组（原 SettingsCatalog 已并入 Store）。
import { AGENT_LIMITS_SETTINGS, agentLimitsGroup, thinkingEffortSetting } from '@ema-agent/agent';
import {
  attachmentCacheMaxBytesSetting,
  maxFilesPerTurnSetting,
  maxImageBytesSetting,
  maxImagesPerTurnSetting,
} from '@ema-agent/attachments';
import { COMPACT_SETTINGS, compactGroup } from '@ema-agent/compact';
import { CHARACTER_SETTING_DEFINITIONS } from '@ema-agent/characters';
import {
  gitBaselineMaxChangesForUnifiedSetting,
  gitBaselineMaxDiffBytesSetting,
  gitDiffContextLinesSetting,
  gitDiffMaxFilesPerScopeSetting,
  gitDiffMaxFileCharsSetting,
  gitDiffMaxTotalCharsSetting,
  gitDiffMaxUntrackedFilesSetting,
  gitDiffProcessOutputBytesSetting,
  gitDiffUntrackedConcurrencySetting,
  gitMaxOutputBytesSetting,
  gitReadTimeoutMsSetting,
  gitWriteTimeoutMsSetting,
} from '@ema-agent/git';
import {
  kbAlphaSetting,
  kbDefaultTopKSetting,
  kbRerankBlendWeightSetting,
  kbResultMaxCharsSetting,
} from '@ema-agent/knowledge';
import {
  narrativeBridgeEnabledSetting,
  narrativeQueryModeSetting,
} from '@ema-agent/narrative';
import { PERMISSION_SETTINGS } from '@ema-agent/permission';
import {
  MEMORY_SETTINGS,
  memoryBudgetsGroup,
  memoryJobsGroup,
  memoryLifecycleGroup,
} from '@ema-agent/memory';
import { SettingsStore } from '@ema-agent/settings';
import {
  speechSegmentMaxBytesSetting,
  speechSegmentMaxFilesSetting,
} from '@ema-agent/speech';
import {
  builtinSkillsEnabledSetting,
  disabledProjectSourcesSetting,
  disabledSkillKeysSetting,
} from '@ema-agent/skills';
import { SettingsRepo, type Database } from '@ema-agent/storage';
import {
  disabledToolsSetting,
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
} from '@ema-agent/tools';
import { workspaceInstructionFilesSetting } from '@ema-agent/turn';
import { eventDisplaySetting } from './settings/eventDisplaySetting.js';
import { terminalShellExecutableSetting } from './settings/terminalSetting.js';
import { themeSetting } from './settings/themeSetting.js';

export interface SettingsComposition {
  readonly settings: SettingsStore;
}

/**
 * 构造类型化设置入口。定义与组在构造时全量注册，重复 key 启动期 fail-fast。
 * knowledge 的模型绑定设置随 Provider 折叠改为 model_bindings 表，不再是 settings key。
 */
export function openSettings(profileDb: Database): SettingsComposition {
  const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite), {
    definitions: [
      ...AGENT_LIMITS_SETTINGS,
      thinkingEffortSetting,
      ...COMPACT_SETTINGS,
      ...CHARACTER_SETTING_DEFINITIONS,
      ...MEMORY_SETTINGS,
      ...PERMISSION_SETTINGS,
      attachmentCacheMaxBytesSetting,
      maxFilesPerTurnSetting,
      maxImageBytesSetting,
      maxImagesPerTurnSetting,
      kbAlphaSetting,
      kbDefaultTopKSetting,
      kbRerankBlendWeightSetting,
      kbResultMaxCharsSetting,
      narrativeBridgeEnabledSetting,
      narrativeQueryModeSetting,
      builtinSkillsEnabledSetting,
      disabledProjectSourcesSetting,
      disabledSkillKeysSetting,
      disabledToolsSetting,
      speechSegmentMaxFilesSetting,
      speechSegmentMaxBytesSetting,
      maxConcurrentBackgroundSetting,
      maxRuntimeHoursBackgroundSetting,
      workspaceInstructionFilesSetting,
      gitReadTimeoutMsSetting,
      gitWriteTimeoutMsSetting,
      gitMaxOutputBytesSetting,
      gitDiffContextLinesSetting,
      gitDiffMaxFileCharsSetting,
      gitDiffMaxTotalCharsSetting,
      gitDiffMaxFilesPerScopeSetting,
      gitDiffMaxUntrackedFilesSetting,
      gitDiffUntrackedConcurrencySetting,
      gitDiffProcessOutputBytesSetting,
      gitBaselineMaxDiffBytesSetting,
      gitBaselineMaxChangesForUnifiedSetting,
      themeSetting,
      eventDisplaySetting,
      terminalShellExecutableSetting,
    ],
    groups: [
      agentLimitsGroup,
      compactGroup,
      memoryLifecycleGroup,
      memoryBudgetsGroup,
      memoryJobsGroup,
    ],
  });
  return { settings };
}
