import type {
  CharacterCardId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';

export interface CharacterVoiceReference {
  id: CharacterVoiceReferenceId;
  characterCardId: CharacterCardId;
  name: string;
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

export interface CharacterVoiceReferenceInput {
  id?: CharacterVoiceReferenceId;
  name: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
}

export interface CharacterVoiceReferencePatch {
  name?: string;
  enabled?: boolean;
}

export interface ImportCharacterVoiceReferenceInput {
  sourceFile: string;
  name: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
}
