import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo } from '@ema-agent/storage';
import { SttClient, type SttProviderConfig } from '@ema-agent/stt';
import type { CredentialFacade } from '@ema-agent/credential';
import {
  getProviderDefinition,
  isSttProtocol,
  resolveProtocols,
  type ProtocolFamily,
  type UsageRecord,
  type UsageRecorder,
} from '@ema-agent/contracts';

// ── Provider config builder (exported — reused by providers route hot-reload) ─

export function buildSttProviderConfig(row: ProviderConfigRow): SttProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('stt')) return null;

  const protocol = resolveProtocols(def.protocols.stt)[0] as ProtocolFamily | undefined;
  if (!isSttProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.credential) return null;

  return {
    id:      row.id,
    protocol,
    apiKey:  row.credential ?? '',
    baseUrl: row.base_url ?? def.defaultBaseUrl ?? '',
  };
}

function loadSttProviderConfigs(
  profileDb: Database,
  credentials: CredentialFacade,
): SttProviderConfig[] {
  const repo = new ProvidersRepo(profileDb.sqlite, credentials);
  const out: SttProviderConfig[] = [];
  for (const row of repo.listByCapability('stt')) {
    const cfg = buildSttProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Top-level builder ───────────────────────────────────────────────────────

export function buildSttClient(args: {
  profileDb: Database;
  credentials: CredentialFacade;
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}): SttClient {
  return new SttClient(
    loadSttProviderConfigs(args.profileDb, args.credentials),
    undefined,
    {},
    {
      usageRecorder: args.usageRecorder,
      onUsageRecordError: args.onUsageRecordError,
    },
  );
}

/** Hot-reload after a provider config change. Binding resolution stays in the route. */
export function reloadSttClient(
  client: SttClient,
  profileDb: Database,
  credentials: CredentialFacade,
): void {
  client.reload(loadSttProviderConfigs(profileDb, credentials));
}
