import type {
  TTSProviderVoice,
  TTSVoice,
  TTSVoiceReference,
  TTSVoiceRegistrar,
} from '@ema-agent/tts';

/** registrar 已由调用方绑定本次 Provider 连接和模型. */
export interface PrepareSpeechVoiceRequest {
  readonly reference: TTSVoiceReference;
  readonly ttsVoiceRegistrar: TTSVoiceRegistrar;
  readonly characterName: string;
  readonly providerId: string;
  /** 缓存键组成:同一 Provider 换模型必须重新注册(云端注册绑定目标模型). */
  readonly modelId: string;
  readonly signal?: AbortSignal;
}

export class SpeechVoiceCache {
  private readonly entries = new Map<string, TTSProviderVoice>();

  /** 本地声音直接使用;云端声音按参考资源版本,Provider 和模型在当前进程复用. */
  async prepare(request: PrepareSpeechVoiceRequest): Promise<TTSVoice> {
    const key = voiceKey(request);
    const cached = this.entries.get(key);
    if (cached) return { ...cached };
    const voice = await request.ttsVoiceRegistrar(request.reference, request.signal);
    if (voice.kind === 'provider') this.entries.set(key, voice);
    return { ...voice };
  }

  clear(): void {
    this.entries.clear();
  }
}

function voiceKey(request: PrepareSpeechVoiceRequest): string {
  return JSON.stringify([
    request.characterName,
    request.reference.resourceName,
    request.reference.resourceUpdatedAt,
    request.providerId,
    request.modelId,
  ]);
}
