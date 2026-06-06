/**
 * llm-providers.ts — Provider config builders + loaders for LLM / embed / rerank.
 *
 * Kept separate from bindings.ts so the file stays focused on DI assembly.
 * TTS and STT live in tts.ts / stt.ts respectively; this file follows the
 * same pattern for the AI inference providers.
 *
 * All three build functions are exported because the providers route
 * (routes/providers.ts) reuses them when hot-reloading provider configs.
 */

import {
  ProvidersRepo,
  LlmModelCatalogRepo,
  EmbedModelCatalogRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { ProviderConfig } from '@ema-agent/llm';
import type { EmbedProviderConfig, RerankProviderConfig } from '@ema-agent/ebd-client';
import {
  getProviderDefinition,
  isLlmProtocol, isEmbedProtocol, isRerankProtocol,
  resolveProtocols, resolveBaseUrl,
  type ProtocolFamily,
} from '@ema-agent/contracts';

// ── LLM ──────────────────────────────────────────────────────────────────────

export function buildLlmProviderConfig(row: ProviderConfigRow): ProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('llm')) return null;

  // config_json may carry a user-selected protocol (when the definition offers
  // multiple choices). Fall back to the first declared protocol.
  const extra   = JSON.parse(row.config_json) as Record<string, unknown>;
  const choices = resolveProtocols(def.protocols.llm);
  const stored  = typeof extra['protocol'] === 'string' ? extra['protocol'] : undefined;
  const protocol = (stored && choices.includes(stored as never) ? stored : choices[0]) as ProtocolFamily | undefined;
  if (!isLlmProtocol(protocol)) return null;

  const needsKey = def.requiresCredentials !== false;
  if (needsKey && !row.api_key_plain) return null;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? resolveBaseUrl(def, protocol),
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

export function loadLlmConfigs(db: Database): ProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: ProviderConfig[] = [];
  for (const row of repo.listByCapability('llm')) {
    const cfg = buildLlmProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Embed ─────────────────────────────────────────────────────────────────────

export function buildEmbedProviderConfig(
  row:         ProviderConfigRow,
  embedCatalog: EmbedModelCatalogRepo,
): EmbedProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('embed')) return null;

  const protocol = resolveProtocols(def.protocols.embed)[0] as ProtocolFamily | undefined;
  if (!isEmbedProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  const defaultModel = typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined;
  // Vector dimension is a model property — look it up from embed_model_catalog.
  const dim = defaultModel ? embedCatalog.dim(defaultModel) : 0;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    dim,
    defaultModel,
  };
}

export function loadEmbedConfigs(
  db:           Database,
  embedCatalog: EmbedModelCatalogRepo,
): EmbedProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: EmbedProviderConfig[] = [];
  for (const row of repo.listByCapability('embed')) {
    const cfg = buildEmbedProviderConfig(row, embedCatalog);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Rerank ────────────────────────────────────────────────────────────────────

export function buildRerankProviderConfig(row: ProviderConfigRow): RerankProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('rerank')) return null;

  const protocol = resolveProtocols(def.protocols.rerank)[0] as ProtocolFamily | undefined;
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

export function loadRerankConfigs(db: Database): RerankProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: RerankProviderConfig[] = [];
  for (const row of repo.listByCapability('rerank')) {
    const cfg = buildRerankProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}
