// 在 Provider 明确拒绝可选参数时执行有界降级，不删除用户消息或附件。
import type { LlmAdapter } from './adapters/base.js';
import type { LlmRequest, LlmStreamChunk } from './types.js';

interface ProviderErrorShape {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

export interface CompatibilityRecoveryController {
  start(): AsyncIterable<LlmStreamChunk>;
  recover(error: unknown, nextAttempt: number): LlmStreamChunk | undefined;
}

/**
 * 只恢复 Provider 明确拒绝的可选参数。媒体由预检视图负责；此处无法可靠区分
 * 本轮附件和历史附件，因此绝不盲删内容。总尝试次数由 LlmStreamRuntime 统一限制。
 */
export function createCompatibilityRecovery(
  adapter: LlmAdapter,
  initialRequest: LlmRequest,
): CompatibilityRecoveryController {
  let request = { ...initialRequest };
  const removed = new Set<string>();

  return {
    start: () => adapter.stream(request, request.model),
    recover: (error, nextAttempt) => {
      const parameter = rejectedOptionalParameter(error, request, removed);
      if (!parameter) return undefined;
      removed.add(parameter);
      request = omitOptionalParameter(request, parameter);
      return {
        type: 'request_degraded',
        attempt: nextAttempt,
        reason: `Provider 明确拒绝可选参数 "${parameter}"，已省略后重试`,
        removed: ['parameter'],
        replacements: ['parameter_omitted'],
      };
    },
  };
}

function rejectedOptionalParameter(
  error: unknown,
  request: LlmRequest,
  removed: ReadonlySet<string>,
): 'temperature' | 'thinking' | 'toolChoice' | undefined {
  const shape = error && typeof error === 'object' ? error as ProviderErrorShape : undefined;
  const status = numberValue(shape?.status) || numberValue(shape?.statusCode);
  if (status !== 400 && status !== 422) return undefined;

  const message = [
    error instanceof Error ? error.message : '',
    stringValue(shape?.error?.message),
    stringValue(shape?.code),
    stringValue(shape?.error?.code),
  ].join(' ').toLowerCase();
  if (!/(unsupported|unknown|unrecognized|invalid|not\s+support)/.test(message)) return undefined;

  if (request.temperature !== undefined && !removed.has('temperature') && /temperature/.test(message)) {
    return 'temperature';
  }
  if (
    request.thinking !== undefined
    && !removed.has('thinking')
    && /(thinking|reasoning[_ -]?(?:effort|budget)?)/.test(message)
  ) {
    return 'thinking';
  }
  if (request.toolChoice !== undefined && !removed.has('toolChoice') && /tool[_ -]?choice/.test(message)) {
    return 'toolChoice';
  }
  return undefined;
}

function omitOptionalParameter(
  request: LlmRequest,
  parameter: 'temperature' | 'thinking' | 'toolChoice',
): LlmRequest {
  const next = { ...request };
  delete next[parameter];
  return next;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
