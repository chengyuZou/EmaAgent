import type { CharacterLive2dModel, Live2dRuntimeConfig } from './live2d/types.js';
import type { CharacterIllustration } from './illustration/types.js';
import type { CharacterVoiceSample } from './voice/types.js';

/**
 * CharacterStageKind 表示角色舞台呈现的类型 可能是 live2d illustration(立绘) 或 blank(空白不显示)
 */
export type CharacterStageKind = 'live2d' | 'illustration' | 'blank';

/**
 * Character 表示一个角色的完整信息 包括其基本属性 舞台呈现类型 相关资源(Live2D 模型 立绘 语音样本)以及状态信息
 * @param name 角色的唯一标识符 落盘时作为目录名使用且不允许修改 需要角色全名
 * @param displayName 角色的显示名称(或者为外号)
 */
export interface Character {
  name: string;
  displayName: string | null;
  description: string | null;
  personaPrompt: string;
  stageKind: CharacterStageKind;
  live2dModels: readonly CharacterLive2dModel[];
  illustrations: readonly CharacterIllustration[];
  voiceSamples: readonly CharacterVoiceSample[];
  isActive: boolean;
  lastActivatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterInput {
  name: string;
  displayName?: string | null;
  description?: string | null;
  personaPrompt: string;
}

export interface CharacterPatch {
  displayName?: string | null;
  description?: string | null;
  personaPrompt?: string;
  stageKind?: CharacterStageKind;
}

interface CharacterStageEntryBase {
  readonly name: string;
  readonly displayName: string;
  readonly file: string;
  readonly stageScale: number;
  readonly stageOffsetX: number;
  readonly stageOffsetY: number;
}

export interface CharacterLive2dStageEntry extends CharacterStageEntryBase {
  readonly kind: 'live2d';
  readonly runtimeConfig: Live2dRuntimeConfig | null;
}

export interface CharacterIllustrationStageEntry extends CharacterStageEntryBase {
  readonly kind: 'illustration';
}

export type CharacterStagePresentation =
  | { readonly status: 'blank'; readonly characterName: string }
  | { readonly status: 'live2d'; readonly characterName: string; readonly resource: CharacterLive2dStageEntry }
  | {
      readonly status: 'illustration';
      readonly characterName: string;
      readonly resource: CharacterIllustrationStageEntry;
      /**
       * 立绘的表情映射表 其中 key 为表情名称
       * value 为该表情对应的立绘资源列表(可能有多个)
       * LLM会生成类似于<emotion>name</emotion>的标签来指定角色的表情
       * 这些立绘资源会在舞台上随机切换以达到类似于表情动画(galgame演出)的效果
       */
      readonly expressions: Readonly<Record<string, readonly CharacterIllustrationStageEntry[]>>;
    }
  | {
      readonly status: 'unavailable';
      readonly characterName: string;
      readonly stageKind: 'live2d' | 'illustration';
      readonly reason: 'primary_resource_missing' | 'resource_file_missing' | 'resource_invalid';
    };
