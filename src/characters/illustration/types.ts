/**
 * 单张角色立绘
 * @param name 立绘的唯一标识符 落盘时作为文件名使用且不允许修改
 * @param characterName 立绘所属的角色标识符 对应为 Character.name
 * @param displayName 立绘的显示名称(或者为外号)
 * @param expression 立绘的表情名称 可为 null 表示无表情
 * @param stageScale 立绘在舞台上的缩放比例
 * @param stageOffsetX 立绘在舞台上的水平偏移量比例
 * @param stageOffsetY 立绘在舞台上的垂直偏移量比例
 */
export interface CharacterIllustration {
  name: string;
  characterName: string;
  displayName: string;
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
  isPrimary?: boolean;
}
