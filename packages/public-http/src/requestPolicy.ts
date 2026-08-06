// 统一收口公网请求的参数约束和请求头白名单。
import { PublicHttpPolicyError } from './errors.js';

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 5;

const CALLER_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
]);

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'range',
  'if-range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正整数`);
  }
}

export function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} 必须是非负整数`);
  }
}

export function assertSensitiveHeaderRedirectPolicy(
  additionalAllowedHeaders: readonly string[] | undefined,
  maxRedirects: number,
): void {
  if ((additionalAllowedHeaders?.length ?? 0) > 0 && maxRedirects !== 0) {
    throw new PublicHttpPolicyError('携带额外敏感请求头时必须禁用自动重定向');
  }
}

/** 调用方只能发送明确放行的内容头; Range/If-Range 属下载语义, 一律禁止。 */
export function buildRequestHeaders(
  callerHeaders: Readonly<Record<string, string>> | undefined,
  additionalAllowedHeaders?: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept-Encoding': 'identity',
    'User-Agent': 'EmaAgent/1.0',
  };
  const allowed = additionalAllowedHeaders && additionalAllowedHeaders.length > 0
    ? new Set([
        ...CALLER_HEADER_ALLOWLIST,
        ...additionalAllowedHeaders
          .map(name => name.toLowerCase())
          .filter(name => !FORBIDDEN_REQUEST_HEADERS.has(name)),
      ])
    : CALLER_HEADER_ALLOWLIST;

  for (const [name, value] of Object.entries(callerHeaders ?? {})) {
    if (allowed.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

/** 调用方是否发送了条件验证头; 304 只有在存在验证头时才可解释为"未修改"。 */
export function hasConditionalRequestHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some(name => {
    const normalized = name.toLowerCase();
    return normalized === 'if-none-match' || normalized === 'if-modified-since';
  });
}
