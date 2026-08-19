// 单张角色立绘
export interface CharacterIllustration {
  id: string;
  characterId: string;
  name: string;
  /** 创建时确定、此后不可修改的磁盘文件名。 */
  fileName: string;
  /** 主窗口中的缩放倍率；1 表示原图默认显示大小，有效范围为 0.1～5。 */
  stageScale: number;
  /** 相对舞台中心的水平偏移；-1 为最左侧，0 为居中，1 为最右侧。 */
  stageOffsetX: number;
  /** 相对舞台中心的垂直偏移；-1 为最上方，0 为居中，1 为最下方。 */
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
  fileName: string;
  /** 主窗口中的缩放倍率；不传时使用 1。 */
  stageScale?: number;
  /** 相对舞台中心的水平偏移；有效范围为 -1～1。 */
  stageOffsetX?: number;
  /** 相对舞台中心的垂直偏移；有效范围为 -1～1。 */
  stageOffsetY?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize: number;
}

export interface CharacterIllustrationPatch {
  name?: string;
  /** 主窗口中的缩放倍率；有效范围为 0.1～5。 */
  stageScale?: number;
  /** 相对舞台中心的水平偏移；有效范围为 -1～1。 */
  stageOffsetX?: number;
  /** 相对舞台中心的垂直偏移；有效范围为 -1～1。 */
  stageOffsetY?: number;
  enabled?: boolean;
}

export interface ImportCharacterIllustrationInput {
  sourceFile: string;
  isPrimary?: boolean;
}
