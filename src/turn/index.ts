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
  SessionBusyError,
} from './errors.js';
export type { TurnFailureCode, TurnFailurePhase } from './errors.js';
export { SessionInteractionQueue } from './interactionQueue.js';
export type { PendingInteraction } from './interactionQueue.js';
export {
  WORKSPACE_INSTRUCTION_FILE_CANDIDATES,
  workspaceInstructionFilesSetting,
} from './settings.js';
export { TurnExecutor, TurnReminderScope } from './turn.js';
export { renderTurnReminder } from './preparation/turnReminder.js';
export type {
  RenderTurnReminderInput,
  TurnReminderFacts,
} from './preparation/turnReminder.js';
