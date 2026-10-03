import type { LlmGenerationSource } from '@ema-agent/llm';
import type { Message, ReasoningEffort } from '@ema-agent/session';
import type { PermissionModeRow, SubagentRunCompletion, SubagentStatusRow } from '@ema-agent/storage';
import type { SubagentContextMode, ToolResult } from '@ema-agent/tools';

export type SubagentStatus = SubagentStatusRow;

/** 稳定身份. 配置记录最近一次准备成功的 Run, 不包含历次执行统计. */
export interface Subagent {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly permissionMode: PermissionModeRow | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly protocol: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SubagentRun {
  readonly id: string;
  readonly subagentId: string;
  readonly parentToolCallId: string | null;
  readonly contextMode: SubagentContextMode;
  readonly description: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly protocol: string | null;
  readonly permissionMode: PermissionModeRow | null;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly status: SubagentStatus;
  readonly error: string | null;
  readonly iterations: number | null;
  readonly toolCallCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly finalText: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface SubagentStart {
  subagentId: string;
  runId: string;
  toolCallId: string;
  sessionId: string;
  contextMode: SubagentContextMode;
  title?: string;
  description?: string;
  isNew: boolean;
}

export type SubagentCompletion = SubagentRunCompletion;

/** 与普通 Message 共用正文, 只增加子代理归属、摘要边界和有效生成来源. */
export interface SubagentMessage extends Message {
  readonly subagentId: string;
  readonly runId: string | null;
  readonly summarizedThroughMessageId: string | null;
  readonly savedTokens?: number;
  readonly generatedBy?: LlmGenerationSource;
}

/** Turn 只交付本次请求的固定前缀. 复制、补工具配对和 ID 映射由 Agent 处理. */
export interface ForkParentMessage extends Message {
  readonly summarizedThroughMessageId: string | null;
  readonly savedTokens?: number;
  readonly generatedBy?: LlmGenerationSource;
}

export interface ForkParentMessages {
  readonly messages: readonly ForkParentMessage[];
}

/** 恢复只能匹配子代理自己执行的调用, 不把 fork 复制来的父调用当成本次执行. */
export interface SubagentToolInteraction {
  readonly runId: string;
  readonly name: string;
  readonly args: unknown;
  result?: ToolResult;
}
