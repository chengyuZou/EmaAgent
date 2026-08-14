import type {
  CharacterCardId,
  CharacterLive2dId,
} from '@ema-agent/ids';

export interface CharacterLive2dVariant {
  id: CharacterLive2dId;
  characterCardId: CharacterCardId;
  name: string;
  /** 主窗口中的缩放比例与归一化偏移，不修改模型源文件。 */
  stageScale: number;
  stageOffsetX: number;
  stageOffsetY: number;
  isPrimary: boolean;
  enabled: boolean;
  byteSize: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dVariantInput {
  id?: CharacterLive2dId;
  name: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize?: number | null;
}

export interface CharacterLive2dVariantPatch {
  name?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  enabled?: boolean;
}

export interface ImportCharacterLive2dInput {
  sourceDirectory: string;
  name: string;
  isPrimary?: boolean;
}
