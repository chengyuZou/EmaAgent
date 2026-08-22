import type {
  CallLlm,
  LlmRequest,
  LlmTokenUsage,
  Message,
} from '@ema-agent/llm';
import type {
  StreamingToolExecutor,
} from '@ema-agent/tools';

export interface PrepareAgentIterationInput {
  /** 当前工作历史全文；实现可以返回被 Compact 改写的版本，循环整体替换继续使用。 */
  readonly messages: readonly Message[];
  /** Agent 只报告重试原因，是否 Compact 由 Turn 的实现决定。 */
  readonly recoveryReason?: 'context_window_exceeded';
}

export interface PreparedAgentIteration {
  readonly request: LlmRequest;
  /** Compact 可能改写工作历史；后续调用必须继续使用这里返回的版本。 */
  readonly messages: readonly Message[];
}

/**
 * 每次模型调用前的准备闭包。为什么不是把 systemPrompt/ToolPool/Compact 等原料
 * 交给 Agent 自己编排：装配（assembleContext → 超预算则 Compact → Macro 摘要
 * 落库 → 再装配）涉及持久化与 Context 知识，全归 Turn；Agent 拿到原料自己编排
 * 就必须导入 Context/Compact/持久化，正是边界禁止的方向。根 Turn 与子 Agent
 * 的装配差异也靠这个闭包各自实现、互不感知。
 */
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

/**
 * 每次 LlmCall 创建一个全新执行器。创建时机是 Turn 绑定工具进度、Permission
 * 与 AskUser 事件出口的唯一位置（这些事件由创建它的 Turn 直接接收，不进入
 * Agent 事件），因此必须是工厂而不是现成实例。
 * `wake` 是执行器→循环的唤醒针：执行器状态变化（完成/进度/等待用户输入）时
 * 唤醒循环重新检查可取结果，没有它循环只能轮询。
 */
export type ToolExecutorFactory = (
  wake: () => void,
) => StreamingToolExecutor;

export interface AgentLoopInput {
  /** 初始工作历史（持久基线 + 本轮种子消息）；循环在其上持续追加。 */
  readonly messages: readonly Message[];
  readonly prepareIteration: PrepareAgentIteration;
  readonly callLlm: CallLlm;
  readonly createToolExecutor: ToolExecutorFactory;
  readonly budget: AgentBudget;
  readonly signal: AbortSignal;
  readonly maxIterations: number;
}
