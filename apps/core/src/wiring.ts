import type { Database } from '@ema-agent/storage';
import { ModelBindingsRepo, ProvidersRepo } from '@ema-agent/storage';
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
 * Push embed / rerank / llm config to the bridge process.
 *
 * Called fire-and-forget after wire() — bridge may not be up yet,
 * so failures are logged as warnings rather than crashing core.
 * Re-call this whenever provider settings change in the UI.
 */
export async function configureBridge(
  db: Database,
  retrieval: RetrievalClient,
): Promise<void> {
  const providersRepo  = new ProvidersRepo(db.sqlite);
  const modelBindings  = new ModelBindingsRepo(db.sqlite);

  const payload: Parameters<RetrievalClient['configure']>[0] = {};

  // ── LLM config for LightRAG's internal calls ─────────────────────────────
  // Take the first enabled provider whose LLM protocol is openai-llm
  // (LightRAG's llm_func is openai-compat in our setup).
  for (const row of providersRepo.listByCapability('llm')) {
    const def = getProviderDefinition(row.definition_id);
    if (!def || def.protocols.llm !== 'openai-llm' || !row.api_key_plain) continue;
    const extra = JSON.parse(row.config_json) as Record<string, unknown>;
    payload.llm = {
      apiKey:  row.api_key_plain,
      baseUrl: row.base_url ?? def.defaultBaseUrl ?? '',
      model:   typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : '',
    };
    break;
  }

  // ── Embed config ─────────────────────────────────────────────────────────
  const embedBinding = modelBindings.get('embed');
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
      console.warn(`[wiring] embed protocol "${protocol}" not implemented in bridge`);
    }
  }

  // ── Rerank config ────────────────────────────────────────────────────────
  const rerankBinding = modelBindings.get('rerank');
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
    console.log('[bridge] configured successfully');
  } else {
    console.warn('[bridge] not reachable, skipping configure (bridge-dependent features degraded)');
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
