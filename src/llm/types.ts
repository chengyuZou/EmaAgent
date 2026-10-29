import type { LLMProtocol } from '@ema-agent/providers';
import type { AssistantBlock, Message } from './message.js';
import type { LLMTokenUsage } from './usage.js';

export type { LLMProtocol } from '@ema-agent/providers';
export type { LLMTokenUsage } from './usage.js';
export type {
  AssistantBlock,
  ContentPart,
  Message,
  ToolResultBlock,
  ToolResultContentPart,
  UserBlock,
} from './message.js';

export interface LLMConnection {
  /** 与 modelId 和 protocol 一起确定生成来源, 用于判断原生推理状态能否回传. */
  readonly providerId: string;
  readonly protocol: LLMProtocol;
  /** 本地服务或网关可以不需要凭据. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * thinking_delta 交付可见的思考文本, thinking_complete 携带供应商返回的续接状态.
 * 后续请求只向相同生成目标回传对应协议的状态, 不在不同协议之间转换.
 */
export type LLMThinkingState =
  | { readonly kind: 'anthropic'; readonly signature?: string }
  | { readonly kind: 'openai'; readonly id: string; readonly encryptedContent?: string }
  | { readonly kind: 'gemini'; readonly thoughtSignature?: string };

/** 保存助手消息的生成目标, 不能仅凭模型名判断原生推理状态是否兼容. */
export interface LLMGenerationSource {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: LLMProtocol;
}

/** 一次模型请求的执行结果, 与内容的 stopReason 分开记录. */
export type LLMCallStatus = 'completed' | 'failed' | 'cancelled';

export interface LLMTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type LLMToolChoice = 'auto' | 'none' | { readonly name: string };

/**
 * OpenAI 协议直接传递强度名称, Anthropic 和 Gemini 的当前实现将其换算为 Token 预算.
 * 预算映射是本项目的取值, 不是不同供应商之间的等效性能保证.
 */
export type LLMThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export interface LLMThinking {
  /** auto 保留供应商默认行为, 不主动开启或关闭思考. */
  readonly enabled: 'auto' | boolean;
  readonly effort?: LLMThinkingEffort;
  readonly budgetTokens?: number;
}

export interface LLMRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly LLMTool[];
  readonly toolChoice?: LLMToolChoice;
  readonly thinking?: LLMThinking;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** 每次调用产生一条请求流. 连接和模型由 createLLMCall 固定, 消费流时才开始执行. */
export type CallLLM = (request: LLMRequest) => AsyncIterable<LLMStreamEvent>;

/** 连接和模型由 createLLMCompletion 固定, 每次调用内部收集流式响应, 返回完整结果. 调用方不管理流. */
export type CompleteLLM = (request: LLMRequest) => Promise<LLMCompletion>;

export type LLMStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

/**
 * 同一内容块的事件共用 blockIndex, 调用方据此拼接正文, 思考和工具调用.
 * blockIndex 也决定最终 blocks 的顺序, 不能按事件到达时间重新分配.
 */
export type LLMStreamEvent =
  | { readonly type: 'text_delta'; readonly blockIndex: number; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly blockIndex: number; readonly delta: string }
  /** state 缺省时仅标记该思考块结束, 不补造供应商续接状态. */
  | { readonly type: 'thinking_complete'; readonly blockIndex: number; readonly state?: LLMThinkingState }
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
  /** 同一次请求的累计用量, 不能把重复事件直接相加. */
  | ({ readonly type: 'usage' } & LLMTokenUsage)
  | { readonly type: 'done'; readonly stopReason: LLMStopReason };

/** 一次请求的完整内容和用量, 保留思考状态及工具调用, 不只返回正文字符串. */
export interface LLMCompletion {
  readonly blocks: readonly AssistantBlock[];
  readonly stopReason: LLMStopReason;
  readonly usage: LLMTokenUsage;
}
