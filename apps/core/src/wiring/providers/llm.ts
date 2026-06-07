import {
  ProvidersRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { ProviderConfig } from '@ema-agent/llm';
import {
  getProviderDefinition,
  isLlmProtocol,
  resolveProtocols, resolveBaseUrl,
  type ProtocolFamily,
} from '@ema-agent/contracts';

export function buildLlmProviderConfig(row: ProviderConfigRow): ProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('llm')) return null;

  // config_json may carry a user-selected protocol (when the definition offers
  // multiple choices). Fall back to the first declared protocol.
  const extra    = JSON.parse(row.config_json) as Record<string, unknown>;
  const choices  = resolveProtocols(def.protocols.llm);
  const stored   = typeof extra['protocol'] === 'string' ? extra['protocol'] : undefined;
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
