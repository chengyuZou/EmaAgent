// 统一导出 Agent 运行时、策略、循环状态和依赖接口。
export { AgentEngine } from './engine.js';
export { TurnPolicy } from './policy.js';
export {
  AgentToolCapabilityScope,
  ToolCapabilityRestrictionError,
} from './tool-capability-scope.js';
export { SubagentSpawner } from './spawner.js';
export { AgentRunStore } from './runs/agentRunStore.js';
export type {
  AgentDeps,
  TurnExecutionInput,
} from './types.js';
export type {
  AgentRun,
  AgentRunCompletion,
  AgentRunKind,
  AgentRunStart,
  AgentRunStatus,
  AgentRunStorePort,
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
  AgentLoopEvent,
  AgentRunEvent,
  AgentRuntimeEvent,
  AgentTurnEvent,
  SubagentInnerEvent,
} from './events.js';
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
export { awaitAgentAnswer } from './ask-user-lifecycle.js';
export type { AwaitAgentAnswerInput } from './ask-user-lifecycle.js';
