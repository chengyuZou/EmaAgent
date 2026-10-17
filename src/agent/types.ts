import type {
  CallLLM,
  LLMGenerationSource,
  LLMRequest,
  Message,
} from '@ema-agent/llm';
import type {
  StreamingToolExecutor,
} from '@ema-agent/tools';

export interface PrepareAgentIterationInput {
  /** 即将执行的物理 Provider 请求身份; 恢复重试与输出重试都使用新 ID */
  readonly llmCallId: string;
  /** 当前工作历史全文; 实现可以返回被 Compact 改写的版本, 循环整体替换继续使用. */
  readonly messages: readonly Message[];
  /** Agent 只报告重试原因, 是否 Compact 由 Turn 的实现决定. */
  readonly recoveryReason?: 'context_window_exceeded';
}

export interface PreparedAgentIteration {
  readonly request: LLMRequest;
  /** Compact 可能改写工作历史; 后续调用必须继续使用这里返回的版本. */
  readonly messages: readonly Message[];
}

export type PrepareAgentIteration = (
  input: PrepareAgentIterationInput,
) => Promise<PreparedAgentIteration>;

/**
 * 每次模型请求创建一个新工具执行器.
 * 工具完成, 产生进度或等待用户输入时调用 wake, 通知 Agent 循环读取结果.
 * 这样循环可以等待通知, 不必反复检查执行器状态.
 */
export type ToolExecutorFactory = (
  wake: () => void,
) => StreamingToolExecutor;

export interface AgentLoopInput {
  /** 初始工作历史(持久基线 + 本轮种子消息); 循环在其上持续追加. */
  readonly messages: readonly Message[];
  readonly prepareIteration: PrepareAgentIteration;
  readonly callLLM: CallLLM;
  readonly createToolExecutor: ToolExecutorFactory;
  /** 完整 Assistant 和本批 ToolResult 已保存后的安全点输入; 无工具回复也检查, 不打断生成或工具. */
  readonly takeNextIterationMessages?: () => Promise<readonly Message[]>;
  readonly signal: AbortSignal;
  readonly maxIterations: number;
  /** 本次循环全部真实 LLM 调用的生成目标; 构造 assistant 时挂到消息上, 供下一轮 Adapter 原生状态重放裁决 */
  readonly generationSource: LLMGenerationSource;
}
