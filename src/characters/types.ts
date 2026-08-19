import type { CharacterLive2dModel } from './live2d/types.js';
import type { CharacterIllustration } from './illustration/types.js';
import type { CharacterVoiceSample } from './voice/types.js';

// ── Prompt Block ─────────────────────────────────────────────────────────────

export interface CharacterPromptBlock {
  id: string;
  characterId: string;
  name: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterPromptBlockInput {
  name: string;
  content: string;
  enabled?: boolean;
}

export interface CharacterPromptBlockPatch {
  name?: string;
  content?: string;
  enabled?: boolean;
}

// ── Character ────────────────────────────────────────────────────────────────

export interface Character {
  id: string;
  name: string;
  description: string | null;
  /** 创建时确定、此后不可修改的磁盘目录名。 */
  directoryName: string;
  promptBlocks: readonly CharacterPromptBlock[];
  /** 派生投影：当前主用 Live2D 已提取的词汇。 */
  emotionVocabulary: string[];
  motionVocabulary: string[];
  live2dModels: readonly CharacterLive2dModel[];
  /** 没有可用 Live2D 时，主窗口使用的角色立绘。 */
  illustrations: readonly CharacterIllustration[];
  voiceSamples: readonly CharacterVoiceSample[];
  isActive: boolean;
  isBuiltin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterInput {
  name: string;
  description?: string | null;
  /** 创建必须携带至少一个初始 Block，不产生没有人设的半成品角色。 */
  promptBlocks: readonly CharacterPromptBlockInput[];
}

/** 普通编辑允许修改的字段；目录名、激活状态和内置标记由专用流程管理。 */
export interface CharacterPatch {
  name?: string;
  description?: string | null;
}
