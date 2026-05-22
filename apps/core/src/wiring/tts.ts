import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo, SettingsRepo } from '@ema-agent/storage';

import {
  TtsClient,
  type TtsClientArgs,
  type TtsProviderConfig,
  type VoiceProfileLookup,
  type VoiceRefPathResolver,
} from '@ema-agent/tts';

import {
  getProviderDefinition,
  isTtsProtocol,
  type CharacterCardId,
  type CharacterVoiceProfile,
} from '@ema-agent/contracts';

import type { CharacterCardStore } from '@ema-agent/character-card';
import { resolveVoiceRefPath } from '../storage-locations/index.js';

// ── Fallback settings key ───────────────────────────────────────────────────

export const TTS_FALLBACK_SETTINGS_KEY = 'tts.fallback';

interface FallbackSettings {
  providerConfigId: string;
  model:            string;
  voiceId:          string | null;
  config?:          Record<string, unknown>;
}

// ── Provider config builder ─────────────────────────────────────────────────

export function buildTtsProviderConfig(row: ProviderConfigRow): TtsProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('tts')) return null;

  const protocol = def.protocols.tts;
  if (!isTtsProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  return {
    id:       row.id,
    protocol,
    apiKey:   row.api_key_plain ?? '',
    baseUrl:  row.base_url ?? def.defaultBaseUrl ?? '',
  };
}

function loadTtsProviderConfigs(profileDb: Database): Map<string, TtsProviderConfig> {
  const repo = new ProvidersRepo(profileDb.sqlite);
  const out  = new Map<string, TtsProviderConfig>();
  for (const row of repo.listByCapability('tts')) {
    const cfg = buildTtsProviderConfig(row);
    if (cfg) out.set(cfg.id, cfg);
  }
  return out;
}

function loadFallback(profileDb: Database): TtsClientArgs['fallback'] {
  const settings = new SettingsRepo(profileDb.sqlite);
  const stored   = settings.get(TTS_FALLBACK_SETTINGS_KEY) as FallbackSettings | undefined;
  if (!stored || typeof stored !== 'object') return undefined;
  return {
    providerId: stored.providerConfigId,
    model:      stored.model,
    voiceId:    stored.voiceId,
  };
}

// ── Voice profile + ref-path Façades ────────────────────────────────────────

function buildVoiceProfileLookup(card: CharacterCardStore): VoiceProfileLookup {
  return {
    getVoiceProfile(cardId: CharacterCardId): CharacterVoiceProfile | null {
      const c = card.get(cardId);
      return c ? c.voiceProfile : null;
    },
  };
}

function buildRefPathResolver(): VoiceRefPathResolver {
  return {
    resolve(relPath: string): string {
      return resolveVoiceRefPath(relPath);
    },
  };
}

// ── Top-level builder ───────────────────────────────────────────────────────

export interface BuildTtsClientArgs {
  profileDb: Database;
  card:      CharacterCardStore;
}

export function buildTtsClient(args: BuildTtsClientArgs): TtsClient {
  return new TtsClient({
    providers:       loadTtsProviderConfigs(args.profileDb),
    fallback:        loadFallback(args.profileDb),
    voiceProfiles:   buildVoiceProfileLookup(args.card),
    refPathResolver: buildRefPathResolver(),
  });
}

/**
 * Re-fetch TTS-relevant state from DB and swap into the live TtsClient.
 * Idempotent. Call after PUT /api/providers/:id (tts capability),
 * PUT /api/model-bindings/:module (tts_* rows),
 * or PUT /api/settings/tts-fallback.
 */
export function reloadTtsClient(client: TtsClient, profileDb: Database): void {
  client.reload({
    providers: loadTtsProviderConfigs(profileDb),
    fallback:  loadFallback(profileDb),
  });
}
