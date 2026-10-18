
export interface CharacterIllustration {
  name: string;
  characterName: string;
  displayName: string;
  /** null 表示普通立绘, 不加入任何情绪候选组. */
  expression: string | null;
  stageScale: number;
  stageOffsetX: number;
  stageOffsetY: number;
  isPrimary: boolean;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterIllustrationInput {
  name: string;
  displayName: string;
  expression?: string | null;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  isPrimary?: boolean;
  byteSize: number;
}

export interface CharacterIllustrationPatch {
  displayName?: string;
  expression?: string | null;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
}

export interface ImportCharacterIllustrationInput {
  sourceFile: string;
  expression?: string | null;
}
