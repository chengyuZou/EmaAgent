import type {
  MessageContentPart,
  AssistantBlock,
  UserBlock,
  LlmMessage,
  LlmProtocol,
  LlmUsage,
} from '@ema-agent/contracts';

// 重新导出,调用方只需一次 import
export type { LlmProtocol, LlmUsage }                                           from '@ema-agent/contracts';
export type { AssistantBlock, UserBlock, MessageContentPart as LlmContentPart } from '@ema-agent/contracts';
export type { LlmMessage }                                                       from '@ema-agent/contracts';

// ── Provider 配置 ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  id:           string;
  protocol:     LlmProtocol;
  apiKey:       string;
  baseUrl?:     string;
  defaultModel?: string;
}

// ── 工具定义 ──────────────────────────────────────────────────────────

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── thinking 控制 ─────────────────────────────────────────────────────

export type ThinkingEffort = 'high' | 'max';

export type ThinkingMode =
  | {
      /**
       * 保留 provider/model 默认行为。当 provider 支持不带显式开关的 effort 控制时,
       * 仍可能发送 `effort`。
       */
      enabled: 'auto';
      effort?: ThinkingEffort;
      budgetTokens?: number;
      includeThoughts?: boolean;
    }
  | {
      /** 本次请求强制开启 provider 侧 thinking。 */
      enabled: true;
      effort?: ThinkingEffort;
      budgetTokens?: number;
      includeThoughts?: boolean;
    }
  | {
      /** 支持时,本次请求强制关闭 provider 侧 thinking。 */
      enabled: false;
    };

// ── 归一化消息格式 ─────────────────────────────────────────────────
// LlmMessage 定义在 @ema-agent/contracts,上方已重新导出。
// adapter 把该格式翻译成 provider 线路协议。

export interface LlmRequest {
  providerId: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  thinking?: ThinkingMode;
  /** 由 LlmRouter 从 ModelsDevCatalog 设置。adapter 用它预初始化
   *  hasThinking,这样即使 reasoning_content 迟到,blockIndex 也保持稳定。 */
  supportsReasoning?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

// ── 流式输出 ─────────────────────────────────────────────────────

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * 每个 adapter 发出的统一流式 chunk。
 *
 * `blockIndex` 出现在所有承载内容的 chunk 上,反映该 block 在 assistant 内容数组中的位置。
 * engine 用它来:
 *   1. 重建正确的交错顺序以入库。
 *   2. 检测 OpenAI 的 index 跳变是否表示一个 tool call 已完成。
 *
 * 单次流的序列:
 *   (text_delta | thinking_delta | tool_use_delta | tool_use_complete)*
 *   -> usage -> done
 *
 * 单次流可在不同 index 处交错 text 与 tool block,
 * 与 Claude 的投递方式完全一致。
 */
export type LlmStreamChunk =
  | { type: 'text_delta';        blockIndex: number; delta: string }
  | { type: 'thinking_delta';    blockIndex: number; delta: string }
  | { type: 'thinking_complete';  blockIndex: number; signature: string }
  | { type: 'tool_use_delta';    blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_use_complete'; blockIndex: number; callId: string; name: string; args: unknown }
  | ({ type: 'usage' } & LlmUsage)
  | { type: 'done';              stopReason: StopReason };

// ── 非流式输出 ──────────────────────────────────────────────────────

/**
 * complete() 调用收集到的结果。
 * `blocks` 是完整 AssistantBlock[],保持原始顺序 - text、thinking 与
 * tool_use block 按模型产出的顺序交错。
 */
export interface LlmCompletion {
  blocks: AssistantBlock[];
  stopReason: StopReason;
  usage: LlmUsage;
}

// ── probe 结果 ──────────────────────────────────────────────────────

export interface ProbeResult {
  ok:         boolean;
  latencyMs?: number;
  error?:     string;
}
