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

/** Provider 已解析好的协议连接；模型目录和业务状态不进入执行面。 */
export interface LlmConnection {
  /** 连接归属的 Provider 身份；Adapter 用它做生成来源三元匹配（providerId+modelId+protocol）。 */
  readonly providerId: string;
  readonly protocol: LlmProtocol;
  /** 本地或受信网关可以不需要凭据，因此凭据允许缺省。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * 各协议原生推理状态的判别联合。流只以文本（thinking_delta）暴露推理内容，
 * 完成态（thinking_complete）携带本协议用于 KV 续接/后续请求复用的原生状态；
 * Adapter 只消费自己 kind 的状态，其他 kind 一律忽略，不做跨协议猜测。
 */
export type LlmThinkingState =
  | { readonly kind: 'anthropic'; readonly signature?: string }
  | { readonly kind: 'openai'; readonly id: string; readonly encryptedContent?: string }
  | { readonly kind: 'gemini'; readonly thoughtSignature?: string };

/** 一次生成实际使用的调用目标；历史 Assistant 消息的生成来源事实。 */
export interface LlmGenerationSource {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: LlmProtocol;
}

/** 一次物理 LLM 调用已经确定的终态。 */
export type LlmCallStatus = 'completed' | 'failed' | 'cancelled';

/** ToolPool 投影给模型协议的函数定义。 */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type LlmToolChoice = 'auto' | 'none' | { readonly name: string };

/**
 * 跨协议的推理强度档位（中立词汇）。OpenAI 系同名透传；
 * Anthropic/Gemini 老协议形状由各自 Adapter 映射为 budget 数字（映射表归 Adapter）。
 */
export type LlmThinkingEffort = 'low' | 'medium' | 'high' | 'max';

/**
 * 跨协议的推理控制。协议只消费自己支持的字段：
 * OpenAI 系协议使用 effort，Anthropic/Gemini 使用 budgetTokens。
 */
export interface LlmThinking {
  readonly enabled: 'auto' | boolean;
  readonly effort?: LlmThinkingEffort;
  readonly budgetTokens?: number;
}

/** 单次协议请求；模型身份在创建点冻结（见 CallLlm），重试策略和持久化均由上层拥有。 */
export interface LlmRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly LlmTool[];
  readonly toolChoice?: LlmToolChoice;
  readonly thinking?: LlmThinking;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** 创建点冻结连接与模型身份的单次调用；stream 是唯一执行线。 */
export type CallLlm = (request: LlmRequest) => AsyncIterable<LlmStreamEvent>;

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
  /** 原生推理状态可选：只有协议明确给出续接状态（signature/id/thoughtSignature）才携带。 */
  | { readonly type: 'thinking_complete'; readonly blockIndex: number; readonly state?: LlmThinkingState }
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

/** createLlmCompletion() 对同一条流的无损收集结果。 */
export interface LlmCompletion {
  readonly blocks: readonly AssistantBlock[];
  readonly stopReason: LlmStopReason;
  readonly usage: LlmTokenUsage;
}
