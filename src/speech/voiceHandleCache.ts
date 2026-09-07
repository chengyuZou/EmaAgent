// 在当前进程内缓存云端声音标识，避免每句话重复上传参考音频。
import type {
  TtsProviderVoice,
  TtsVoice,
  TtsVoiceReference,
  TtsVoiceRegistrar,
} from '@ema-agent/tts';

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

  /** 本地声音直接使用；云端声音按参考资源版本、Provider 和模型在当前进程复用。 */
  async prepare(request: PrepareSpeechVoiceRequest): Promise<TtsVoice> {
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
