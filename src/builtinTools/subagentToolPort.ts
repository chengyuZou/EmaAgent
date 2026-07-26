// 定义 Subagent Tool 调用 Agent 执行能力时所需的最小消费端口。
import type { AgentRunId, TaskId } from '@ema-agent/ids';

/** 子 Agent 启动时如何取得父执行上下文。 */
export type SubagentContextMode = 'subagent' | 'fork';

export interface SubagentSpawnOptions {
  model?: string;
  description?: string;
  /**
   * 默认 subagent；只有明确需要父历史时才使用 fork。
   */
  kind?: SubagentContextMode;
  /** 调用方预分配执行 ID，确保启动事件与持久记录使用同一身份。 */
  agentRunId?: AgentRunId;
  /** 可选关联既有 Task；Spawner 不负责创建或完成 Task。 */
  taskId?: TaskId;
}

export interface SubagentRunResult {
  agentRunId: AgentRunId;
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Subagent Tool 是该端口的消费者，因此契约位于 builtinTools。
 * Agent 可以结构化实现它，但 builtinTools 不反向依赖 Agent 包。
 */
export interface SubagentSpawnerPort {
  /** 同步启动并等待子 Agent 完成。 */
  spawn(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): Promise<SubagentRunResult>;

  /** 后台启动后立即返回执行 ID；父 Turn 结束前必须等待它收口。 */
  spawnBackground?(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): AgentRunId;

  /** 等待后台子 Agent；未知或已回收的执行返回 null。 */
  awaitBackground?(
    agentRunId: AgentRunId,
  ): Promise<SubagentRunResult | null>;

  /** 向运行中的后台子 Agent 投递下一轮可见的协调消息。 */
  queueMessage?(agentRunId: AgentRunId, message: string): boolean;

  /** 只取消指定子 Agent，不中止父 Turn；未知或已结束时返回 false。 */
  abortSubagent?(agentRunId: AgentRunId): boolean;
}
