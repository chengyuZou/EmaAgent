// ── Provider config ───────────────────────────────────────────────────────────

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'openai-compat';

/**
 * Configuration for one LLM provider endpoint.
 * Stored in the DB by the orchestrator and injected into LlmRouter at startup.
 */
export interface ProviderConfig {
  /** Unique label for this config, e.g. "openai-main", "local-ollama".
   *  Used as the first segment of the model string: "<id>/<model-name>". */
  id: string;
  provider: LlmProvider;
  /** API key — plain text for V1; replaced by Stronghold in V2. */
  apiKey: string;
  /** Only for openai-compat: base URL of the compatible server (e.g. Ollama). */
  baseUrl?: string;
  defaultModel?: string;
}

// ── Request types ─────────────────────────────────────────────────────────────

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Normalized message format — adapters translate to/from provider-specific wire formats.
 *
 * Design notes:
 * - 'system' role: OpenAI passes as a message; Anthropic takes it as a separate field.
 *   Adapters handle the extraction.
 * - 'tool' role: consecutive tool messages are grouped into one provider turn where
 *   the API requires it (Anthropic, Gemini).
 */
export type LlmMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool';      toolCallId: string; content: string };

export interface LlmRequest {
  /**
   * Provider-qualified model identifier: "<providerId>/<model-name>"
   * Examples: "openai-main/gpt-4o", "anthropic-main/claude-opus-4-5",
   *           "local-ollama/llama3.2"
   */
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Wired through from SessionStore.startTurn() — fires when user clicks Stop. */
  signal?: AbortSignal;
}

// ── Stream output ─────────────────────────────────────────────────────────────

/**
 * Why the LLM stopped generating.
 *
 * The engine uses this to decide what to do after the stream ends:
 * - end_turn      → normal text reply, write to DB and finish turn
 * - tool_use      → execute the tool calls, then continue the agent loop
 * - max_tokens    → ran out of budget, may need compaction before retry
 * - stop_sequence → a custom stop token was hit (rare in V1)
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * Unified stream chunk — every provider adapter emits this same shape.
 *
 * Sequence guarantees:
 *   text_delta*  →  (tool_use_delta* → tool_use_complete)*  →  usage  →  done
 *
 * The engine only needs to switch on `type`; it never sees raw provider SSE.
 */
export type LlmStreamChunk =
  | { type: 'text_delta';       delta: string }
  | { type: 'tool_use_delta';   callId: string; name: string; argsDelta: string }
  | { type: 'tool_use_complete'; callId: string; name: string; args: unknown }
  | { type: 'usage';            inputTokens: number; outputTokens: number }
  | { type: 'done';             stopReason: StopReason };
