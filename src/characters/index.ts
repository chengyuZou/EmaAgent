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
  CharacterPromptBlock,
  CharacterPromptBlockInput,
  CharacterPromptBlockPatch,
} from './types.js';

export type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
  ImportCharacterLive2dModelInput,
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
  assertCharacterPromptBlocks,
  buildCharacterPrompt,
  buildLive2dControlPrompt,
  normalizePromptBlock,
  validateCharacterPromptLimits,
} from './characterPrompt.js';
export type { CharacterPromptLimitIssue } from './characterPrompt.js';
export {
  CHARACTER_SETTING_DEFINITIONS,
  CHARACTER_PROMPT_LIMITS_GROUP,
  characterPromptLimitsGroup,
  readCharacterSettings,
  characterPromptMaxBlocksSetting,
  characterPromptMaxBlockNameCharsSetting,
  characterPromptMaxBlockCharsSetting,
  characterPromptMaxTotalCharsSetting,
  characterLive2dMaxRuntimeConfigBytesSetting,
  characterLive2dMaxZipEntriesSetting,
  characterLive2dMaxZipTotalBytesSetting,
  characterIllustrationMaxBytesSetting,
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
  CharacterPresentationCandidate,
} from './characterHealth.js';
export { inspectAllCharacterHealth, inspectCharacterHealth } from './characterHealth.js';
