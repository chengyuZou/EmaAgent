import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo } from '@ema-agent/storage';
import type { CredentialFacade } from '@ema-agent/credential';

import {
  TtsRuntime,
  type TtsProviderConfig,
  type TtsVoiceRef,
} from '@ema-agent/tts';

import {
  providerCatalog,
  isTtsProtocol,
  requiresCredentials,
} from '@ema-agent/provider';
import type {
  CharacterCardId,
} from '@ema-agent/ids';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';
import {
  capabilityConfigFor,
  configuredBaseUrlFor,
  selectedProtocolFor,
} from './config-resolution.js';

import type {
  CharacterCardStore,
  CharacterVoiceReference,
} from '@ema-agent/characters';
import { resolveCardVoiceRefPath } from '../../storage-locations/index.js';

// ── Provider config builder ─────────────────────────────────────────────────

export function buildTtsProviderConfig(row: ProviderConfigRow): TtsProviderConfig | null {
  const def = providerCatalog.get(row.definition_id);
  if (!def) return null;

  const capability = capabilityConfigFor(row, 'tts');
  if (!capability) return null;

  const protocol = selectedProtocolFor(def, 'tts', capability);
  if (!isTtsProtocol(protocol)) return null;

  if (requiresCredentials(def) && !row.credential) return null;

  return {
    id:      row.id,
    protocol,
    apiKey:  row.credential ?? '',
    baseUrl: configuredBaseUrlFor(def, 'tts', capability, protocol) ?? '',
  };
}

function loadTtsProviderConfigs(
  profileDb: Database,
  credentials: CredentialFacade,
): TtsProviderConfig[] {
  const repo = new ProvidersRepo(profileDb.sqlite, credentials);
  const out: TtsProviderConfig[] = [];
  for (const row of repo.listByCapability('tts')) {
    const cfg = buildTtsProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Character voice resolution ──────────────────────────────────────────────

/**
 * Resolve a TtsVoiceRef from a character card.
 * Returns null if the card has no reference audio → TTS disabled.
 */
export function resolveVoice(
  card:  CharacterCardId,
  store: CharacterCardStore,
): TtsVoiceRef | null {
  const c = store.get(card);
  if (!c) return null;

  const primary = pickPrimaryVoiceReference(c.voiceReferences);
  if (!primary) return null;

  return {
    refAudioPath: resolveCardVoiceRefPath(c.id, c.isBuiltin, primary.relativePath),
    promptText:   primary.promptText,
    promptLang:   primary.promptLang,
    // Provider 声音句柄由 TTS 输出入口按 Provider + Model 短期缓存或懒上传。
  };
}

function pickPrimaryVoiceReference(
  references: readonly CharacterVoiceReference[],
): CharacterVoiceReference | null {
  return references.find((reference) => reference.enabled && reference.isPrimary)
    ?? references.find((reference) => reference.enabled)
    ?? null;
}

// ── Top-level builder ───────────────────────────────────────────────────────

export interface BuildTtsRuntimeArgs {
  profileDb: Database;
  credentials: CredentialFacade;
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

export function buildTtsRuntime(args: BuildTtsRuntimeArgs): TtsRuntime {
  return new TtsRuntime({
    configs: loadTtsProviderConfigs(args.profileDb, args.credentials),
    usageRecorder: args.usageRecorder,
    onUsageRecordError: args.onUsageRecordError,
  });
}

/**
 * 从数据库重新读取 TTS 配置，并原子替换运行时快照。
 * Call after PUT /api/providers/:id (tts capability) or
 * PUT /api/model-bindings/:module (tts_* rows).
 */
export function reloadTtsRuntime(
  runtime: TtsRuntime,
  profileDb: Database,
  credentials: CredentialFacade,
): void {
  runtime.reload(loadTtsProviderConfigs(profileDb, credentials));
}
