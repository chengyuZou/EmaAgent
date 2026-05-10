import type { CharacterCardId, ModelId } from '@ema-agent/contracts';

export type ModuleKey =
  | 'chat'
  | 'narrative'
  | 'agent'
  | 'emotion'
  | 'compaction'
  | 'tts'
  | 'stt'
  | 'vision'
  | 'imagegen';

export interface TtsBinding  { providerId: string; voiceId: string }
export interface SttBinding  { providerId: string }

export type ResolvedBinding =
  | { kind: 'model';   modelId: ModelId }
  | { kind: 'tts';     tts: TtsBinding }
  | { kind: 'stt';     stt: SttBinding }
  | { kind: 'none' }; // no binding configured for this module

export interface ModuleBindings {
  chat?:       ModelId;
  narrative?:  ModelId;
  agent?:      ModelId;
  emotion?:    ModelId;
  compaction?: ModelId;
  tts?:        TtsBinding;
  stt?:        SttBinding;
  vision?:     ModelId;
  imagegen?:   ModelId;
}

/** Domain model — all JSON columns parsed, snake_case mapped to camelCase. */
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
  moduleBindings:   ModuleBindings;
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
  moduleBindings?:  ModuleBindings;
  live2dModelId?:   string;
}
