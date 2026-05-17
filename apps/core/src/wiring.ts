import type { Database } from '@ema-agent/storage';
import { ModelBindingsRepo, ProvidersRepo } from '@ema-agent/storage';
import type { ProviderConfigRow } from '@ema-agent/storage';
import { HookBus } from '@ema-agent/hook';
import { LlmRouter } from '@ema-agent/llm';
import type { ProviderConfig } from '@ema-agent/llm';
import { CharacterCardStore } from '@ema-agent/character-card';
import { SessionStore } from '@ema-agent/session';
import { buildSystemPrompt } from '@ema-agent/prompts';
import { EmotionEngine } from '@ema-agent/emotion';
import { RetrievalClient } from '@ema-agent/retrieval';
import { getProviderDefinition, isLlmProtocol, type TurnMode } from '@ema-agent/contracts';

// ── App-wide bindings ─────────────────────────────────────────────────────────

export interface AppBindings {
  db: Database;
  hooks: HookBus;
  llm: LlmRouter;
  modelBindings: ModelBindingsRepo;
  session: SessionStore;
  card: CharacterCardStore;
  emotion: EmotionEngine;
  retrieval: RetrievalClient;
}

// ── LlmRouter config builder ──────────────────────────────────────────────────

/**
 * Convert one DB row into a ProviderConfig for LlmRouter.
 * Returns null when the row should be skipped (unknown def, non-LLM protocol,
 * llm not in enabled capabilities, missing required key).
 *
 * Exported so provider routes can call it for hot-reload after PATCH/DELETE.
 */
export function buildLlmProviderConfig(row: ProviderConfigRow): ProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('llm')) return null;

  const protocol = def.protocols.llm;
  if (!isLlmProtocol(protocol)) return null;

  const needsKey = def.requiresCredentials !== false;
  if (needsKey && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    provider:     protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

// ── Provider config loader ────────────────────────────────────────────────────

/**
 * Read enabled LLM providers from `provider_configs`, resolve their metadata
 * via the TS registry, and emit `ProviderConfig` objects for `LlmRouter`.
 *
 * Rows whose definition_id is unknown OR whose declared protocol is not
 * an LLM protocol are silently skipped (with a console warning).
 */
function loadProviderConfigs(db: Database): ProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: ProviderConfig[] = [];

  for (const row of repo.listByCapability('llm')) {
    const def = getProviderDefinition(row.definition_id);
    if (!def) {
      console.warn(`[wiring] unknown provider definition: ${row.definition_id}`);
      continue;
    }
    const protocol = def.protocols.llm;
    if (!isLlmProtocol(protocol)) continue;

    const needsKey = def.requiresCredentials !== false;
    if (needsKey && !row.api_key_plain) continue;

    const extra = JSON.parse(row.config_json) as Record<string, unknown>;
    out.push({
      id:           row.id,
      provider:     protocol,
      apiKey:       row.api_key_plain ?? '',
      baseUrl:      row.base_url ?? def.defaultBaseUrl,
      defaultModel: typeof extra['defaultModel'] === 'string'
        ? extra['defaultModel']
        : undefined,
    });
  }
  return out;
}

// ── Bridge configure ──────────────────────────────────────────────────────────

/**
 * Push LightRAG's internal model config to the bridge.
 *
 * The bridge only needs three things — all read from model_bindings:
 *   'embed'        → which provider/model LightRAG uses to embed documents
 *   'rerank'       → which provider/model LightRAG uses to rerank recall results
 *   'lightrag-llm' → which provider/model LightRAG uses for entity extraction
 *
 * Called fire-and-forget on startup and after any relevant binding changes.
 * Safe if bridge is down — logs a warning and returns without crashing.
 */
export async function configureBridge(
  db: Database,
  retrieval: RetrievalClient,
): Promise<void> {
  const providersRepo = new ProvidersRepo(db.sqlite);
  const bindings      = new ModelBindingsRepo(db.sqlite);

  const payload: Parameters<RetrievalClient['configure']>[0] = {};

  // ── LightRAG's internal LLM (entity extraction / graph building) ──────────
  const llmBinding = bindings.get('lightrag-llm');
  if (llmBinding) {
    const row = providersRepo.get(llmBinding.providerConfigId);
    if (row?.api_key_plain) {
      payload.llm = {
        apiKey:  row.api_key_plain,
        baseUrl: row.base_url ?? getProviderDefinition(row.definition_id)?.defaultBaseUrl ?? '',
        model:   llmBinding.model,
      };
    }
  }

  // ── LightRAG's embed model (document + query vectorisation) ──────────────
  const embedBinding = bindings.get('embed');
  if (embedBinding) {
    const row = providersRepo.get(embedBinding.providerConfigId);
    const def = row ? getProviderDefinition(row.definition_id) : undefined;
    const protocol = def?.protocols.embed;
    if (protocol === 'openai-embed' && row) {
      payload.embed = {
        protocol,
        apiKey:  row.api_key_plain ?? '',
        baseUrl: row.base_url ?? def?.defaultBaseUrl ?? '',
        model:   embedBinding.model,
        dim:     (embedBinding.config['dim'] as number | undefined) ?? 1024,
      };
    } else if (protocol) {
      console.warn(`[bridge] embed protocol "${protocol}" not yet supported in bridge`);
    }
  }

  // ── LightRAG's reranker (post-retrieval scoring) ──────────────────────────
  const rerankBinding = bindings.get('rerank');
  if (rerankBinding) {
    const row = providersRepo.get(rerankBinding.providerConfigId);
    if (row) {
      payload.rerank = {
        apiKey:  row.api_key_plain ?? '',
        baseUrl: row.base_url ?? '',
        model:   rerankBinding.model,
      };
    }
  }

  if (Object.keys(payload).length === 0) return;

  const ok = await retrieval.configure(payload);
  if (ok) {
    console.log('[bridge] configured');
  } else {
    console.warn('[bridge] not reachable — narrative / RAG features degraded');
  }
}

// ── wire ──────────────────────────────────────────────────────────────────────

/**
 * Assemble all dependencies and register hooks.
 */
export function wire(db: Database): AppBindings {
  const hooks = new HookBus();
  const llm   = new LlmRouter(loadProviderConfigs(db));
  const session = new SessionStore({ db });
  const card    = new CharacterCardStore({ db });
  card.ensureSeed();

  const activeCard = card.current();
  const emotion = new EmotionEngine({ vocabulary: activeCard.emotionVocabulary });

  const retrieval = new RetrievalClient({
    baseUrl:   process.env['EMA_BRIDGE_URL'] ?? 'http://127.0.0.1:7421',
    secret:    process.env['EMA_SHARED_SECRET'],
    timeoutMs: 30_000,
  });

  // ── beforeLlm hook: inject system prompt from active character card ──────
  hooks.register('beforeLlm', async (ctx) => {
    const currentCard = card.current();
    const mode = (ctx.meta['mode'] as TurnMode) ?? 'chat';
    const systemPrompt = buildSystemPrompt(currentCard, mode);
    return {
      kind: 'replace',
      payload: {
        systemPrompt,
        messages: [
          { role: 'system' as const, content: systemPrompt },
          ...ctx.payload.messages,
        ],
      },
    };
  }, { priority: 10, name: 'prompts:buildSystem' });

  const modelBindings = new ModelBindingsRepo(db.sqlite);

  return { db, hooks, llm, modelBindings, session, card, emotion, retrieval };
}
