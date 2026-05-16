import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** All modules that can be bound to a specific provider instance + model. */
export type BindingModule =
  // LLM modules — routed through LlmRouter (TS sidecar)
  | 'chat' | 'narrative' | 'agent'
  | 'compaction' | 'emotion'
  | 'router' | 'plan-parse' | 'title'
  // Bridge-side capabilities — configured via Python FastAPI
  | 'embed' | 'rerank'
  | 'tts' | 'stt' | 'vision' | 'imagegen';

export interface ModelBindingRow {
  module:             BindingModule;
  /** FK → provider_configs.id — which provider instance to use. */
  provider_config_id: string;
  /** Model name as the provider expects it, e.g. "deepseek-reasoner". */
  model:              string;
  /** Only meaningful for tts module. */
  voice_id:           string | null;
  /** JSON object — module-specific extras (e.g. temperature overrides). */
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
 * Manages which provider instance + model is used for each module (mode).
 *
 * A binding answers: "for the `narrative` module, which exact provider_config
 * should I call, and with which model name?"  This enables e.g.:
 *   chat      → siliconflow / Qwen-72B
 *   narrative → deepseek    / deepseek-reasoner
 *   agent     → openai      / gpt-4o
 */
export class ModelBindingsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Write ──────────────────────────────────────────────────────────────────

  /** Insert or replace a module binding. */
  upsert(data: ModelBindingUpsert): void {
    this.db
      .prepare(
        `INSERT INTO model_bindings
           (module, provider_config_id, model, voice_id, config_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(module) DO UPDATE SET
           provider_config_id = excluded.provider_config_id,
           model              = excluded.model,
           voice_id           = excluded.voice_id,
           config_json        = excluded.config_json`,
      )
      .run(
        data.module,
        data.providerConfigId,
        data.model,
        data.voiceId ?? null,
        JSON.stringify(data.config ?? {}),
      );
  }

  delete(module: BindingModule): void {
    this.db.prepare('DELETE FROM model_bindings WHERE module = ?').run(module);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  get(module: BindingModule): ResolvedModelBinding | undefined {
    const row = this.db
      .prepare('SELECT * FROM model_bindings WHERE module = ?')
      .get(module) as ModelBindingRow | undefined;
    return row ? this.resolve(row) : undefined;
  }

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
