// 聚合单个 Live2D 舞台拥有的动作、表情与语音状态。
import {
  createLive2DStore,
  useLive2DStore,
  type Live2DStoreApi,
} from './stores/live2d-store.js';
import {
  createExpressionStore,
  useExpressionStore,
  type ExpressionStoreApi,
} from './stores/expression-store.js';
import {
  createSpeechAnimationStore,
  useSpeechStore,
  type SpeechAnimationStoreApi,
} from './stores/speech-store.js';

export interface Live2DRuntime {
  readonly stageId: string;
  readonly live2dStore: Live2DStoreApi;
  readonly expressionStore: ExpressionStoreApi;
  readonly speechStore: SpeechAnimationStoreApi;
  reset(): void;
}

export function createLive2DRuntime(stageId: string): Live2DRuntime {
  const normalizedStageId = stageId.trim();
  if (!normalizedStageId) {
    throw new Error('Live2D runtime requires a non-empty stageId');
  }

  const live2dStore = createLive2DStore();
  const expressionStore = createExpressionStore();
  const speechStore = createSpeechAnimationStore();

  return createRuntime(normalizedStageId, live2dStore, expressionStore, speechStore);
}

function createRuntime(
  stageId: string,
  live2dStore: Live2DStoreApi,
  expressionStore: ExpressionStoreApi,
  speechStore: SpeechAnimationStoreApi,
): Live2DRuntime {
  return {
    stageId,
    live2dStore,
    expressionStore,
    speechStore,
    reset() {
      live2dStore.getState().reset();
      expressionStore.getState().dispose();
      speechStore.getState().reset();
    },
  };
}

export const defaultLive2DRuntime = createRuntime(
  'main',
  useLive2DStore,
  useExpressionStore,
  useSpeechStore,
);
