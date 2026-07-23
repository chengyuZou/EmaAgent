// 这是 CharacterCard 包的统一出口，外部代码从这里使用角色卡存储和内置种子。

export { CharacterCardStore } from './store.js';
export type { CardSwitchedListener } from './store.js';
export { EMA_CARD_ID, EMA_CARD_INPUT, BUILTIN_CARDS } from './seed/index.js';

export type {
  CharacterCard,
  CharacterCardInput,
  CharacterVoiceProfile,
  CharacterRefAudio,
} from './types.js';

export { emptyVoiceProfile } from './types.js';
export { buildCharacterPromptSections } from './characterPrompt.js';
export type { CharacterPromptSections } from './characterPrompt.js';
export type { CharacterCardSwitchedEvent, CharacterEvent } from './events.js';
