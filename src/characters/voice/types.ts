export interface CharacterVoiceReference {
  id: string;
  characterCardId: string;
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
  id?: string;
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
