import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';

const MiB = 1024 * 1024;

export type RequestBudgetId =
  | 'default-json'
  | 'turn'
  | 'audio-upload'
  | 'session-import';

export interface RequestBudgetPolicy {
  readonly id: RequestBudgetId;
  readonly maxTransportBytes: number;
}

/**
 * Core HTTP 入口的传输预算。业务包仍须校验解码后的真实数据；这里负责在
 * Hono 解析 JSON、multipart 或 Base64 字符串前挡住无界请求体。
 */
export const REQUEST_BUDGETS = Object.freeze({
  defaultJson: Object.freeze({
    id: 'default-json',
    maxTransportBytes: 20 * MiB,
  }),
  turn: Object.freeze({
    id: 'turn',
    maxTransportBytes: 32 * MiB,
  }),
  audioUpload: Object.freeze({
    id: 'audio-upload',
    // STT/角色语音的业务上限是 25 MiB；额外空间留给 multipart 元数据。
    maxTransportBytes: 26 * MiB,
  }),
  sessionImport: Object.freeze({
    id: 'session-import',
    // ZIP 本体由 Backup Facade 再按 256 MiB 复核。
    maxTransportBytes: 257 * MiB,
  }),
} satisfies Record<string, RequestBudgetPolicy>);

/** 解析后的集合和文本预算；Route 只引用命名字段，不保存匿名数字。 */
export const REQUEST_VALUE_LIMITS = Object.freeze({
  maxTurnTextChars: 1_000_000,
  maxTurnContentParts: 64,
  maxTurnAttachments: 64,
  maxTurnKbIds: 128,
  maxTurnKbAssetScopes: 128,
  maxCardVoiceFileBytes: 25 * MiB,
  maxCardVoicePromptChars: 4_000,
  maxTtsTestTextChars: 2_000,
});

export const HTTP_SERVER_TIMEOUTS = Object.freeze({
  headersMs: 30_000,
  requestBodyMs: 120_000,
});

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function resolveRequestBudget(
  method: string,
  path: string,
): RequestBudgetPolicy | null {
  if (!BODY_METHODS.has(method.toUpperCase())) return null;

  const normalizedPath = path.length > 1 ? path.replace(/\/$/, '') : path;
  if (normalizedPath === '/api/turns') return REQUEST_BUDGETS.turn;
  if (normalizedPath === '/api/transcribe') return REQUEST_BUDGETS.audioUpload;
  if (normalizedPath === '/api/storage/sessions/import') return REQUEST_BUDGETS.sessionImport;
  if (/^\/api\/cards\/[^/]+\/voice-refs$/.test(normalizedPath)) {
    return REQUEST_BUDGETS.audioUpload;
  }
  return REQUEST_BUDGETS.defaultJson;
}

/** 全局安装一次；Route 只负责协议适配，不各自保存 byte 常量。 */
export function requestBudgetMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    const policy = resolveRequestBudget(context.req.method, context.req.path);
    if (!policy) return next();

    return bodyLimit({
      maxSize: policy.maxTransportBytes,
      onError: (current) => current.json({
        error: 'payload_too_large',
        message: `请求体超过 ${policy.maxTransportBytes} 字节限制`,
        budget: policy.id,
        maxBytes: policy.maxTransportBytes,
      }, 413),
    })(context, next);
  };
}
