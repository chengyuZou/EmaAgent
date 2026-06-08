// ── Component ────────────────────────────────────────────────────────────────

export { Live2DStage } from './components/Live2DStage.js';

// ── Stores ───────────────────────────────────────────────────────────────────

export { useLive2DStore } from './stores/live2d-store.js';
export { useExpressionStore } from './stores/expression-store.js';
export { useSpeechStore } from './stores/speech-store.js';
export type { SpeechAnimationState, SpeechAnimationActions, SpeechAnimationStore } from './stores/speech-store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  Live2DFraming,
  Live2DErrorKind,
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
} from './stores/live2d-store.js';

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
