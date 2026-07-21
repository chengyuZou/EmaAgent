// 定义 LLM Provider 配置、统一请求、流式分块和完成结果。
import type { UsageContext } from '@ema-agent/usage';
import type { LlmProtocol } from '@ema-agent/provider';
import type { LlmCallId } from './ids.js';
import type { AssistantBlock, Message } from './message.js';
import type { LlmTokenUsage } from './usage.js';

// 公开类型由各自所有者定义，调用方仍可从 LLM 入口一次导入。
export type { LlmProtocol } from '@ema-agent/provider';
export type { LlmTokenUsage } from './usage.js';
export type {
  AssistantBlock,
  ContentPart as LlmContentPart,
  Message,
  ToolResultBlock,
  ToolResultContentPart,
  UserBlock,
} from './message.js';
export type { LlmCallId } from './ids.js';

// ── Provider 配置 ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  id:           string;
  protocol:     LlmProtocol;
  apiKey:       string;
  baseUrl?:     string;
  /** models.dev Provider id；用于按 Provider + Model 精确解析能力。 */
  modelsDevId?: string;
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
// Adapter 只能把 Message 翻译成 Provider 线路协议。

export interface LlmRequest {
  providerId: string;
  model: string;
  messages: Message[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  thinking?: ThinkingMode;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** 业务调用身份由上层传入；省略时运行时为内部调用生成独立身份。 */
  usageContext?: UsageContext<LlmCallId>;
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
 *   (text_delta | thinking_delta | tool_use_delta | tool_use_complete | usage)*
 *   -> done
 *
 * `usage` 是当前逻辑调用的 Provider 累计快照，不是相对上一个事件的增量。
 * Adapter 可以在 Provider 给出可靠计数时多次发送，上游必须按快照求差后聚合。
 *
 * 单次流可在不同 index 处交错 text 与 tool block,
 * 与 Claude 的投递方式完全一致。
 */
export type LlmStreamChunk =
  | {
      type: 'request_degraded';
      attempt: number;
      reason: string;
      removed: Array<'image' | 'audio' | 'file' | 'parameter'>;
      replacements: Array<'description' | 'placeholder' | 'parameter_omitted'>;
    }
  | { type: 'text_delta';        blockIndex: number; delta: string }
  | { type: 'thinking_delta';    blockIndex: number; delta: string }
  | { type: 'thinking_complete';  blockIndex: number; signature: string }
  | { type: 'tool_use_delta';    blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_use_complete'; blockIndex: number; callId: string; name: string; args: unknown }
  | ({ type: 'usage' } & LlmTokenUsage)
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
  usage: LlmTokenUsage;
}

// ── probe 结果 ──────────────────────────────────────────────────────

export interface ProbeResult {
  ok:         boolean;
  latencyMs?: number;
  error?:     string;
}
