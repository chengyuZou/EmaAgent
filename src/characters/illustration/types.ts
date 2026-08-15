// 单张角色立绘
export interface CharacterIllustration {
  id: string;
  characterCardId: string;
  name: string;
  /** 主窗口中的缩放比例与归一化偏移，原图字节保持不变。 */
  stageScale: number;
  stageOffsetX: number;
  stageOffsetY: number;
  isPrimary: boolean;
  enabled: boolean;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterIllustrationInput {
  id?: string;
  name: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize: number;
}

export interface CharacterIllustrationPatch {
  name?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  enabled?: boolean;
}

export interface ImportCharacterIllustrationInput {
  sourceFile: string;
  name: string;
  isPrimary?: boolean;
}
