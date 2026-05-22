import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** All modules that can be bound to a specific provider instance + model. */
export type BindingModule =
  // LLM modules — routed through LlmRouter (TS sidecar)
  | 'chat' | 'narrative' | 'agent'
  | 'compaction' | 'emotion'
  // 'memory' powers extraction / consolidation / mode-specific compaction.
  // Intentionally one binding for all three — keeps a cheap model on the slot.
  | 'memory'
  | 'router' | 'plan-parse' | 'title'
  // LightRAG internal config — pushed to Python bridge
  | 'embed' | 'rerank' | 'lightrag-llm'
  // TTS — split per mode (see migration 001 CHECK rationale). Voice identity
  // always reads from the active character card; these rows decide which
  // provider/model do the actual synthesis for each mode.
  | 'tts_chat' | 'tts_narrative' | 'tts_agent'
  // Other TS-side clients (reserved)
  | 'stt' | 'vision' | 'imagegen';

/** TTS sub-set of BindingModule — used by tts wiring + coordinator. */
export type TtsBindingModule = 'tts_chat' | 'tts_narrative' | 'tts_agent';

/** Map a user-facing TurnMode-style key to the BindingModule that drives it. */
export function ttsBindingModuleFor(mode: 'chat' | 'narrative' | 'agent'): TtsBindingModule {
  return `tts_${mode}` as TtsBindingModule;
}

export interface ModelBindingRow {
  module:             BindingModule;
  provider_config_id: string;
  model:              string;
  voice_id:           string | null;
  config_json:        string;
}

export interface ModelBindingUpsert {
  module:           BindingModule;
  providerConfigId: string;
  model:            string;
  voiceId?:         string;
  config?:          Record<string, unknown>;
}

/** Resolved binding with config_json parsed. */
export interface ResolvedModelBinding {
  module:           BindingModule;
  providerConfigId: string;
  model:            string;
  voiceId:          string | null;
  config:           Record<string, unknown>;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Manages which provider instance + model is used for each module.
 *
 * Each module can have MULTIPLE bindings (e.g. chat can bind deepseek-v3 AND
 * qwen-72b as candidates). The engine uses the first row for a given module
 * (returned by `get()`). The UI lists all rows via `listByModule()`.
 *
 * Uniqueness key: (module, provider_config_id, model).
 *
 * Example:
 *   chat  → siliconflow / Qwen-72B   (first row = default for engine)
 *   chat  → deepseek    / deepseek-v3
 *   agent → openai      / gpt-4o
 */
export class ModelBindingsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Write ──────────────────────────────────────────────────────────────────

  /** Insert a binding. Conflicts on (module, provider_config_id, model) update the row. */
  upsert(data: ModelBindingUpsert): void {
    this.db
      .prepare(
        `INSERT INTO model_bindings
           (module, provider_config_id, model, voice_id, config_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(module, provider_config_id, model) DO UPDATE SET
           voice_id    = excluded.voice_id,
           config_json = excluded.config_json`,
      )
      .run(
        data.module,
        data.providerConfigId,
        data.model,
        data.voiceId ?? null,
        JSON.stringify(data.config ?? {}),
      );
  }

  /** Delete one specific binding. */
  delete(module: BindingModule, providerConfigId: string, model: string): void {
    this.db
      .prepare('DELETE FROM model_bindings WHERE module = ? AND provider_config_id = ? AND model = ?')
      .run(module, providerConfigId, model);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** Return the FIRST binding for a module (engines use this as the default). */
  get(module: BindingModule): ResolvedModelBinding | undefined {
    const row = this.db
      .prepare('SELECT * FROM model_bindings WHERE module = ? LIMIT 1')
      .get(module) as ModelBindingRow | undefined;
    return row ? this.resolve(row) : undefined;
  }

  /** Return ALL bindings for a module (UI listing). */
  listByModule(module: BindingModule): ResolvedModelBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM model_bindings WHERE module = ?')
      .all(module) as ModelBindingRow[];
    return rows.map(r => this.resolve(r));
  }

  /** Return every binding across all modules. */
  list(): ResolvedModelBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM model_bindings ORDER BY module ASC')
      .all() as ModelBindingRow[];
    return rows.map(r => this.resolve(r));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resolve(row: ModelBindingRow): ResolvedModelBinding {
    return {
      module:           row.module,
      providerConfigId: row.provider_config_id,
      model:            row.model,
      voiceId:          row.voice_id,
      config:           JSON.parse(row.config_json) as Record<string, unknown>,
    };
  }
}
