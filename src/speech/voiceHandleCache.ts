// 在当前进程内缓存云端声音标识，避免每句话重复上传参考音频。
import type {
  TtsProviderVoice,
  TtsVoice,
  TtsVoiceReference,
  TtsVoiceRegistrar,
} from '@ema-agent/tts';

const DEFAULT_EPHEMERAL_TTL_MS = 2 * 60_000;

export interface SpeechVoiceCacheOptions {
  readonly ephemeralTtlMs?: number;
  readonly now?: () => number;
}

/** get-or-register 的输入；registrar 的连接与模型已在装配层创建点冻结。 */
export interface PrepareSpeechVoiceRequest {
  readonly reference: TtsVoiceReference;
  readonly ttsVoiceRegistrar: TtsVoiceRegistrar;
  readonly characterName: string;
  readonly providerId: string;
  /** 缓存键组成：同一 Provider 换模型必须重新注册（云端注册绑定目标模型）。 */
  readonly modelId: string;
  readonly signal?: AbortSignal;
}

export class SpeechVoiceCache {
  private readonly entries = new Map<string, TtsProviderVoice>();
  private readonly ephemeralTtlMs: number;
  private readonly now: () => number;

  constructor(options: SpeechVoiceCacheOptions = {}) {
    this.ephemeralTtlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(characterName: string, providerId: string, modelId: string): TtsProviderVoice | null {
    const key = voiceKey(characterName, providerId, modelId);
    const voice = this.entries.get(key);
    if (!voice) return null;
    if (voice.expiresAt !== undefined && voice.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return { ...voice };
  }

  set(
    characterName: string,
    providerId: string,
    modelId: string,
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
    this.entries.set(voiceKey(characterName, providerId, modelId), normalized);
    return { ...normalized };
  }

  /** 本地声音直接使用；云端声音按角色、Provider 和模型短期复用。 */
  async prepare(request: PrepareSpeechVoiceRequest): Promise<TtsVoice> {
    const cached = this.get(request.characterName, request.providerId, request.modelId);
    if (cached) return cached;
    const voice = await request.ttsVoiceRegistrar(request.reference, request.signal);
    return voice.kind === 'provider'
      ? this.set(request.characterName, request.providerId, request.modelId, voice)
      : voice;
  }

  clear(): void {
    this.entries.clear();
  }
}

function voiceKey(characterName: string, providerId: string, modelId: string): string {
  return `${characterName} ${providerId} ${modelId}`;
}
