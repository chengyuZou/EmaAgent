// 在当前进程内缓存 Provider 声音句柄，并按 TTL 避免复用已经失效的上传结果。

import type { CharacterCardId } from '@ema-agent/ids';
import type {
  TtsAdapter,
  TtsProviderVoiceHandle,
  TtsVoiceRef,
} from './types.js';

const DEFAULT_EPHEMERAL_TTL_MS = 2 * 60_000;

export interface TtsVoiceHandleCacheOptions {
  ephemeralTtlMs?: number;
  now?: () => number;
}

export class TtsVoiceHandleCache {
  private readonly entries = new Map<string, TtsProviderVoiceHandle>();
  private readonly ephemeralTtlMs: number;
  private readonly now: () => number;

  constructor(options: TtsVoiceHandleCacheOptions = {}) {
    this.ephemeralTtlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(
    cardId: CharacterCardId,
    providerConfigId: string,
    model: string,
  ): TtsProviderVoiceHandle | null {
    const key = this.key(cardId, providerConfigId, model);
    const handle = this.entries.get(key);
    if (!handle) return null;
    if (isExpired(handle, this.now())) {
      this.entries.delete(key);
      return null;
    }
    return structuredClone(handle);
  }

  set(
    cardId: CharacterCardId,
    providerConfigId: string,
    model: string,
    handle: TtsProviderVoiceHandle,
  ): TtsProviderVoiceHandle {
    const normalized = normalizeHandle(handle, this.now(), this.ephemeralTtlMs);
    this.entries.set(this.key(cardId, providerConfigId, model), normalized);
    return structuredClone(normalized);
  }

  delete(cardId: CharacterCardId, providerConfigId: string, model: string): void {
    this.entries.delete(this.key(cardId, providerConfigId, model));
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Provider 和模型必须同时进入缓存键，防止切换中转站或声音空间后
   * 把旧句柄交给另一个服务。
   */
  private key(cardId: CharacterCardId, providerConfigId: string, model: string): string {
    return `${cardId}\u0000${providerConfigId}\u0000${model}`;
  }
}

export async function ensureProviderVoiceHandle(
  voice: TtsVoiceRef,
  adapter: TtsAdapter,
  model: string,
  cardId: CharacterCardId,
  providerConfigId: string,
  cache: TtsVoiceHandleCache,
  signal?: AbortSignal,
): Promise<TtsVoiceRef> {
  const now = Date.now();
  if (voice.providerVoice && !isExpired(voice.providerVoice, now)) return voice;

  const cached = cache.get(cardId, providerConfigId, model);
  if (cached) return { ...withoutProviderVoice(voice), providerVoice: cached };

  // GPT-SoVITS 等本地协议直接读取 refAudioPath，不需要上传声音。
  if (!adapter.uploadVoice) return withoutProviderVoice(voice);

  const uploaded = await adapter.uploadVoice(
    voice.refAudioPath,
    voice.promptText,
    voice.promptLang,
    model,
    signal,
  );
  const handle = cache.set(
    cardId,
    providerConfigId,
    model,
    uploaded,
  );
  return { ...withoutProviderVoice(voice), providerVoice: handle };
}

function normalizeHandle(
  handle: TtsProviderVoiceHandle,
  now: number,
  ephemeralTtlMs: number,
): TtsProviderVoiceHandle {
  if (handle.lifetime === 'durable') {
    return { value: handle.value, lifetime: 'durable' };
  }
  return {
    value: handle.value,
    lifetime: 'ephemeral',
    expiresAt: handle.expiresAt ?? now + ephemeralTtlMs,
  };
}

function isExpired(handle: TtsProviderVoiceHandle, now: number): boolean {
  return handle.lifetime === 'ephemeral'
    && handle.expiresAt !== undefined
    && handle.expiresAt <= now;
}

function withoutProviderVoice(voice: TtsVoiceRef): TtsVoiceRef {
  const localVoice = { ...voice };
  delete localVoice.providerVoice;
  return localVoice;
}
