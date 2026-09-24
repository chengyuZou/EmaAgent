import type { AssistantBlock, UserBlock } from '@ema-agent/llm';
import type { SubagentMessageKind } from '@ema-agent/storage';
import type { SubagentContextMode, ToolResult } from '@ema-agent/tools';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Subagent {
  readonly id: string;
  readonly sessionId: string;
  readonly contextMode: SubagentContextMode;
  readonly description?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: SubagentStatus;
  readonly error?: string;
  readonly iterations?: number;
  readonly toolCallCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly finalText?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface SubagentStart {
  subagentId: string;
  toolCallId: string;
  sessionId: string;
  contextMode: SubagentContextMode;
  description?: string;
  providerId?: string;
  modelId?: string;
}

export interface SubagentInvocation {
  readonly toolCallId: string;
  readonly subagentId: string;
  readonly createdAt: number;
}

export interface SubagentCompletion {
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
}

export interface SubagentSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly contextMode: SubagentContextMode;
  readonly description?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: SubagentStatus;
  readonly error?: string;
  readonly iterations?: number;
  readonly toolCallCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

interface SubagentMessageFields {
  readonly id: string;
  readonly subagentId: string;
  readonly kind: SubagentMessageKind;
  readonly interrupted: boolean;
  readonly sequence: number;
  readonly createdAt: number;
}

/** ToolResult 是 User 消息内的 block, 不是第三种消息角色. */
export type SubagentMessage = SubagentMessageFields & (
  | { readonly role: 'assistant'; readonly blocks: readonly AssistantBlock[] }
  | { readonly role: 'user'; readonly blocks: string | readonly (UserBlock | ToolResult)[] }
);

/** 启动恢复从 Subagent 转录找回的原始调用与已有结果. */
export interface SubagentToolInteraction {
  readonly name: string;
  readonly args: unknown;
  result?: ToolResult;
}
