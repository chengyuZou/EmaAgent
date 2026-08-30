import type { CharacterLive2dModel, Live2dRuntimeConfig } from './live2d/types.js';
import type { CharacterIllustration } from './illustration/types.js';
import type { CharacterVoiceSample } from './voice/types.js';

// ── Character ────────────────────────────────────────────────────────────────

export interface Character {
  id: string;
  name: string;
  description: string | null;
  /** 创建时确定、此后不可修改的磁盘目录名。 */
  directoryName: string;
  /** 人设提示词正文；角色人设的唯一事实源。 */
  personaPrompt: string;
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
  /** 人设提示词正文；创建必须携带，不产生没有人设的半成品角色。 */
  personaPrompt: string;
}

/** 普通编辑允许修改的字段；目录名、激活状态和内置标记由专用流程管理。 */
export interface CharacterPatch {
  name?: string;
  description?: string | null;
  personaPrompt?: string;
}

// ── 主窗口舞台视图 ────────────────────────────────────────────────────────────

/** 舞台候选的公共渲染字段；file 是服务端解析后的绝对路径，updatedAt 供前端做候选去重。 */
interface CharacterStageEntryBase {
  readonly resourceId: string;
  readonly name: string;
  readonly file: string;
  readonly stageScale: number;
  readonly stageOffsetX: number;
  readonly stageOffsetY: number;
  readonly updatedAt: number;
}

export interface CharacterLive2dStageEntry extends CharacterStageEntryBase {
  readonly kind: 'live2d';
  readonly runtimeConfig: Live2dRuntimeConfig | null;
}

export interface CharacterIllustrationStageEntry extends CharacterStageEntryBase {
  readonly kind: 'illustration';
}

export type CharacterStageEntry =
  | CharacterLive2dStageEntry
  | CharacterIllustrationStageEntry;

/**
 * 主窗口一次渲染所需的完整视图。candidates 按降级链排序（Live2D → 立绘），
 * 空数组即占位；消费方不需要第二次请求或自行拼接资源字段。
 */
export interface CharacterStagePresentation {
  readonly characterId: string;
  readonly candidates: readonly CharacterStageEntry[];
}
