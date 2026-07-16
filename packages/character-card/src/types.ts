// 这里放角色卡的基础类型：角色卡、卡输入、语音档案。

import type { CharacterCardId } from '@ema-agent/contracts';

// ── 语音档案 ───────────────────────────────────────────────────────────────────
// 定义在这里（character-card 包）而不是 contracts，因为它是 character-card 的
// 领域类型。包外消费者从 @ema-agent/character-card 导入，不从 contracts。

export interface CharacterRefAudio {
  id:           string;
  label:        string;
  /** 档案内相对路径：<cardId>/<filename> */
  refAudioPath: string;
  promptText:   string;
  promptLang:   string;
}

export interface CharacterVoiceProfile {
  refAudios: CharacterRefAudio[];
  /** 当前激活的 refAudio。null = 用第一条。 */
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
  /** null = 显式清空(B-055:PATCH 传 null -> storage SET NULL);undefined = 不更新。 */
  description?:     string | null;
  systemPrompt:     string;
  speechPatterns?:  string[];
  forbiddenTopics?: string[];
  emotionVocabulary?: string[];
  motionVocabulary?:  string[];
  /** null = 显式清空(B-055)。 */
  live2dModelId?:   string | null;
  voiceProfile?:    CharacterVoiceProfile;
}
