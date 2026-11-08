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
  /** 同一 Provider 换模型必须重新注册, 云端声音 ID 绑定目标模型. */
  readonly modelId: string;
  readonly signal?: AbortSignal;
}

export class VoiceRegistrationCache {
  /** 只缓存注册成功的云端声音, 在当前进程内按角色资源版本和模型复用. */
  private readonly registeredVoices = new Map<string, TTSProviderVoice>();

  /** 本地参考声音不缓存, 每次交给当前 Provider 的 registrar 检查和返回. */
  async prepare(request: PrepareSpeechVoiceRequest): Promise<TTSVoice> {
    const key = voiceKey(request);
    const cached = this.registeredVoices.get(key);
    if (cached) return { ...cached };
    const voice = await request.ttsVoiceRegistrar(request.reference, request.signal);
    if (voice.kind === 'provider') this.registeredVoices.set(key, voice);
    return { ...voice };
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
