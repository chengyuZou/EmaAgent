import type { UsageContext } from '@ema-agent/usage';
import type { SttProtocol } from '@ema-agent/provider';

// 重新导出 protocol 枚举,消费者只从此包 import
export type { SttProtocol } from '@ema-agent/provider';

// ── 公共 STT 请求(Facade 入口)────────────────────────────────────────────
//
// 定义在此(不在 contracts)- 与 @ema-agent/llm 的 LlmRequest 对称。
// 调用方在调用 SttRuntime 前从 model_bindings 解析 providerId + model。
// Runtime 只执行明确指定的 Provider 和模型。

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

/** Facade 级硬限制。V1 不做 STT 流式能力探测。 */
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
  /**
   * 实时探测 - 用一次轻量真实 API 调用验证凭证(无需上传音频)。
   * 供设置页"测试连接"按钮用。未实现时 SttRuntime.probe() 返回稳定失败码。
   */
  probe?(signal?: AbortSignal): Promise<Omit<SttProbeResult, 'providerId'>>;
}
