// 暴露 Turn 请求、生命周期统计、TurnStore 与 Turn 自有事件。
// 领域词汇来自 @ema-agent/turn-terms（唯一事实源），此处仅表面组合。
export * from '@ema-agent/turn-terms';
export * from './events.js';
export * from './types.js';
export { TurnStore } from './turnStore.js';
export type { TurnStoreDeps } from './turnStore.js';
export { ActiveTurnRegistry } from './activeTurnRegistry.js';
export {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from './eventChannel.js';
export {
  TurnOwnershipError,
  ActiveTurnAlreadyRegisteredError,
  TurnPreparationError,
} from './errors.js';
export type { TurnFailureCode, TurnFailurePhase } from './errors.js';
export {
  SessionDecisionQueue,
  filterPermissionPending,
  filterAskUserPending,
} from './interaction/decisionQueue.js';
export type {
  SessionInteraction,
  PermissionInteraction,
  AskUserInteraction,
  AskUserInteractionOutcome,
  PendingInteraction,
} from './interaction/decisionQueue.js';
