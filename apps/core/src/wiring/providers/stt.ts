import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo } from '@ema-agent/storage';
import { SttClient, type SttProviderConfig } from '@ema-agent/stt';
import type { CredentialFacade } from '@ema-agent/credential';
import {
  providerCatalog,
  isSttProtocol,
  requiresCredentials,
} from '@ema-agent/provider';
import type {
  UsageRecord,
  UsageRecorder,
} from '@ema-agent/usage';
import {
  capabilityConfigFor,
  configuredBaseUrlFor,
  selectedProtocolFor,
} from './config-resolution.js';

// ── Provider config builder (exported — reused by providers route hot-reload) ─

export function buildSttProviderConfig(row: ProviderConfigRow): SttProviderConfig | null {
  const def = providerCatalog.get(row.definition_id);
  if (!def) return null;

  const capability = capabilityConfigFor(row, 'stt');
  if (!capability) return null;

  const protocol = selectedProtocolFor(def, 'stt', capability);
  if (!isSttProtocol(protocol)) return null;

  if (requiresCredentials(def) && !row.credential) return null;

  return {
    id:      row.id,
    protocol,
    apiKey:  row.credential ?? '',
    baseUrl: configuredBaseUrlFor(def, 'stt', capability, protocol) ?? '',
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
