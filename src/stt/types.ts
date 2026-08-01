import type { UsageContext } from '@ema-agent/usage';
import type { SttProtocol } from '@ema-agent/provider';

/** V1 不做 STT 流式能力探测。 */

export type { SttProtocol } from '@ema-agent/provider';

export interface SttRequest {
  /** provider_configs.id UUID - 用哪个 adapter 实例。 */
  providerId:   string;
  /** provider 期望的模型名(如 "whisper-1")。 */
  model:        string;
  audio:        Uint8Array;
  mime:         string;
  language?:    string;
  abortSignal?: AbortSignal;
  usageContext?: UsageContext;
}

export interface SttLimits {
  maxAudioBytes: number;
  timeoutMs: number;
}

// ── STT 响应 ──────────────────────────────────────────────────────────────────

export interface SttResponse {
  text:      string;
  segments?: SttSegment[];
}

export interface SttSegment {
  startMs: number;
  endMs:   number;
  text:    string;
}

// ── Provider 配置 ─────────────────────────────────────────────────────────────

export interface SttProviderConfig {
  /** 对应 profile.db 的 provider_configs.id */
  id:       string;
  protocol: SttProtocol;
  apiKey:   string;
  baseUrl:  string;
}

// ── Adapter 调用参数 ─────────────────────────────────────────────────────────

/**
 * Adapter 实际接收的内容。路由字段(providerId)由 SttRuntime 剥离 -
 * adapter 无需知道自己属于哪个 provider。
 */
export interface SttAdapterCall {
  audio:        Uint8Array;
  mime:         string;
  model:        string;
  language?:    string;
  abortSignal?: AbortSignal;
}

// ── 健康检查 ──────────────────────────────────────────────────────────────────

export interface SttProviderHealth {
  providerId: string;
  protocol:   SttProtocol;
  ok:         boolean;
  reason?:    string;
}

export interface SttHealthResult {
  ok:        boolean;
  providers: SttProviderHealth[];
}

// ── 实时探测 ──────────────────────────────────────────────────────────────────

export interface SttProbeResult {
  providerId: string;
  ok:         boolean;
  latencyMs?: number;
  /** ok=false 时存在。 */
  error?:     string;
}

// ── Adapter 契约 ──────────────────────────────────────────────────────────────

export interface SttAdapter {
  readonly protocol: SttProtocol;
  /**
   * 转录音频。实现应尊重 `abortSignal`,并把 provider 错误作为带描述信息
   * 的抛出 Error 上报。
   */
  transcribe(call: SttAdapterCall): Promise<SttResponse>;

  probe?(signal?: AbortSignal): Promise<Omit<SttProbeResult, 'providerId'>>;
}
