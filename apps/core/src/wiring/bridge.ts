import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { ProvidersRepo, ModelBindingsRepo } from '@ema-agent/storage';
import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { NarrativeClient } from '@ema-agent/narrative-client';
import type { BridgeConfigurePayload } from '@ema-agent/narrative-client';
import { getProviderDefinition } from '@ema-agent/contracts';
import type { Capability } from '@ema-agent/contracts';
import type { CredentialFacade } from '@ema-agent/credential';

function isEnabledFor(row: ProviderConfigRow | undefined, capability: Capability): row is ProviderConfigRow {
  if (!row || row.enabled !== 1) return false;
  const capabilities = JSON.parse(row.capabilities_json) as Capability[];
  return capabilities.includes(capability);
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
  // Re-resolve at call time: bridge may have started after core and picked a
  // different port than what was read during wire().
  narrative.updateBaseUrl(resolveBridgeUrl());
  const providersRepo = new ProvidersRepo(profileDb.sqlite, credentials);
  const bindings      = new ModelBindingsRepo(profileDb.sqlite);

  const payload: BridgeConfigurePayload = { llm: null, embed: null };

  const llmBinding = bindings.get('lightrag-llm');
  if (llmBinding) {
    const row = providersRepo.get(llmBinding.providerConfigId);
    if (isEnabledFor(row, 'llm') && row.credential) {
      payload.llm = {
        apiKey:  row.credential,
        baseUrl: row.base_url ?? getProviderDefinition(row.definition_id)?.defaultBaseUrl ?? '',
        model:   llmBinding.model,
      };
    }
  }

  const embedBinding = bindings.get('lightrag-embed');
  if (embedBinding) {
    const row = providersRepo.get(embedBinding.providerConfigId);
    const enabledRow = isEnabledFor(row, 'embed') ? row : undefined;
    const def = enabledRow ? getProviderDefinition(enabledRow.definition_id) : undefined;
    // protocols.embed is declared as `ProtocolFamily | readonly ProtocolFamily[]` —
    // every provider definition in this repo actually uses the array form, so
    // normalize to an array before checking membership (comparing the array
    // directly against a string literal with `===` is always false).
    const declared  = def?.protocols.embed;
    const protocols = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
    if (protocols.includes('openai-embed') && enabledRow) {
      payload.embed = {
        protocol: 'openai-embed',
        apiKey:   enabledRow.credential ?? '',
        baseUrl:  enabledRow.base_url ?? def?.defaultBaseUrl ?? '',
        model:    embedBinding.model,
        dim:      (embedBinding.config['dim'] as number | undefined) ?? 1024,
      };
    } else if (protocols.length > 0) {
      console.warn(`[bridge] embed protocols [${protocols.join(', ')}] not yet supported in bridge`);
    }
  }

  const ok = await narrative.configure(payload);
  if (ok) {
    console.log('[bridge] configured');
  } else {
    console.warn('[bridge] not reachable — narrative / RAG features degraded');
  }
}
