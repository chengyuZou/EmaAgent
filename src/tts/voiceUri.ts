// 管理声音克隆 URI 的稳定缓存键，并在需要时上传角色参考音频。

import type { CharacterCardId } from '@ema-agent/ids';
import type { TtsAdapter, TtsVoiceRef } from './types.js';

const VOICE_URI_KEY_PREFIX = 'tts.voiceUri';

/** LocalHost 用 SettingsRepo 适配该端口，TTS 不直接依赖 Storage。 */
export interface TtsVoiceUriStore {
  get(key: string): unknown;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export class TtsVoiceUriCache {
  constructor(private readonly store: TtsVoiceUriStore) {}

  get(cardId: CharacterCardId, providerConfigId: string, model: string): string | null {
    const value = this.store.get(this.key(cardId, providerConfigId, model));
    return typeof value === 'string' ? value : null;
  }

  set(cardId: CharacterCardId, providerConfigId: string, model: string, uri: string): void {
    this.store.set(this.key(cardId, providerConfigId, model), uri);
  }

  delete(cardId: CharacterCardId, providerConfigId: string, model: string): void {
    this.store.delete(this.key(cardId, providerConfigId, model));
  }

  /**
   * DashScope 的声音 ID 与模型绑定；Provider 和模型必须同时进入缓存键，
   * 防止切换中转站或模型后把旧 URI 发给另一个服务。
   */
  private key(cardId: CharacterCardId, providerConfigId: string, model: string): string {
    return `${VOICE_URI_KEY_PREFIX}.${cardId}.${providerConfigId}.${model}`;
  }
}

export async function ensureVoiceUri(
  voice: TtsVoiceRef,
  adapter: TtsAdapter,
  model: string,
  cardId: CharacterCardId,
  providerConfigId: string,
  cache: TtsVoiceUriCache,
  signal?: AbortSignal,
): Promise<TtsVoiceRef> {
  if (voice.voiceUri) return voice;

  const cached = cache.get(cardId, providerConfigId, model);
  if (cached) {
    voice.voiceUri = cached;
    return voice;
  }

  // GPT-SoVITS 等本地协议直接读取 refAudioPath，不需要上传声音。
  if (!adapter.uploadVoice) return voice;

  const uri = await adapter.uploadVoice(
    voice.refAudioPath,
    voice.promptText,
    voice.promptLang,
    model,
    signal,
  );
  voice.voiceUri = uri;
  cache.set(cardId, providerConfigId, model, uri);
  return voice;
}
