// ── Component ────────────────────────────────────────────────────────────────

export { Live2DStage } from './components/Live2DStage.js';
export type { Live2DStageProps } from './components/Live2DStage.js';
export {
  Live2DRuntimeProvider,
  useLive2DRuntime,
} from './components/Live2DRuntimeProvider.js';
export type { Live2DRuntimeProviderProps } from './components/Live2DRuntimeProvider.js';
export {
  createLive2DRuntime,
  defaultLive2DRuntime,
} from './runtime.js';
export type { Live2DRuntime } from './runtime.js';

// ── Stores ───────────────────────────────────────────────────────────────────

export { createLive2DStore, useLive2DStore } from './stores/live2d-store.js';
export { createExpressionStore, useExpressionStore } from './stores/expression-store.js';
export { createSpeechAnimationStore, useSpeechStore } from './stores/speech-store.js';
export type {
  SpeechAnimationState,
  SpeechAnimationActions,
  SpeechAnimationStore,
  SpeechAnimationStoreApi,
} from './stores/speech-store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  Live2DFraming,
  Live2DErrorKind,
  Live2DErrorPhase,
  Live2DError,
  Live2DStageHandle,
} from './types.js';

export type {
  Live2DStoreState,
  Live2DStoreActions,
  ModelParameters,
  ActiveExpressionIntent,
  ExpressionIntentOptions,
  ExpressionIntentSource,
  Live2DStoreApi,
} from './stores/live2d-store.js';

export type { ExpressionStoreApi } from './stores/expression-store.js';

export type {
  Live2DModelRuntimeConfig,
  ResolvedLive2DModelRuntimeConfig,
  Live2DStageTarget,
  Live2DMotionTarget,
  Live2DParameterRuntimeConfig,
} from './model-config.js';

export {
  DEFAULT_LIVE2D_RUNTIME_CONFIG,
  resolveLive2DModelRuntimeConfig,
} from './model-config.js';
