import type {
  LanguageModel,
  LlmRequest,
  LlmTokenUsage,
  Message,
} from '@ema-agent/llm';
import type {
  StreamingToolExecutor,
} from '@ema-agent/tools';

export interface PrepareAgentIterationInput {
  readonly history: readonly Message[];
  readonly currentMessages: readonly Message[];
  /** Agent 只报告重试原因，是否 Compact 由 Turn 的实现决定。 */
  readonly recoveryReason?: 'context_window_exceeded';
}

export interface PreparedAgentIteration {
  readonly request: LlmRequest;
  /** Compact 可能改写工作历史；后续调用必须继续使用这里返回的版本。 */
  readonly history: readonly Message[];
}

export type PrepareAgentIteration = (
  input: PrepareAgentIterationInput,
) => Promise<PreparedAgentIteration>;

/** 根 Turn 与其全部子 Agent 共用同一个实现，Agent 只消费额度，不拥有规则。 */
export interface AgentBudget {
  assertWithinLimits(): void;
  remainingOutputTokens(): number;
  recordUsage(usage: LlmTokenUsage): void;
  reserveToolCall(): void;
  enterSubagent(): () => void;
}

/** Tool 进度和审批事件由创建执行器的 Turn 直接接收，不能绕进 Agent 事件。 */
export type ToolExecutorFactory = (
  wake: () => void,
) => StreamingToolExecutor;

export interface AgentLoopInput {
  readonly history: readonly Message[];
  readonly currentMessages: readonly Message[];
  readonly prepareIteration: PrepareAgentIteration;
  readonly llm: LanguageModel;
  readonly createToolExecutor: ToolExecutorFactory;
  readonly budget: AgentBudget;
  readonly signal: AbortSignal;
  readonly maxIterations: number;
}
