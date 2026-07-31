import type {
  CharacterCardId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';

export interface CharacterVoiceReference {
  id: CharacterVoiceReferenceId;
  characterCardId: CharacterCardId;
  label: string;
  /** 角色资源根目录内的参考音频相对路径。 */
  relativePath: string;
  promptText: string;
  promptLang: string;
  position: number;
  isPrimary: boolean;
  enabled: boolean;
  mimeType: string;
  byteSize: number | null;
  durationMs: number | null;
  contentSha256: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterVoiceReferenceInput {
  id?: CharacterVoiceReferenceId;
  label: string;
  relativePath: string;
  promptText: string;
  promptLang: string;
  position?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
  contentSha256?: string | null;
}

export interface ImportCharacterVoiceReferenceInput {
  sourceFile: string;
  label: string;
  promptText: string;
  promptLang: string;
  position?: number;
  isPrimary?: boolean;
}
