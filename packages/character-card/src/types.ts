import type { CharacterCardId } from '@ema-agent/contracts';

// ── Voice profile ─────────────────────────────────────────────────────────────
// Defined here (character-card package) rather than contracts because it's a
// character-card domain type. Consumers outside this package import from
// @ema-agent/character-card, not contracts.

export interface CharacterRefAudio {
  id:           string;
  label:        string;
  /** Profile-scoped relative path: <cardId>/<filename> */
  refAudioPath: string;
  promptText:   string;
  promptLang:   string;
}

export interface CharacterVoiceProfile {
  refAudios: CharacterRefAudio[];
  /** Which refAudio is active. null = use first entry. */
  primaryId: string | null;
}

export function emptyVoiceProfile(): CharacterVoiceProfile {
  return { refAudios: [], primaryId: null };
}

export interface CharacterCard {
  id:               CharacterCardId;
  name:             string;
  version:          string;
  description:      string | null;
  systemPrompt:     string;
  speechPatterns:   string[];
  forbiddenTopics:  string[];
  emotionVocabulary: string[];
  motionVocabulary:  string[];
  live2dModelId:    string | null;
  voiceProfile:     CharacterVoiceProfile;
  isActive:         boolean;
  isBuiltin:        boolean;
  createdAt:        number;
  updatedAt:        number;
}

export interface CharacterCardInput {
  name:             string;
  version?:         string;
  description?:     string;
  systemPrompt:     string;
  speechPatterns?:  string[];
  forbiddenTopics?: string[];
  emotionVocabulary?: string[];
  motionVocabulary?:  string[];
  live2dModelId?:   string;
  voiceProfile?:    CharacterVoiceProfile;
}
