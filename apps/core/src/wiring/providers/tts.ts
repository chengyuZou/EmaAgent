import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo, SettingsRepo } from '@ema-agent/storage';

import {
  TtsClient,
  type TtsProviderConfig,
  type TtsAdapter,
  type TtsVoiceRef,
} from '@ema-agent/tts';

import {
  getProviderDefinition,
  isTtsProtocol,
  resolveProtocols,
  type ProtocolFamily,
  type CharacterCardId,
} from '@ema-agent/contracts';

import type { CharacterCardStore, CharacterVoiceProfile } from '@ema-agent/character-card';
import { resolveVoiceRefPath } from '../../storage-locations/index.js';

// ── Provider config builder ─────────────────────────────────────────────────

export function buildTtsProviderConfig(row: ProviderConfigRow): TtsProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('tts')) return null;

  const protocol = resolveProtocols(def.protocols.tts)[0] as ProtocolFamily | undefined;
  if (!isTtsProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  return {
    id:      row.id,
    protocol,
    apiKey:  row.api_key_plain ?? '',
    baseUrl: row.base_url ?? def.defaultBaseUrl ?? '',
  };
}

function loadTtsProviderConfigs(profileDb: Database): TtsProviderConfig[] {
  const repo = new ProvidersRepo(profileDb.sqlite);
  const out: TtsProviderConfig[] = [];
  for (const row of repo.listByCapability('tts')) {
    const cfg = buildTtsProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Voice URI cache ─────────────────────────────────────────────────────────
//
// Persisted in profile.db → settings table. Key format:
//   tts.voiceUri.<cardId>.<providerConfigId>.<model>
// Value is the provider-specific voice URI string.
//
// This prevents cross-provider URI pollution: switching a character from
// SiliconFlow to DashScope won't accidentally send a SiliconFlow URI to Ali.

const VOICE_URI_KEY_PREFIX = 'tts.voiceUri';

export class VoiceUriCache {
  constructor(private readonly settings: SettingsRepo) {}

  // Key includes model because DashScope voice IDs are model-bound:
  // cosyvoice-v3.5-plus and cosyvoice-v3-flash need separate enrollments.
  private key(cardId: CharacterCardId, providerConfigId: string, model: string): string {
    return `${VOICE_URI_KEY_PREFIX}.${cardId}.${providerConfigId}.${model}`;
  }

  get(cardId: CharacterCardId, providerConfigId: string, model: string): string | null {
    const val = this.settings.get(this.key(cardId, providerConfigId, model));
    return typeof val === 'string' ? val : null;
  }

  set(cardId: CharacterCardId, providerConfigId: string, model: string, uri: string): void {
    this.settings.set(this.key(cardId, providerConfigId, model), uri);
  }

  delete(cardId: CharacterCardId, providerConfigId: string, model: string): void {
    this.settings.delete(this.key(cardId, providerConfigId, model));
  }
}

// ── Voice resolution (orchestrator-layer concern) ───────────────────────────

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

  const profile: CharacterVoiceProfile = c.voiceProfile;
  const primary = pickPrimaryRefAudio(profile);
  if (!primary) return null;

  return {
    refAudioPath: resolveVoiceRefPath(primary.refAudioPath),
    promptText:   primary.promptText,
    promptLang:   primary.promptLang,
    // voiceUri is populated later by ensureVoiceUri (lazy upload or cache hit)
  };
}

/**
 * Populate voiceUri on a TtsVoiceRef.
 *
 * Priority:
 *   1. VoiceUriCache (persisted per card+provider) — skip re-upload
 *   2. adapter.uploadVoice() — upload reference audio to provider
 *   3. If adapter has no uploadVoice (e.g. DashScope in V1), leave voiceUri
 *      empty — caller must handle (the voice was manually configured).
 *
 * On success, writes the URI to the cache so subsequent turns skip upload.
 */
export async function ensureVoiceUri(
  voice:            TtsVoiceRef,
  adapter:          TtsAdapter,
  model:            string,
  cardId:           CharacterCardId,
  providerConfigId: string,
  cache:            VoiceUriCache,
): Promise<TtsVoiceRef> {
  if (voice.voiceUri) return voice;

  // 1. Check cache (keyed by card + provider + model — DashScope is model-bound)
  const cached = cache.get(cardId, providerConfigId, model);
  if (cached) {
    voice.voiceUri = cached;
    return voice;
  }

  // 2. Upload
  if (!adapter.uploadVoice) {
    return voice; // adapter doesn't support upload (e.g. gpt-sovits-tts uses refAudioPath)
  }

  const uri = await adapter.uploadVoice(
    voice.refAudioPath,
    voice.promptText,
    voice.promptLang,
    model,
  );
  voice.voiceUri = uri;
  cache.set(cardId, providerConfigId, model, uri);
  return voice;
}

function pickPrimaryRefAudio(profile: CharacterVoiceProfile | null) {
  if (!profile || profile.refAudios.length === 0) return null;
  if (profile.primaryId) {
    const found = profile.refAudios.find((r) => r.id === profile.primaryId);
    if (found) return found;
  }
  return profile.refAudios[0]!;
}

// ── Top-level builder ───────────────────────────────────────────────────────

export interface BuildTtsClientArgs {
  profileDb: Database;
}

export function buildTtsClient(args: BuildTtsClientArgs): TtsClient {
  return new TtsClient(loadTtsProviderConfigs(args.profileDb));
}

/**
 * Re-fetch TTS configs from DB and swap into the live TtsClient.
 * Call after PUT /api/providers/:id (tts capability) or
 * PUT /api/model-bindings/:module (tts_* rows).
 */
export function reloadTtsClient(client: TtsClient, profileDb: Database): void {
  client.reload(loadTtsProviderConfigs(profileDb));
}
