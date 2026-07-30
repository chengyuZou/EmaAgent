// 这是 CharacterCard 包的统一出口，外部代码从这里使用角色卡存储和内置种子。

export { CharacterCardStore } from './store.js';
export type { CardSwitchedListener } from './store.js';
export {
  EMA_CARD_ID,
  EMA_CARD_INPUT,
  EMA_LIVE2D_VARIANTS,
  EMA_VOICE_REFERENCES,
  BUILTIN_CARDS,
} from './seed/index.js';
export type { BuiltinCharacterSeed } from './seed/index.js';

export type {
  CharacterCard,
  CharacterCardInput,
} from './types.js';

export type {
  CharacterLive2dFormat,
  CharacterLive2dVariant,
  CharacterLive2dVariantInput,
} from './live2d/types.js';
export type {
  CharacterPortrait,
  CharacterPortraitInput,
  CharacterPortraitMime,
} from './portraits/types.js';
export type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
} from './voiceReferences/types.js';
export { buildCharacterPromptSections } from './characterPrompt.js';
export type { CharacterPromptSections } from './characterPrompt.js';
export type { CharacterCardSwitchedEvent, CharacterEvent } from './events.js';
