import type { Database, ProviderConfigRow, ResolvedModelBinding } from '@ema-agent/storage';
import { ProvidersRepo, ModelBindingsRepo, SettingsRepo, ttsBindingModuleFor } from '@ema-agent/storage';

import {
  TtsClient,
  type TtsProviderConfig,
  type TtsModuleBinding,
  type VoiceProfileLookup,
  type VoiceRefPathResolver,
} from '@ema-agent/tts';

import {
  getProviderDefinition,
  isTtsProtocol,
  type CharacterCardId,
  type CharacterVoiceProfile,
  type TtsModule,
} from '@ema-agent/contracts';

import type { CharacterCardStore } from '@ema-agent/character-card';
import { resolveVoiceRefPath } from '../storage-locations/index.js';

// ── Settings key for the system fallback voice binding ──────────────────────
//
// The fallback binding fires when the primary TTS attempt fails for a turn
// (e.g. character has no refAudio AND its primary mode binding is
// clone-only, or the primary adapter errored before any audio went out).
// Lives in `settings.tts.fallback` rather than as a 4th model_bindings row,
// so it doesn't need a migration to add and the user can't accidentally
// confuse it with a per-mode binding in the UI.
export const TTS_FALLBACK_SETTINGS_KEY = 'tts.fallback';

interface FallbackSettings {
  providerConfigId: string;
  model:            string;
  voiceId:          string | null;
  config?:          Record<string, unknown>;
}

// ── Provider config builder (mirrors buildLlmProviderConfig in bindings.ts) ─

export function buildTtsProviderConfig(row: ProviderConfigRow): TtsProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('tts')) return null;

  const protocol = def.protocols.tts;
  if (!isTtsProtocol(protocol)) return null;

  // Local runtimes (GPT-SoVITS) declare requiresCredentials: false → empty key is fine.
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

// ── Binding loaders (one per TtsModule + the optional fallback) ─────────────

function toBinding(resolved: ResolvedModelBinding): TtsModuleBinding {
  return {
    providerConfigId: resolved.providerConfigId,
    model:            resolved.model,
    voiceId:          resolved.voiceId,
    config:           resolved.config,
  };
}

function loadPrimaryBindings(profileDb: Database): Map<TtsModule, TtsModuleBinding> {
  const repo = new ModelBindingsRepo(profileDb.sqlite);
  const out  = new Map<TtsModule, TtsModuleBinding>();
  for (const mode of ['chat', 'narrative', 'agent'] as const) {
    const row = repo.get(ttsBindingModuleFor(mode));
    if (row) out.set(mode, toBinding(row));
  }
  return out;
}

function loadFallbackBinding(profileDb: Database): TtsModuleBinding | undefined {
  const settings = new SettingsRepo(profileDb.sqlite);
  const stored   = settings.get(TTS_FALLBACK_SETTINGS_KEY) as FallbackSettings | undefined;
  if (!stored || typeof stored !== 'object') return undefined;
  return {
    providerConfigId: stored.providerConfigId,
    model:            stored.model,
    voiceId:          stored.voiceId,
    config:           stored.config ?? {},
  };
}

// ── Voice profile + ref-path Façades (decouple service from card/storage) ───
//
// `TtsClient` accepts thin Façade interfaces so the package doesn't need to
// import `@ema-agent/character-card` or `apps/core/storage-locations`. We
// build the concrete adapters here at wire time.

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

// ── Top-level builder (called once from buildBindings) ──────────────────────

export interface BuildTtsClientArgs {
  profileDb: Database;
  card:      CharacterCardStore;
}

export function buildTtsClient(args: BuildTtsClientArgs): TtsClient {
  return new TtsClient({
    providers:        loadTtsProviderConfigs(args.profileDb),
    primaryBindings:  loadPrimaryBindings(args.profileDb),
    fallbackBinding:  loadFallbackBinding(args.profileDb),
    voiceProfiles:    buildVoiceProfileLookup(args.card),
    refPathResolver:  buildRefPathResolver(),
  });
}
