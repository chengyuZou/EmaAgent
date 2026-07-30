import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterLive2dVariant } from './live2d/types.js';
import type { CharacterPortrait } from './portraits/types.js';
import type { CharacterVoiceReference } from './voiceReferences/types.js';

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
  live2dVariants:   readonly CharacterLive2dVariant[];
  portraits:        readonly CharacterPortrait[];
  voiceReferences:  readonly CharacterVoiceReference[];
  isActive:         boolean;
  isBuiltin:        boolean;
  createdAt:        number;
  updatedAt:        number;
}

export interface CharacterCardInput {
  name:             string;
  version?:         string;
  /** null = 显式清空(B-055:PATCH 传 null -> storage SET NULL);undefined = 不更新。 */
  description?:     string | null;
  systemPrompt:     string;
  speechPatterns?:  string[];
  forbiddenTopics?: string[];
  emotionVocabulary?: string[];
  motionVocabulary?:  string[];
}
