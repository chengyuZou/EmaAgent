import type {
  MessageContentPart,
  AssistantBlock,
  UserBlock,
  LlmMessage,
  LlmProtocol,
} from '@ema-agent/contracts';

// Re-export so callers only need one import
export type { LlmProtocol }                                                     from '@ema-agent/contracts';
export type { AssistantBlock, UserBlock, MessageContentPart as LlmContentPart } from '@ema-agent/contracts';
export type { LlmMessage }                                                       from '@ema-agent/contracts';

// ── Provider config ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  id:           string;
  protocol:     LlmProtocol;
  apiKey:       string;
  baseUrl?:     string;
  defaultModel?: string;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── Thinking control ─────────────────────────────────────────────────────────

export type ThinkingEffort = 'high' | 'max';

export type ThinkingMode =
  | {
      /**
       * Leave the provider/model default intact. `effort` may still be sent when
       * a provider supports effort control without an explicit on/off flag.
       */
      enabled: 'auto';
      effort?: ThinkingEffort;
      budgetTokens?: number;
      includeThoughts?: boolean;
    }
  | {
      /** Force provider-side thinking on for this request. */
      enabled: true;
      effort?: ThinkingEffort;
      budgetTokens?: number;
      includeThoughts?: boolean;
    }
  | {
      /** Force provider-side thinking off for this request when supported. */
      enabled: false;
    };

// ── Normalized message format ─────────────────────────────────────────────────
// LlmMessage is defined in @ema-agent/contracts and re-exported above.
// Adapters translate FROM that format to provider wire protocol.

export interface LlmRequest {
  providerId: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  thinking?: ThinkingMode;
  /** Set by LlmRouter from ModelsDevCatalog. Adapters use this to pre-initialize
   *  hasThinking so blockIndex stays stable even when reasoning_content arrives late. */
  supportsReasoning?: boolean;
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
  | { type: 'thinking_complete';  blockIndex: number; signature: string }
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
