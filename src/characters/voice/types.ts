
export interface CharacterVoiceSample {
  name: string;
  characterName: string;
  displayName: string;
  /** 参考音频中实际说出的内容, 不是待合成的回复. */
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

export interface CharacterVoiceSamplePatch {
  displayName?: string;
  promptText?: string;
  promptLang?: string;
}

export interface ImportCharacterVoiceSampleInput {
  sourceFile: string;
  promptText: string;
  promptLang: string;
}
