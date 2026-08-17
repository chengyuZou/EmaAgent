// 在当前进程内缓存云端声音标识，避免每句话重复上传参考音频。
import type {
  TextToSpeech,
  TtsProviderVoice,
  TtsVoice,
  TtsVoiceReference,
} from '@ema-agent/tts';

const DEFAULT_EPHEMERAL_TTL_MS = 2 * 60_000;

export interface SpeechVoiceCacheOptions {
  readonly ephemeralTtlMs?: number;
  readonly now?: () => number;
}

export class SpeechVoiceCache {
  private readonly entries = new Map<string, TtsProviderVoice>();
  private readonly ephemeralTtlMs: number;
  private readonly now: () => number;

  constructor(options: SpeechVoiceCacheOptions = {}) {
    this.ephemeralTtlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(cardId: string, providerId: string, model: string): TtsProviderVoice | null {
    const key = voiceKey(cardId, providerId, model);
    const voice = this.entries.get(key);
    if (!voice) return null;
    if (voice.expiresAt !== undefined && voice.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return { ...voice };
  }

  set(
    cardId: string,
    providerId: string,
    model: string,
    voice: TtsProviderVoice,
  ): TtsProviderVoice {
    const normalized = voice.lifetime === 'durable'
      ? { kind: 'provider' as const, id: voice.id, lifetime: 'durable' as const }
      : {
          kind: 'provider' as const,
          id: voice.id,
          lifetime: 'ephemeral' as const,
          expiresAt: voice.expiresAt ?? this.now() + this.ephemeralTtlMs,
        };
    this.entries.set(voiceKey(cardId, providerId, model), normalized);
    return { ...normalized };
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 本地声音直接使用；云端声音按角色、Provider 和模型短期复用。 */
export async function prepareSpeechVoice(
  reference: TtsVoiceReference,
  textToSpeech: TextToSpeech,
  model: string,
  cardId: string,
  providerId: string,
  cache: SpeechVoiceCache,
  signal?: AbortSignal,
): Promise<TtsVoice> {
  const cached = cache.get(cardId, providerId, model);
  if (cached) return cached;
  const voice = await textToSpeech.prepareVoice(reference, model, signal);
  return voice.kind === 'provider'
    ? cache.set(cardId, providerId, model, voice)
    : voice;
}

function voiceKey(cardId: string, providerId: string, model: string): string {
  return `${cardId}\u0000${providerId}\u0000${model}`;
}
