import type { LlmProtocol } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelCapabilities {
  /** Extended reasoning / chain-of-thought (DeepSeek-R1, Claude thinking, o-series, Gemini 2.5). */
  thinking:    boolean;
  tools:       boolean;
  vision:      boolean;
  jsonMode:    boolean;
  streaming:   boolean;
  promptCache: boolean;
}

export interface ModelEntry {
  protocol:      LlmProtocol;
  model:         string;          // raw API name — passed directly to adapter
  displayName:   string;
  capabilities:  ModelCapabilities;
  contextWindow: number;
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number };
  isStatic:      boolean;         // true = bundled preset; false = fetched at runtime
}

// ── ModelCatalog ──────────────────────────────────────────────────────────────

function key(protocol: LlmProtocol, model: string): string {
  return `${protocol}:${model}`;
}

export class ModelCatalog {
  private readonly entries = new Map<string, ModelEntry>();

  constructor(initial: ModelEntry[] = STATIC_MODELS) {
    for (const e of initial) this.entries.set(key(e.protocol, e.model), e);
  }

  list(): ModelEntry[] {
    return [...this.entries.values()];
  }

  get(protocol: LlmProtocol, model: string): ModelEntry | undefined {
    return this.entries.get(key(protocol, model));
  }

  /** Add or replace entries — used when fetching remote model lists at runtime. */
  upsert(entries: ModelEntry[]): void {
    for (const e of entries) this.entries.set(key(e.protocol, e.model), e);
  }

  /** Remote model-list fetch — OpenRouter / Ollama support this; no-op for static providers. */
  async refresh(_protocol: LlmProtocol): Promise<void> { /* implemented per-provider when needed */ }
}

// ── Static preset ─────────────────────────────────────────────────────────────

/**
 * Shorthand: start from sensible defaults and apply overrides.
 * All models can chat — `thinking` flags models with exposed reasoning traces.
 */
const cap = (o: Partial<ModelCapabilities>): ModelCapabilities => ({
  thinking: false, tools: true, vision: false, jsonMode: false, streaming: true, promptCache: false,
  ...o,
});

const STATIC_MODELS: ModelEntry[] = [
  // ── OpenAI — Chat Completions (openai-llm) ───────────────────────────────────
  {
    protocol: 'openai-llm', model: 'gpt-4.1', displayName: 'GPT-4.1',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 1_047_576, isStatic: true,
    pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
  },
  {
    protocol: 'openai-llm', model: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 1_047_576, isStatic: true,
    pricing: { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
  },
  {
    protocol: 'openai-llm', model: 'gpt-4o', displayName: 'GPT-4o',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 128_000, isStatic: true,
    pricing: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 },
  },
  {
    protocol: 'openai-llm', model: 'gpt-4o-mini', displayName: 'GPT-4o mini',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 128_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  },

  // ── OpenAI — Responses API (openai-responses-llm) ────────────────────────────
  // o-series reasoning models work best with the Responses API:
  // reasoning summaries are exposed via response.reasoning_summary_text.delta.
  {
    protocol: 'openai-responses-llm', model: 'o3', displayName: 'o3',
    capabilities: cap({ thinking: true, jsonMode: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 40 },
  },
  {
    protocol: 'openai-responses-llm', model: 'o4-mini', displayName: 'o4-mini',
    capabilities: cap({ thinking: true, vision: true, jsonMode: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
  },

  // ── Anthropic ────────────────────────────────────────────────────────────────
  {
    protocol: 'anthropic-llm', model: 'claude-opus-4-5', displayName: 'Claude Opus 4.5',
    capabilities: cap({ thinking: true, vision: true, promptCache: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
  },
  {
    protocol: 'anthropic-llm', model: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5',
    capabilities: cap({ thinking: true, vision: true, promptCache: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  },
  {
    protocol: 'anthropic-llm', model: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5',
    capabilities: cap({ vision: true, promptCache: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
  },

  // ── Gemini ───────────────────────────────────────────────────────────────────
  {
    protocol: 'gemini-llm', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro',
    capabilities: cap({ thinking: true, vision: true, jsonMode: true }),
    contextWindow: 1_048_576, isStatic: true,
    pricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  },
  {
    protocol: 'gemini-llm', model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash',
    capabilities: cap({ thinking: true, vision: true, jsonMode: true }),
    contextWindow: 1_048_576, isStatic: true,
    pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  },
  {
    protocol: 'gemini-llm', model: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 1_000_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 },
  },

  // ── OpenAI-compat presets (user-configured providers: DeepSeek, SiliconFlow…) ─
  // deepseek-chat / deepseek-reasoner are deprecated 2026-07-24; use the new names.
  {
    protocol: 'openai-llm', model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash',
    capabilities: cap({ thinking: true, jsonMode: true }),
    contextWindow: 64_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
  },
  {
    protocol: 'openai-llm', model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro',
    capabilities: cap({ thinking: true, jsonMode: true }),
    contextWindow: 64_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.55, outputUsdPerMillion: 2.19 },
  },
];
