import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterLive2dVariant } from './live2d/types.js';
import type { CharacterIllustration } from './illustration/types.js';
import type { CharacterVoiceReference } from './voice/types.js';

export interface CharacterCard {
  id:               CharacterCardId;
  name:             string;
  description:      string | null;
  systemPrompt:     string;
  emotionVocabulary: string[];
  motionVocabulary:  string[];
  live2dVariants:   readonly CharacterLive2dVariant[];
  /** 没有可用 Live2D 时，主窗口使用的角色立绘。 */
  illustrations:    readonly CharacterIllustration[];
  voiceReferences:  readonly CharacterVoiceReference[];
  isActive:         boolean;
  isBuiltin:        boolean;
  createdAt:        number;
  updatedAt:        number;
}

export interface CharacterCardInput {
  name:             string;
  description?:     string | null;
  systemPrompt:     string;
}
