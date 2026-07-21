// 将 fetch、HTTP 状态和 WebSocket close code 归一为稳定的 TTS 错误码。

import type { TtsErrorCode } from './types.js';
import type { TtsStreamEvent } from './types.js';

/**
 * 构造一个 error 类型的 TtsStreamEvent。
 * adapter 用它把 classify 出的 code + message 包成可 yield 的事件。
 */
export function errorEvent(code: TtsErrorCode, message: string): TtsStreamEvent {
  return { type: 'error', code, message };
}

/**
 * 把 fetch 抛的错误归一成 TtsErrorCode。
 * AbortError（超时/取消）-> transient_timeout；其他网络错误 -> transient_network。
 */
export function classifyFetchError(err: unknown): TtsErrorCode {
  const name = (err as { name?: string }).name;
  if (name === 'AbortError') return 'transient_timeout';
  return 'transient_network';
}

export function classifyProbeFailure(err: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) {
    if (signal.reason === 'aborted') return 'tts/aborted';
    if (signal.reason === 'timeout') return 'tts/transient_timeout';
  }
  return `tts/${classifyFetchError(err)}`;
}

/**
 * 把 HTTP 响应状态码归一成 TtsErrorCode。
 * 401/403 -> 凭证错；400/422 -> 请求错；404 -> 模型不支持；
 * 408/429 -> 超时(可重试)；5xx -> 服务器错(可重试)；其他 -> unknown。
 */
export function classifyHttpStatus(status: number): TtsErrorCode {
  if (status === 401 || status === 403) return 'permanent_credentials';
  if (status === 400 || status === 422) return 'permanent_bad_request';
  if (status === 404)                   return 'permanent_unsupported_model';
  if (status === 408 || status === 429) return 'transient_timeout';
  if (status >= 500)                    return 'transient_server';
  return 'unknown';
}

/**
 * 把 WebSocket close code 归一成 TtsErrorCode。
 * 1000 正常关闭；1006 网络异常关闭；1008 策略违规(请求错)；
 * 4001/4003 凭证错；其他 -> 服务器错(可重试)。
 */
export function classifyCloseCode(code: number): TtsErrorCode {
  if (code === 1000) return 'unknown';               // normal close
  if (code === 1006) return 'transient_network';     // abnormal close (network)
  if (code === 1008) return 'permanent_bad_request'; // policy violation
  if (code === 4001 || code === 4003) return 'permanent_credentials';
  return 'transient_server';
}
