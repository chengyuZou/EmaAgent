import type { LlmProtocol } from '@ema-agent/providers';
import type { AssistantBlock, Message } from './message.js';
import type { LlmTokenUsage } from './usage.js';

export type { LlmProtocol } from '@ema-agent/providers';
export type { LlmTokenUsage } from './usage.js';
export type {
  AssistantBlock,
  ContentPart,
  Message,
  ToolResultBlock,
  ToolResultContentPart,
  UserBlock,
} from './message.js';

/** Provider 已解析好的协议连接；Provider 身份、模型目录和业务状态不进入执行面。 */
export interface LlmConnection {
  readonly protocol: LlmProtocol;
  /** 本地或受信网关可以不需要凭据，因此凭据允许缺省。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** ToolPool 投影给模型协议的函数定义。 */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type LlmToolChoice = 'auto' | 'none' | { readonly name: string };

/**
 * 跨协议的推理控制。协议只消费自己支持的字段：
 * OpenAI 系协议使用 effort，Anthropic/Gemini 使用 budgetTokens。
 */
export interface LlmThinking {
  readonly enabled: 'auto' | boolean;
  readonly effort?: 'low' | 'medium' | 'high' | 'max';
  readonly budgetTokens?: number;
}

/** 单次协议请求；调用身份、重试策略和持久化均由上层拥有。 */
export interface LlmRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly LlmTool[];
  readonly toolChoice?: LlmToolChoice;
  readonly thinking?: LlmThinking;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export type LlmStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

/**
 * 四种协议统一发出的流事件。承载内容的事件必须带 blockIndex，调用方据此
 * 重建 text、thinking 与 tool_use 的原始交错顺序。
 */
export type LlmStreamEvent =
  | { readonly type: 'text_delta'; readonly blockIndex: number; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly blockIndex: number; readonly delta: string }
  | { readonly type: 'thinking_complete'; readonly blockIndex: number; readonly signature?: string }
  | {
      readonly type: 'tool_use_delta';
      readonly blockIndex: number;
      readonly callId: string;
      readonly name: string;
      readonly argsDelta: string;
    }
  | {
      readonly type: 'tool_use_complete';
      readonly blockIndex: number;
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  /** Provider 可能多次发送同一次调用的累计快照，调用方按快照求差。 */
  | ({ readonly type: 'usage' } & LlmTokenUsage)
  | { readonly type: 'done'; readonly stopReason: LlmStopReason };

/** complete() 对同一条流的无损收集结果。 */
export interface LlmCompletion {
  readonly blocks: readonly AssistantBlock[];
  readonly stopReason: LlmStopReason;
  readonly usage: LlmTokenUsage;
}
