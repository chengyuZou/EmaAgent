import type { TtsProtocol } from '@ema-agent/providers';

export type { TtsProtocol } from '@ema-agent/providers';

export interface TtsConnection {
  readonly protocol: TtsProtocol;
  /** 本地 GPT-SoVITS 可以不需要凭据 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 音频块固定为交错的 signed PCM16LE, 不携带容器文件头. */
export interface PcmAudioFormat {
  /** 每秒每声道的采样数, 单位 Hz. 描述实际输出, 不要求所有协议使用相同数值. */
  readonly sampleRate: number;
  /** 1 表示一份声音; 2 表示左右两份声音, 每一帧依次存放左、右各一个采样. */
  readonly channelCount: number;
}

/** 当前角色选用的参考音频及对应文本, 用于本地合成或云端音色注册. */
export interface TtsVoiceReference {
  readonly kind: 'reference';
  /** 角色资源的完整文件名, 与更新时间共同标识当前参考音频版本. */
  readonly resourceName: string;
  readonly resourceUpdatedAt: number;
  /** 云端注册名称, 由拥有角色语义的装配层生成, 不从文件路径反推. */
  readonly registrationName: string;
  readonly audioPath: string;
  readonly promptText: string;
  readonly promptLanguage: string;
}

/** 云端协议注册参考音频后返回的声音标识 */
export interface TtsProviderVoice {
  readonly kind: 'provider';
  readonly id: string;
}

export type TtsVoice = TtsVoiceReference | TtsProviderVoice;

/** 单次文本转语音请求. 参考音频注册由 TtsVoiceRegistrar 单独完成. */
export interface TtsRequest {
  readonly text: string;
  readonly voice: TtsVoice;
  readonly speed?: number;
  readonly signal?: AbortSignal;
}

/**
 * 执行一次协议合成, 返回 PCM 格式、音频块和最终的 done.
 * createTtsCall 固定连接与模型; voice 由 TtsVoiceRegistrar 提供, 随请求传入.
 */
export type CallTts = (request: TtsRequest) => AsyncIterable<TtsStreamEvent>;

/**
 * 本地协议直接返回参考音频, 云端协议上传注册并返回声音标识.
 * createTtsVoiceRegistrar 固定连接与目标模型, 不执行文本合成.
 */
export type TtsVoiceRegistrar = (
  reference: TtsVoiceReference,
  signal?: AbortSignal,
) => Promise<TtsVoice>;

export type TtsStreamEvent =
  | ({ readonly type: 'audio_started' } & PcmAudioFormat)
  | {
      readonly type: 'audio_chunk';
      readonly bytes: Uint8Array<ArrayBufferLike>;
    }
  | {
      readonly type: 'done';
      /** 已交付的 PCM 字节数, 不包括 WAV 等容器文件头. */
      readonly totalBytes: number;
      /** 从合成请求开始到首个 PCM 字节的毫秒数, 包括供应商响应和读取格式的等待. */
      readonly firstByteMs: number;
    };

/** 两个创建入口使用的内部协议实现, 模型由创建点固定. */
export interface TtsProtocolImplementation {
  prepareVoice(
    reference: TtsVoiceReference,
    signal?: AbortSignal,
  ): Promise<TtsVoice>;
  synthesize(request: TtsRequest): AsyncIterable<TtsStreamEvent>;
}
