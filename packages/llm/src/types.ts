import type {
  MessageContentPart,
  AssistantBlock,
  UserBlock,
  LlmProtocol,
} from '@ema-agent/contracts';

// Re-export so callers only need one import
export type { LlmProtocol }     from '@ema-agent/contracts';
export type { AssistantBlock, UserBlock, MessageContentPart as LlmContentPart } from '@ema-agent/contracts';

// ── Provider config ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  id: string;
  provider: LlmProtocol;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── Normalized message format ─────────────────────────────────────────────────

/**
 * Internal wire-format for LLM conversations.
 *
 * Uses Anthropic's content-block model as the canonical shape:
 * - system:    plain string (adapters extract it to a top-level field when needed)
 * - user:      plain string OR UserBlock[] (multimodal input + tool results)
 * - assistant: AssistantBlock[] — preserves text/thinking/tool_use interleaving order
 *
 * Adapters translate FROM this format to provider wire protocol.
 * There is no `role: 'tool'` — tool results live as ToolResultBlock inside
 * a `role: 'user'` message so the history exactly mirrors what Anthropic expects.
 */
export type LlmMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | UserBlock[] }
  | { role: 'assistant'; content: AssistantBlock[] };

export interface LlmRequest {
  providerId: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

// ── Stream output ─────────────────────────────────────────────────────────────

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * Unified stream chunk emitted by every adapter.
 *
 * `blockIndex` appears on all content-bearing chunks and reflects the position
 * of the block within the assistant's content array. The engine uses it to:
 *   1. Reconstruct the correct interleaving order for storage.
 *   2. Detect when an OpenAI index jump signals a completed tool call.
 *
 * Sequence per stream:
 *   (text_delta | thinking_delta | tool_use_delta | tool_use_complete)*
 *   → usage → done
 *
 * A single stream may interleave text and tool blocks at different indices,
 * matching exactly how Claude delivers them.
 */
export type LlmStreamChunk =
  | { type: 'text_delta';        blockIndex: number; delta: string }
  | { type: 'thinking_delta';    blockIndex: number; delta: string }
  | { type: 'tool_use_delta';    blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_use_complete'; blockIndex: number; callId: string; name: string; args: unknown }
  | { type: 'usage';             inputTokens: number; outputTokens: number }
  | { type: 'done';              stopReason: StopReason };

// ── Non-streaming output ──────────────────────────────────────────────────────

/**
 * Collected result of a complete() call.
 * `blocks` is the full AssistantBlock[] in original order — text, thinking, and
 * tool_use blocks interleaved exactly as the model produced them.
 */
export interface LlmCompletion {
  blocks: AssistantBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

// ── Probe result ──────────────────────────────────────────────────────────────

export interface ProbeResult {
  ok:         boolean;
  latencyMs?: number;
  error?:     string;
}

