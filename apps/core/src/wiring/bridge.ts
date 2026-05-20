import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { ProvidersRepo, ModelBindingsRepo } from '@ema-agent/storage';
import type { Database } from '@ema-agent/storage';
import { NarrativeClient } from '@ema-agent/narrative-client';
import type { BridgeConfigurePayload } from '@ema-agent/narrative-client';
import { getProviderDefinition } from '@ema-agent/contracts';

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
