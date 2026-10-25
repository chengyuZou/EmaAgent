import type { CharacterLive2dModel, Live2dMappings } from './live2d/types.js';
import type { CharacterIllustration } from './illustration/types.js';
import type { CharacterVoiceSample } from './voice/types.js';


export type CharacterStageKind = 'live2d' | 'illustration' | 'blank';


export interface Character {
  /** 创建后不变, 同时用于 SQL 身份, 资源目录和 Relationship Memory 目录. */
  name: string;
  /** null 时显示 name, 修改显示名不移动资源. */
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

export interface CharacterSummary {
  name: string;
  displayName: string | null;
  description: string | null;
  stageKind: CharacterStageKind;
  isActive: boolean;
  updatedAt: number;
  live2dCount: number;
  illustrationCount: number;
  voiceSampleCount: number;
  coverResourceName: string | null;
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
  readonly stageScale: number;
  readonly stageOffsetX: number;
  readonly stageOffsetY: number;
}

export interface CharacterLive2dStageEntry extends CharacterStageEntryBase, Live2dMappings {
  readonly kind: 'live2d';
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
      /** key 对应 <emotion> 中的名称, 消费方从同组候选图中选择一张. */
      readonly expressions: Readonly<Record<string, readonly CharacterIllustrationStageEntry[]>>;
    }
  | {
      readonly status: 'unavailable';
      readonly characterName: string;
      readonly stageKind: 'live2d' | 'illustration';
      readonly reason: 'primary_resource_missing' | 'resource_file_missing' | 'resource_invalid';
    };
