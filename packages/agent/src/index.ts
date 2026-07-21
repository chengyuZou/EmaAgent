// 统一导出 Agent 运行时、策略、循环状态和依赖接口。
export { AgentEngine } from './engine.js';
export { AgentPolicy } from './policy.js';
export {
  AgentToolCapabilityScope,
  ToolCapabilityRestrictionError,
} from './tool-capability-scope.js';
export { SubagentSpawner } from './spawner.js';
export type {
  AgentDeps,
  AgentRunInput,
  IAgentTaskStore,
  IAgentTurnLifecycle,
  IToolExecutionJournal,
} from './types.js';
export type { AgentLoopEvent, ExecutorFactory, AgentLoopInput } from './loop.js';
export type { LoopState, LoopPhase, LoopTransition } from './loop-state.js';
export {
  AgentBudgetExceededError,
  DEFAULT_TURN_BUDGET_LIMITS,
  TurnBudget,
} from './turn-budget.js';
export type { TurnBudgetDimension, TurnBudgetLimits } from './turn-budget.js';
export { awaitAgentAnswer } from './ask-user-lifecycle.js';
export type { AwaitAgentAnswerInput } from './ask-user-lifecycle.js';
