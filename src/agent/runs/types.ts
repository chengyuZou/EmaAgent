import type { SubagentContextMode, ToolResult } from '@ema-agent/tools';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunMessageRole =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning';

export interface AgentRun {
  readonly id: string;
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly parentAgentRunId?: string;
  readonly contextMode: SubagentContextMode;
  readonly description?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: AgentRunStatus;
  readonly error?: string;
  readonly iterations?: number;
  readonly toolCallCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface AgentRunStart {
  agentRunId: string;
  sessionId: string;
  parentTurnId: string;
  parentAgentRunId?: string;
  contextMode: SubagentContextMode;
  description?: string;
  providerId?: string;
  modelId?: string;
}

export interface AgentRunCompletion {
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

export type AgentRunTransitionAction = 'complete' | 'fail' | 'cancel';

export type AgentRunTransitionResult =
  | { ok: true; changed: boolean; run: AgentRun }
  | {
      ok: false;
      reason: 'not_found' | 'conflict';
      action: AgentRunTransitionAction;
      current?: AgentRun;
    };

/** assistant/reasoning 的增量文本块（回放时按 blockIndex 合并展示由消费方决定）。 */
export interface AgentRunTextContent {
  readonly blockIndex: number;
  readonly text: string;
}

/** tool_call 消息：partial 是流式到达中的占位；完成形携带最终 args。 */
export type AgentRunToolCallContent =
  | { readonly blockIndex: number; readonly callId: string; readonly name: string; readonly args: unknown }
  | {
      readonly blockIndex: number;
      readonly callId: string;
      readonly name: string;
      readonly argsDelta: string;
      readonly partial: true;
    };

/**
 * 一次运行的内容消息：role 与 content 形状一一绑定，写入侧见 agentRunMessagesStore。
 * tool_result 的 content 即统一 ToolResult 信封（模型可见 content + 类型化 data）。
 */
export type AgentRunMessage =
  | {
      readonly id: string;
      readonly agentRunId: string;
      readonly role: 'assistant' | 'reasoning';
      readonly content: AgentRunTextContent;
      readonly sequence: number;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly agentRunId: string;
      readonly role: 'tool_call';
      readonly content: AgentRunToolCallContent;
      readonly sequence: number;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly agentRunId: string;
      readonly role: 'tool_result';
      readonly content: ToolResult;
      readonly sequence: number;
      readonly createdAt: number;
    };
