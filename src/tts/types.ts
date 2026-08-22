import type { TtsProtocol } from '@ema-agent/providers';

export type { TtsProtocol } from '@ema-agent/providers';

/** Provider 已解析好的 TTS 协议连接。 */
export interface TtsConnection {
  readonly protocol: TtsProtocol;
  /** 本地 GPT-SoVITS 可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export type TtsAudioFormat = 'mp3' | 'pcm' | 'wav' | 'opus';

/** 角色包提供的本地参考音频；TTS 只读取它，不拥有角色语义。 */
export interface TtsVoiceReference {
  readonly kind: 'reference';
  readonly audioPath: string;
  readonly promptText: string;
  readonly promptLanguage: string;
}

/** 云端协议注册参考音频后返回的声音标识。 */
export interface TtsProviderVoice {
  readonly kind: 'provider';
  readonly id: string;
  /** 未明确保证长期有效的声音标识只能进入进程内缓存。 */
  readonly lifetime: 'ephemeral' | 'durable';
  readonly expiresAt?: number;
}

export type TtsVoice = TtsVoiceReference | TtsProviderVoice;

/** 单次文本转语音请求；模型在创建点冻结，切句、超时、重试和归档均由上层拥有。 */
export interface TtsRequest {
  readonly text: string;
  readonly voice: TtsVoice;
  readonly format?: TtsAudioFormat;
  readonly sampleRate?: number;
  readonly speed?: number;
  readonly signal?: AbortSignal;
}

/**
 * 逐句合成调用：执行一次协议合成，返回以唯一 done 结束的中立音频流。
 * 由 createTtsCall(connection, modelId) 创建，连接与模型在创建点冻结；
 * voice 是 TtsVoiceRegistrar 的异步产出，创建时尚不存在，因此随请求传入。
 */
export type CallTts = (request: TtsRequest) => AsyncIterable<TtsStreamEvent>;

/**
 * 音色注册调用：本地协议直通参考音频，云端协议上传注册并返回声音标识。
 * 由 createTtsVoiceRegistrar(connection, modelId) 创建，连接与目标模型在创建点冻结。
 */
export type TtsVoiceRegistrar = (
  reference: TtsVoiceReference,
  signal?: AbortSignal,
) => Promise<TtsVoice>;

export type TtsStreamEvent =
  | {
      readonly type: 'audio_chunk';
      readonly bytes: Uint8Array<ArrayBufferLike>;
      readonly mime: string;
    }
  | {
      readonly type: 'done';
      readonly totalBytes: number;
      readonly firstByteMs: number;
    };

/** 私有协议实现交给两个创建入口的执行形状；模型随创建点冻结进闭包。 */
export interface TtsProtocolImplementation {
  prepareVoice(
    reference: TtsVoiceReference,
    signal?: AbortSignal,
  ): Promise<TtsVoice>;
  synthesize(request: TtsRequest): AsyncIterable<TtsStreamEvent>;
}
