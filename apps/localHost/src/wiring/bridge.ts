import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { ProvidersRepo, ModelBindingsRepo } from '@ema-agent/storage';
import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { NarrativeClient } from '@ema-agent/narrative';
import type { BridgeConfigurePayload } from '@ema-agent/narrative';
import {
  providerCatalog,
  type Capability,
} from '@ema-agent/provider';
import type { CredentialFacade } from '@ema-agent/credential';
import {
  capabilityConfigFor,
  configuredBaseUrlFor,
  selectedProtocolFor,
} from './providers/config-resolution.js';

function isEnabledFor(row: ProviderConfigRow | undefined, capability: Capability): row is ProviderConfigRow {
  if (!row || row.enabled !== 1) return false;
  return capabilityConfigFor(row, capability) !== undefined;
}

// ── Bridge URL discovery ─────────────────────────────────────────────────────

/**
 * Resolve the bridge base URL at call time (not at process start).
 *
 *   1. EMA_BRIDGE_URL env var      — full override, useful in dev / CI
 *   2. {EMA_DATA_DIR}/bridge.port  — written by bridge/__main__.py on startup
 *   3. Hardcoded fallback          — http://127.0.0.1:7421
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

// ── Bridge configure ─────────────────────────────────────────────────────────

/**
 * Push LightRAG's internal model config (embed + llm) to the bridge.
 * Called fire-and-forget on startup and after relevant binding changes.
 *
 * Reads from profile.db (provider configs and model bindings live there).
 */
export async function configureBridge(
  profileDb: Database,
  narrative: NarrativeClient,
  credentials: CredentialFacade,
): Promise<void> {
  // 每次调用重新解析：Bridge 可能晚于 LocalHost 启动，并选择与装配时不同的端口。
  narrative.updateBaseUrl(resolveBridgeUrl());
  const providersRepo = new ProvidersRepo(profileDb.sqlite, credentials);
  const bindings      = new ModelBindingsRepo(profileDb.sqlite);

  const payload: BridgeConfigurePayload = { llm: null, embed: null };

  const llmBinding = bindings.get('lightrag-llm');
  if (llmBinding) {
    const row = providersRepo.get(llmBinding.providerConfigId);
    if (isEnabledFor(row, 'llm') && row.credential) {
      const definition = providerCatalog.get(row.definition_id);
      const capability = capabilityConfigFor(row, 'llm');
      const protocol = definition && capability
        ? selectedProtocolFor(definition, 'llm', capability)
        : undefined;
      payload.llm = {
        apiKey:  row.credential,
        baseUrl: definition && capability && protocol
          ? configuredBaseUrlFor(definition, 'llm', capability, protocol) ?? ''
          : '',
        model:   llmBinding.model,
      };
    }
  }

  const embedBinding = bindings.get('lightrag-embed');
  if (embedBinding) {
    const row = providersRepo.get(embedBinding.providerConfigId);
    const enabledRow = isEnabledFor(row, 'embed') ? row : undefined;
    const def = enabledRow ? providerCatalog.get(enabledRow.definition_id) : undefined;
    const capability = enabledRow ? capabilityConfigFor(enabledRow, 'embed') : undefined;
    const protocol = def && capability
      ? selectedProtocolFor(def, 'embed', capability)
      : undefined;
    if (protocol === 'openai-embed' && enabledRow && def && capability) {
      payload.embed = {
        protocol: 'openai-embed',
        apiKey:   enabledRow.credential ?? '',
        baseUrl:  configuredBaseUrlFor(def, 'embed', capability, protocol) ?? '',
        model:    embedBinding.model,
        dim:      embedBinding.embeddingDimension ?? 1024,
      };
    } else if (protocol) {
      console.warn(`[bridge] embed protocol [${protocol}] not yet supported in bridge`);
    }
  }

  const ok = await narrative.configure(payload);
  if (ok) {
    console.log('[bridge] configured');
  } else {
    console.warn('[bridge] not reachable — narrative / RAG features degraded');
  }
}
