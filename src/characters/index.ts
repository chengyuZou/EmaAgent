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
  CharacterLive2dVariantPatch,
  ImportCharacterLive2dInput,
} from './live2d/types.js';
export type {
  CharacterPortrait,
  CharacterPortraitInput,
  CharacterPortraitMime,
  CharacterPortraitPatch,
  ImportCharacterPortraitInput,
} from './portraits/types.js';
export type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
  CharacterVoiceReferencePatch,
  ImportCharacterVoiceReferenceInput,
} from './voiceReferences/types.js';
export { buildCharacterPrompt} from './characterPrompt.js';
export type { CharacterPrompt } from './characterPrompt.js';
export type {
  CharacterCardSwitchedEvent,
  CharacterEvent,
  CharacterPresentationChangedEvent,
} from './events.js';
export {
  CharacterPromptInvalidError,
  CharacterResourcePathError,
  CharacterResourceValidationError,
} from './errors.js';
export type {
  CharacterResourceKind,
  CharacterResourceRoots,
} from './resources/characterResourcePaths.js';
export type {
  CharacterResourceOperation,
  CharacterResourceOperationContext,
  CharacterResourceOperationKind,
  CharacterResourceOperationStage,
} from './resources/characterResourceOperations.js';
export type {
  CharacterResourceRecoveryReport,
} from './resources/characterResourceRecovery.js';
export type {
  CharacterHealth,
  CharacterHealthIssue,
  CharacterHealthIssueCode,
  CharacterHealthIssueSeverity,
  CharacterHealthStatus,
  CharacterPresentation,
  CharacterPresentationCandidate,
} from './validation/characterValidator.js';
