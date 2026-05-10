import type { LlmProvider } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelCapabilities {
  chat:        boolean;
  tools:       boolean;
  vision:      boolean;
  jsonMode:    boolean;
  streaming:   boolean;
  promptCache: boolean;
}

export interface ModelEntry {
  provider:      LlmProvider;
  model:         string;          // raw API name, e.g. 'gpt-4o' — passed directly to adapter
  displayName:   string;
  capabilities:  ModelCapabilities;
  contextWindow: number;
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number };
  isStatic:      boolean;         // true = bundled preset; false = fetched at runtime
}

// ── ModelCatalog ──────────────────────────────────────────────────────────────

function key(provider: LlmProvider, model: string): string {
  return `${provider}:${model}`;
}

export class ModelCatalog {
  private readonly entries = new Map<string, ModelEntry>();

  constructor(initial: ModelEntry[] = STATIC_MODELS) {
    for (const e of initial) this.entries.set(key(e.provider, e.model), e);
  }

  list(): ModelEntry[] {
    return [...this.entries.values()];
  }

  get(provider: LlmProvider, model: string): ModelEntry | undefined {
    return this.entries.get(key(provider, model));
  }

  /** Add or replace entries — used when fetching remote model lists at runtime. */
  upsert(entries: ModelEntry[]): void {
    for (const e of entries) this.entries.set(key(e.provider, e.model), e);
  }

  /** Remote model-list fetch — OpenRouter / Ollama support this; no-op for static providers. */
  async refresh(_provider: LlmProvider): Promise<void> { /* implemented per-provider when needed */ }
}

// ── Static preset ─────────────────────────────────────────────────────────────

/** Shorthand: start from all-false and apply overrides. */
const cap = (o: Partial<ModelCapabilities>): ModelCapabilities => ({
  chat: true, tools: true, vision: false, jsonMode: false, streaming: true, promptCache: false,
  ...o,
});

const STATIC_MODELS: ModelEntry[] = [
  // ── OpenAI ──────────────────────────────────────────────────────────────────
  {
    provider: 'openai', model: 'gpt-4o', displayName: 'GPT-4o',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 128_000, isStatic: true,
    pricing: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 },
  },
  {
    provider: 'openai', model: 'gpt-4o-mini', displayName: 'GPT-4o mini',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 128_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  },
  {
    provider: 'openai', model: 'o3-mini', displayName: 'o3-mini',
    capabilities: cap({ jsonMode: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
  },

  // ── Anthropic ────────────────────────────────────────────────────────────────
  {
    provider: 'anthropic', model: 'claude-opus-4-5', displayName: 'Claude Opus 4.5',
    capabilities: cap({ vision: true, promptCache: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
  },
  {
    provider: 'anthropic', model: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5',
    capabilities: cap({ vision: true, promptCache: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  },
  {
    provider: 'anthropic', model: 'claude-haiku-3-5', displayName: 'Claude Haiku 3.5',
    capabilities: cap({ vision: true, promptCache: true }),
    contextWindow: 200_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
  },

  // ── Gemini ───────────────────────────────────────────────────────────────────
  {
    provider: 'gemini', model: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 1_000_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 },
  },
  {
    provider: 'gemini', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro',
    capabilities: cap({ vision: true, jsonMode: true }),
    contextWindow: 1_000_000, isStatic: true,
    pricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  },

  // ── openai-compat (representative presets — user adds more via settings) ─────
  {
    provider: 'openai-compat', model: 'deepseek-chat', displayName: 'DeepSeek Chat',
    capabilities: cap({ jsonMode: true }),
    contextWindow: 64_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 },
  },
  {
    provider: 'openai-compat', model: 'deepseek-reasoner', displayName: 'DeepSeek R1',
    capabilities: cap({ jsonMode: true }),
    contextWindow: 64_000, isStatic: true,
    pricing: { inputUsdPerMillion: 0.55, outputUsdPerMillion: 2.19 },
  },
];
