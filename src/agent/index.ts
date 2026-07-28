// 统一导出 Agent 循环、策略、预算和子 Agent 执行能力。
export { TurnPolicy } from './policy.js';
export {
  AgentToolCapabilityScope,
  ToolCapabilityRestrictionError,
} from './tool-capability-scope.js';
export { SubagentSpawner } from './spawner.js';
export type { SubagentSpawnerDeps } from './spawner.js';
export { createToolLifecycleHooks } from './toolLifecycleHooks.js';
export { AgentRunStore } from './runs/agentRunStore.js';
export { AgentRunTranscriptProjection } from './runs/agentRunTranscriptProjection.js';
export { AgentRunTranscriptStore } from './runs/agentRunTranscriptStore.js';
export type {
  AgentRunTranscriptWarning,
} from './runs/agentRunTranscriptProjection.js';
export type {
  AgentRun,
  AgentRunCompletion,
  AgentRunKind,
  AgentRunStart,
  AgentRunStatus,
  AgentRunStorePort,
  AgentRunTranscriptAppend,
  AgentRunTranscriptMessage,
  AgentRunTranscriptReader,
  AgentRunTranscriptRole,
  AgentRunTranscriptWriter,
  AgentRunTransitionAction,
  AgentRunTransitionResult,
} from './runs/types.js';
export { runAgentLoop } from './agentLoop.js';
export type {
  AgentLoopInput,
  AgentLoopOutcome,
  ExecutorFactory,
} from './agentLoop.js';
export type {
  AgentKind,
  AgentExecutionEvent,
  AgentLoopEvent,
  AgentRunEvent,
  AgentTurnEvent,
  SubagentInnerEvent,
} from './events.js';
export { isAgentRunEvent } from './events.js';
export type {
  AgentLoopPhase,
  AgentLoopState,
  AgentLoopTransition,
} from './agentLoopState.js';
export {
  AgentBudgetExceededError,
  DEFAULT_TURN_BUDGET_LIMITS,
  TurnBudget,
} from './turn-budget.js';
export type { TurnBudgetDimension, TurnBudgetLimits } from './turn-budget.js';
export { buildScratchpadContext } from './scratchpad-context.js';
