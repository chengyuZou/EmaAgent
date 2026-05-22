import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo, ModelBindingsRepo } from '@ema-agent/storage';

import {
  SttClient,
  type SttProviderConfig,
  type SttBinding,
} from '@ema-agent/stt';

import { getProviderDefinition, isSttProtocol } from '@ema-agent/contracts';

// ── Provider config builder ─────────────────────────────────────────────────

export function buildSttProviderConfig(row: ProviderConfigRow): SttProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('stt')) return null;

  const protocol = def.protocols.stt;
  if (!isSttProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  return {
    id:       row.id,
    protocol,
    apiKey:   row.api_key_plain ?? '',
    baseUrl:  row.base_url ?? def.defaultBaseUrl ?? '',
  };
}

function loadSttProviderConfigs(profileDb: Database): Map<string, SttProviderConfig> {
  const repo = new ProvidersRepo(profileDb.sqlite);
  const out  = new Map<string, SttProviderConfig>();
  for (const row of repo.listByCapability('stt')) {
    const cfg = buildSttProviderConfig(row);
    if (cfg) out.set(cfg.id, cfg);
  }
  return out;
}

function loadSttBinding(profileDb: Database): SttBinding | null {
  const repo = new ModelBindingsRepo(profileDb.sqlite);
  const row  = repo.get('stt');
  if (!row) return null;
  return {
    providerConfigId: row.providerConfigId,
    model:            row.model,
  };
}

// ── Top-level builder ───────────────────────────────────────────────────────

export interface BuildSttClientArgs {
  profileDb: Database;
}

export function buildSttClient(args: BuildSttClientArgs): SttClient {
  return new SttClient({
    providers: loadSttProviderConfigs(args.profileDb),
    binding:   loadSttBinding(args.profileDb),
  });
}

/** Hot-reload — see reloadTtsClient for the analogous call sites. */
export function reloadSttClient(client: SttClient, profileDb: Database): void {
  client.reload({
    providers: loadSttProviderConfigs(profileDb),
    binding:   loadSttBinding(profileDb),
  });
}
