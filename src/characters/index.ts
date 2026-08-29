// 这是 Character 包的统一出口，外部代码从这里使用角色存储和内置种子。

export { CharacterStore } from './store.js';
export type {
  CharacterSwitchedListener,
  CharacterPresentationChangedListener,
} from './store.js';
export {
  EMA_CHARACTER_ID,
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
} from './types.js';

export type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
  ImportCharacterLive2dModelInput,
  Live2dExpression,
  Live2dMotion,
  Live2dRuntimeConfig,
} from './live2d/types.js';
export type {
  CharacterIllustration,
  CharacterIllustrationInput,
  CharacterIllustrationPatch,
  ImportCharacterIllustrationInput,
} from './illustration/types.js';
export type {
  CharacterVoiceSample,
  CharacterVoiceSampleInput,
  CharacterVoiceSamplePatch,
  ImportCharacterVoiceSampleInput,
  PublishCharacterVoiceSampleInput,
} from './voice/types.js';
export {
  assertPersonaPrompt,
  buildCharacterPrompt,
  buildLive2dControlPrompt,
} from './characterPrompt.js';
export {
  CHARACTER_SETTING_DEFINITIONS,
  readCharacterSettings,
  characterVoiceMaxBytesSetting,
  characterVoiceMaxDurationMsSetting,
} from './settings.js';
export type { CharacterSettings } from './settings.js';
export type {
  CharacterSwitchedEvent,
  CharacterEvent,
  CharacterPresentationChangedEvent,
} from './events.js';
export {
  CharacterActiveDeleteError,
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterPromptInvalidError,
  CharacterReadOnlyError,
  CharacterResourceMissingError,
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
export type {
  CharacterHealth,
  CharacterHealthReport,
  CharacterHealthIssue,
  CharacterHealthIssueCode,
  CharacterHealthIssueSeverity,
  CharacterHealthStatus,
  CharacterPresentation,
} from './characterHealth.js';
export { inspectAllCharacterHealth, inspectCharacterHealth } from './characterHealth.js';
