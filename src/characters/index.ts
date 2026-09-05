// 这是 Character 包的统一出口，外部代码从这里使用角色存储和内置种子。

export { CharacterStore } from './store.js';
export type {
  CharacterSwitchedListener,
  CharacterPresentationChangedListener,
} from './store.js';
export {
  EMA_CHARACTER_NAME,
  EMA_CHARACTER_INPUT,
  EMA_LIVE2D_MODELS,
  EMA_VOICE_SAMPLES,
  BUILTIN_CHARACTERS,
  installBuiltinCharacterResources,
} from './seed/index.js';
export type { BuiltinCharacterSeed } from './seed/index.js';

export type {
  Character,
  CharacterInput,
  CharacterPatch,
  CharacterStageKind,
  CharacterIllustrationStageEntry,
  CharacterLive2dStageEntry,
  CharacterStagePresentation,
} from './types.js';

export type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
  ImportCharacterLive2dModelInput,
  Live2dExpression,
  Live2dMotion,
  Live2dRuntimeConfig,
  Live2dConfiguration,
  Live2dMappings,
  Live2dNativeMotion,
} from './live2d/types.js';
export type {
  CharacterIllustration,
  CharacterIllustrationInput,
  CharacterIllustrationPatch,
  ImportCharacterIllustrationInput,
} from './illustration/types.js';
export { ILLUSTRATION_EXPRESSION_POOL_MAX } from './illustration/limits.js';
export type {
  CharacterVoiceSample,
  CharacterVoiceSampleInput,
  CharacterVoiceSamplePatch,
  ImportCharacterVoiceSampleInput,
} from './voice/types.js';
export {
  assertPersonaPrompt,
  buildCharacterPrompt,
  buildStageControlPrompt,
  characterStageVocabulary,
} from './characterPrompt.js';
export type {
  CharacterSwitchedEvent,
  CharacterEvent,
  CharacterPresentationChangedEvent,
} from './events.js';
export {
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterPromptInvalidError,
  CharacterResourceNotFoundError,
  CharacterResourcePathError,
  CharacterResourceValidationError,
  CharacterStateInvalidError,
} from './errors.js';
export type {
  CharacterInputInvalidReason,
  CharacterResourceKind,
  CharacterResourceValidationCode,
  CharacterStateInvalidReason,
} from './errors.js';
