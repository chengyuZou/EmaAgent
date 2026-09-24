import type {
  CallLlm,
  LlmGenerationSource,
  LlmRequest,
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
  readonly request: LlmRequest;
  /** Compact 可能改写工作历史; 后续调用必须继续使用这里返回的版本. */
  readonly messages: readonly Message[];
}

export type PrepareAgentIteration = (
  input: PrepareAgentIterationInput,
) => Promise<PreparedAgentIteration>;

/**
 * 每次 LlmCall 创建一个全新执行器 
 * `wake` 是 Tool 执行器→ Agent 循环的唤醒针: 执行器状态变化(完成/进度/等待用户输入)时
 * 唤醒循环重新检查可取结果, 没有它循环只能轮询.
 */
export type ToolExecutorFactory = (
  wake: () => void,
) => StreamingToolExecutor;

export interface AgentLoopInput {
  /** 初始工作历史(持久基线 + 本轮种子消息); 循环在其上持续追加. */
  readonly messages: readonly Message[];
  readonly prepareIteration: PrepareAgentIteration;
  readonly callLlm: CallLlm;
  readonly createToolExecutor: ToolExecutorFactory;
  /** 消息队列立即引导的下一轮消息  在某一个 Iteration 工具结果已经完成后, 领取可进入下一轮的 Session 输入. */
  readonly takeNextIterationMessages?: () => Promise<readonly Message[]>;
  readonly signal: AbortSignal;
  readonly maxIterations: number;
  /** 本次循环全部真实 LLM 调用的生成目标; 构造 assistant 时挂到消息上, 供下一轮 Adapter 原生状态重放裁决 */
  readonly generationSource: LlmGenerationSource;
}
