import type { Database } from '@ema-agent/storage';
import {
  ModelBindingsRepo,
  ProvidersRepo,
  type ProviderConfigRow,
} from '@ema-agent/storage';
import { HookBus }       from '@ema-agent/hook';
import { LlmRouter }     from '@ema-agent/llm';
import type { ProviderConfig } from '@ema-agent/llm';
import { EbdRouter }     from '@ema-agent/ebd-client';
import type {
  EmbedProviderConfig, RerankProviderConfig,
} from '@ema-agent/ebd-client';
import { NarrativeClient } from '@ema-agent/narrative-client';
import { CharacterCardStore } from '@ema-agent/character-card';
import { SessionStore }   from '@ema-agent/session';
import { EmotionEngine }  from '@ema-agent/emotion';
import {
  getProviderDefinition,
  isLlmProtocol, isEmbedProtocol, isRerankProtocol,
} from '@ema-agent/contracts';
import { resolveBridgeUrl } from './bridge.js';

// ── App-wide bindings (Façade set passed everywhere) ─────────────────────────

/**
 * Flat bundle for now. When this grows past ~12 fields we'll re-shape into
 * nested groups (core / ai / character / agent / memory). For Round 5A the
 * flat layout keeps all consumers (routes, orchestrator) untouched.
 */
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

// ── Provider config builders (exported — providers route reuses them) ───────

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

// ── Provider list loaders (private — used by buildBindings) ──────────────────

function loadLlmConfigs(db: Database): ProviderConfig[] {
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

// ── Build bindings (does NOT register hooks/emitters — that's a later step) ──

/**
 * Construct every Façade. Pure data assembly: no hook registration, no
 * subscriber wiring, no side effects beyond DB reads and Façade construction.
 *
 * The `wire(db)` entry point in ./index.ts orchestrates:
 *   buildBindings(db)   ← this function
 *   registerAllHooks(...)
 *   registerAllEmitters(...)
 */
export function buildBindings(db: Database): AppBindings {
  const hooks = new HookBus();
  const llm   = new LlmRouter(loadLlmConfigs(db));
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

  const modelBindings = new ModelBindingsRepo(db.sqlite);

  return { db, hooks, llm, ebd, narrative, modelBindings, session, card, emotion };
}
