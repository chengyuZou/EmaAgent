export interface CharacterVoiceSample {
  id: string;
  characterId: string;
  name: string;
  /** 创建时确定、此后不可修改的磁盘文件名。 */
  fileName: string;
  promptText: string;
  promptLang: string;
  isPrimary: boolean;
  enabled: boolean;
  mimeType: string;
  byteSize: number | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterVoiceSampleInput {
  id?: string;
  name: string;
  fileName: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
}

export interface CharacterVoiceSamplePatch {
  name?: string;
  enabled?: boolean;
}

export interface ImportCharacterVoiceSampleInput {
  sourceFile: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
}

export interface PublishCharacterVoiceSampleInput {
  fileName: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
  bytes: Uint8Array;
}
