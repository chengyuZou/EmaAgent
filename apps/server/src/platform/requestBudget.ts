import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';

const MiB = 1024 * 1024;
const MAX_LIVE2D_PREVIEW_BYTES = 100 * MiB;

export type RequestBudgetId =
  | 'default-json'
  | 'turn'
  | 'audio-upload'
  | 'live2d-preview-upload'
  | 'wallpaper-upload';

export interface RequestBudgetPolicy {
  readonly id: RequestBudgetId;
  readonly maxTransportBytes: number;
}

/** 业务包仍须校验解码后的真实数据;这里只管传输层体积. */
export const REQUEST_BUDGETS = Object.freeze({
  defaultJson: Object.freeze({
    id: 'default-json',
    maxTransportBytes: 128 * MiB,
  }),
  turn: Object.freeze({
    id: 'turn',
    maxTransportBytes: 128 * MiB,
  }),
  audioUpload: Object.freeze({
    id: 'audio-upload',
    // 这是本机 multipart 传输额度, 外部语音服务仍按各协议自己的限制处理.
    maxTransportBytes: 256 * MiB,
  }),
  live2dPreviewUpload: Object.freeze({
    id: 'live2d-preview-upload',
    // PNG 经 base64 传输约增加三分之一, 额外留出 JSON 字段的空间.
    maxTransportBytes: Math.ceil(MAX_LIVE2D_PREVIEW_BYTES / 3) * 4 + 1024,
  }),
  wallpaperUpload: Object.freeze({
    id: 'wallpaper-upload',
    maxTransportBytes: 256 * MiB,
  }),
} satisfies Record<string, RequestBudgetPolicy>);

/** 解析后的集合与文本预算;路由只引用命名字段,不各自保存匿名数字. */
export const REQUEST_VALUE_LIMITS = Object.freeze({
  maxLive2dPreviewBytes: MAX_LIVE2D_PREVIEW_BYTES,
  maxTurnTextChars: 1_000_000,
  maxTurnContentParts: 64,
  maxTurnAttachments: 64,
  maxTTSPreviewTextChars: 2_000,
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
  const normalizedMethod = method.toUpperCase();
  if (!BODY_METHODS.has(normalizedMethod)) return null;

  const normalizedPath = path.length > 1 ? path.replace(/\/$/, '') : path;
  if (
    (normalizedMethod === 'POST'
      && /^\/api\/characters\/[^/]+\/live2d\/imports\/[^/]+\/commit$/.test(normalizedPath))
    || (normalizedMethod === 'PUT'
      && /^\/api\/characters\/[^/]+\/live2d\/[^/]+\/preview$/.test(normalizedPath))
  ) {
    return REQUEST_BUDGETS.live2dPreviewUpload;
  }
  if (normalizedPath === '/api/turns') return REQUEST_BUDGETS.turn;
  if (normalizedPath === '/api/providers/transcribe') return REQUEST_BUDGETS.audioUpload;
  if (normalizedPath === '/api/settings/wallpaper/images') return REQUEST_BUDGETS.wallpaperUpload;
  if (/^\/api\/characters\/[^/]+\/voice\/publish$/.test(normalizedPath)) {
    return REQUEST_BUDGETS.audioUpload;
  }
  return REQUEST_BUDGETS.defaultJson;
}

/** 全局安装一次;路由不各自保存 byte 常量. */
export function requestBudgetMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    const policy = resolveRequestBudget(context.req.method, context.req.path);
    if (!policy) return next();

    return bodyLimit({
      maxSize: policy.maxTransportBytes,
      onError: current => current.json({
        error: 'payload_too_large',
        message: `请求体超过 ${policy.maxTransportBytes} 字节限制`,
        budget: policy.id,
        maxBytes: policy.maxTransportBytes,
      }, 413),
    })(context, next);
  };
}
