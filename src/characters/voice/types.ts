/**
 * 单个角色语音样本
 * @param name 语音样本的唯一标识符 落盘时作为文件名使用且不允许修改
 * @param characterName 语音样本所属的角色标识符 对应为 Character.name
 * @param displayName 语音样本的显示名称(或者为外号)
 * @param promptText 语音样本的提示文本 用于生成语音的TTS模型输入
 * @param promptLang 语音样本的提示文本语言
 * @param isPrimary 是否为角色的主要语音样本 主要语音样本会在角色首次发声时使用 且暂时不考虑多语音样本的混合使用
 */
export interface CharacterVoiceSample {
  name: string;
  characterName: string;
  displayName: string;
  promptText: string;
  promptLang: string;
  isPrimary: boolean;
  mimeType: string;
  byteSize: number | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterVoiceSampleInput {
  name: string;
  displayName: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
}

export interface CharacterVoiceSamplePatch { displayName?: string; }

export interface ImportCharacterVoiceSampleInput {
  sourceFile: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
}
