import type { CharacterCardId } from '@ema-agent/contracts';

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
}
