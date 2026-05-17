import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import type { Database } from '@ema-agent/storage';
import { ModelBindingsRepo, ProvidersRepo } from '@ema-agent/storage';
import type { ProviderConfigRow } from '@ema-agent/storage';
import { HookBus } from '@ema-agent/hook';
import { LlmRouter } from '@ema-agent/llm';
import type { ProviderConfig } from '@ema-agent/llm';
import { EbdRouter } from '@ema-agent/ebd-client';
import type { EmbedProviderConfig, RerankProviderConfig } from '@ema-agent/ebd-client';
import { NarrativeClient } from '@ema-agent/narrative-client';
import type { BridgeConfigurePayload } from '@ema-agent/narrative-client';
import { CharacterCardStore } from '@ema-agent/character-card';
import { SessionStore } from '@ema-agent/session';
import { buildSystemPrompt } from '@ema-agent/prompts';
import { EmotionEngine } from '@ema-agent/emotion';
import {
  getProviderDefinition,
  isLlmProtocol,
  isEmbedProtocol,
  isRerankProtocol,
  type TurnMode,
} from '@ema-agent/contracts';

// ── Bridge URL discovery ──────────────────────────────────────────────────────

/**
 * Resolve the bridge base URL at call time (not at process start).
 *
 * Priority:
 *   1. EMA_BRIDGE_URL env var — full override, useful in dev / CI
 *   2. {EMA_DATA_DIR}/bridge.port — written by bridge/__main__.py on startup
 *   3. Hardcoded fallback http://127.0.0.1:7421
 */
export function resolveBridgeUrl(): string {
  if (process.env['EMA_BRIDGE_URL']) return process.env['EMA_BRIDGE_URL'];

  const dataDir  = process.env['EMA_DATA_DIR'] ?? path.join(os.homedir(), '.ema-agent');
  const portFile = path.join(dataDir, 'bridge.port');
  try {
    const port = fs.readFileSync(portFile, 'utf8').trim();
    if (port) return `http://127.0.0.1:${port}`;
  } catch { /* bridge not running yet — fall through */ }

  return 'http://127.0.0.1:7421';
}

// ── App-wide bindings ─────────────────────────────────────────────────────────

export interface AppBindings {
  db:            Database;
  hooks:         HookBus;
  llm:           LlmRouter;
  ebd:           EbdRouter;
  narrative:     NarrativeClient;
  modelBindings: ModelBindingsRepo;
  session:       SessionStore;
  card:          CharacterCardStore;
  emotion:       EmotionEngine;
}

// ── LlmRouter config builder ──────────────────────────────────────────────────

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

// ── EbdRouter config builders ─────────────────────────────────────────────────

export function buildEmbedProviderConfig(row: ProviderConfigRow): EmbedProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('embed')) return null;

  const protocol = def.protocols.embed;
  if (!isEmbedProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    dim:          typeof extra['dim'] === 'number' ? extra['dim'] : 1024,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

export function buildRerankProviderConfig(row: ProviderConfigRow): RerankProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('rerank')) return null;

  const protocol = def.protocols.rerank;
  if (!isRerankProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

// ── Provider config loaders ───────────────────────────────────────────────────

function loadProviderConfigs(db: Database): ProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: ProviderConfig[] = [];
  for (const row of repo.listByCapability('llm')) {
    const cfg = buildLlmProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

function loadEmbedConfigs(db: Database): EmbedProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: EmbedProviderConfig[] = [];
  for (const row of repo.listByCapability('embed')) {
    const cfg = buildEmbedProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

function loadRerankConfigs(db: Database): RerankProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: RerankProviderConfig[] = [];
  for (const row of repo.listByCapability('rerank')) {
    const cfg = buildRerankProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Bridge configure ──────────────────────────────────────────────────────────

/**
 * Push LightRAG's internal model config (embed + llm) to the bridge.
 * Called fire-and-forget on startup and after relevant binding changes.
 */
export async function configureBridge(
  db: Database,
  narrative: NarrativeClient,
): Promise<void> {
  // Re-resolve at call time: bridge may have started after core and picked a
  // different port than what was read during wire().
  narrative.updateBaseUrl(resolveBridgeUrl());
  const providersRepo = new ProvidersRepo(db.sqlite);
  const bindings      = new ModelBindingsRepo(db.sqlite);

  const payload: BridgeConfigurePayload = {};

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

  if (Object.keys(payload).length === 0) return;

  const ok = await narrative.configure(payload);
  if (ok) {
    console.log('[bridge] configured');
  } else {
    console.warn('[bridge] not reachable — narrative / RAG features degraded');
  }
}

// ── wire ──────────────────────────────────────────────────────────────────────

export function wire(db: Database): AppBindings {
  const hooks = new HookBus();
  const llm   = new LlmRouter(loadProviderConfigs(db));
  const ebd   = new EbdRouter(loadEmbedConfigs(db), loadRerankConfigs(db));

  const narrative = new NarrativeClient({
    baseUrl:   resolveBridgeUrl(),
    secret:    process.env['EMA_SHARED_SECRET'],
    timeoutMs: 60_000,
  });

  const session = new SessionStore({ db });
  const card    = new CharacterCardStore({ db });
  card.ensureSeed();

  const activeCard = card.current();
  const emotion = new EmotionEngine({ vocabulary: activeCard.emotionVocabulary });

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

  return { db, hooks, llm, ebd, narrative, modelBindings, session, card, emotion };
}
