import type { UsageContext } from '@ema-agent/contracts';
import type { TtsProtocol } from '@ema-agent/provider';

// 重新导出 TtsProtocol，调用方无需跨包拼装 Provider 协议类型。
export type { TtsProtocol } from '@ema-agent/provider';

// ── TTS 内部类型 ──────────────────────────────────────────────────────────────

/** 传给每次 synthesize 调用的已解析 voice 引用。 */
export interface TtsVoiceRef {
  /** 引用音频文件的 profile 作用域绝对路径。 */
  refAudioPath: string;
  /** 用于 voice cloning 的提示文本(部分 provider 允许空)。 */
  promptText:   string;
  /** 语言代码,如 'zh'、'en'。 */
  promptLang:   string;
  /**
   * Provider 分配的 voice URI。
   * openai-tts 和 dashscope-tts 必需 - 这两个 adapter 会检查,缺失时产出
   * `permanent_unsupported_voice_kind` 错误。
   * gpt-sovits-tts 忽略此字段,直接用 `refAudioPath`。
   *
   * 由 apps/core 的 `ensureVoiceUri()` 在 coordinator 启动前懒填。
   * 禁止在此硬编码值。
   */
  voiceUri?: string;
}

/** 向 adapter 请求的输出音频格式。 */
export type TtsAudioFormat = 'mp3' | 'pcm' | 'wav' | 'opus';

/** adapter 产出的粗粒度错误类别。 */
export type TtsErrorCode =
  | 'permanent_refaudio_missing'
  | 'permanent_credentials'
  | 'permanent_unsupported_voice_kind'
  | 'permanent_unsupported_model'
  | 'permanent_bad_request'
  | 'transient_network'
  | 'transient_timeout'
  | 'transient_server'
  | 'aborted'
  | 'resource_exhausted'
  | 'invalid_stream'
  | 'unknown';

/** 描述适配器当前真实交付方式，不根据模型名称猜测供应商能力。 */
export type TtsAudioDelivery = 'buffered' | 'http_chunks' | 'websocket_frames';

export interface TtsAdapterCapabilities {
  audioDelivery: TtsAudioDelivery;
  supportsAbort: boolean;
}

export interface TtsLimits {
  timeoutMsPerSentence: number;
  maxBytesPerSentence: number;
}

/** adapter 产出的 wire 事件。 */
export type TtsStreamEvent =
  | { type: 'audio_chunk';     bytes: Uint8Array<ArrayBufferLike>; mime: string }
  | { type: 'sentence_started'; index: number; text: string }
  | { type: 'sentence_done';    index: number; durationMs?: number }
  | { type: 'done';             totalBytes: number; firstByteMs: number }
  | { type: 'error';            code: TtsErrorCode; message: string };

// ── 公共 TTS 请求(Facade 入口)────────────────────────────────────────────
//
// 与 LlmRequest 模式对齐:纯数据,无业务语义。
// 调用方(TtsCoordinator / apps/core orchestrator)负责从角色卡解析 voice,
// 并在调 cloud adapter 的 synthesize 前确保 voiceUri 已填。

/**
 * 完全解析后的合成请求。
 *
 * `voice` 由 apps/core 从当前角色卡解析。
 * openai-tts 和 dashscope-tts 协议下,调 `synthesize()` 前必须填好
 * `voice.voiceUri`,否则 adapter 产出 `permanent_unsupported_voice_kind`。
 * gpt-sovits-tts 直接读 `voice.refAudioPath`,从不需要 voiceUri。
 */
export interface TtsRequest {
  providerId:   string;
  model:        string;
  text:         string;
  voice:        TtsVoiceRef;
  format?:      TtsAudioFormat;
  sampleRate?:  number;
  speed?:       number;
  abortSignal?: AbortSignal;
  usageContext?: UsageContext;
}

// ── Provider 配置(每协议的凭证与端点)────────────────────────────────────

export interface TtsProviderConfig {
  /** 对应 profile.db 的 provider_configs.id */
  id:       string;
  protocol: TtsProtocol;
  apiKey:   string;
  baseUrl:  string;
}

// ── 健康检查 ──────────────────────────────────────────────────────────────────

export interface TtsProviderHealth {
  providerId: string;
  protocol:   TtsProtocol;
  ok:         boolean;
  /** ok=false 时存在。 */
  reason?:    string;
}

export interface TtsHealthResult {
  ok:        boolean;
  providers: TtsProviderHealth[];
}

export interface TtsProbeResult {
  ok:        boolean;
  latencyMs?: number;
  error?:    string;
}

// ── Adapter 契约 ──────────────────────────────────────────────────────────────

export interface TtsAdapter {
  readonly protocol: TtsProtocol;

  /** 同一协议可按实现分支采用不同交付方式，例如 DashScope 的 Qwen/CosyVoice。 */
  capabilitiesFor(req: Pick<TtsRequest, 'model'>): TtsAdapterCapabilities;

  /**
   * 流式产出单个文本段的音频。
   * 接收完整 TtsRequest - 与 LlmAdapter.stream(LlmRequest) 对称。
   */
  stream(req: TtsRequest): AsyncIterable<TtsStreamEvent>;

  /**
   * 上传参考音频文件用于 voice cloning。
   * 返回一个 URI,后续 clone 调用可用作 `voiceUri`。
   * 并非所有 adapter 都支持 - 不支持的 adapter 抛错。
   */
  uploadVoice?(refAudioPath: string, promptText: string, promptLang: string, model: string): Promise<string>;

  /** 实时连通性检查。可选 - 缺失时 service 回退 ok=false。 */
  probe?(): Promise<Omit<TtsProbeResult, never>>;
}
