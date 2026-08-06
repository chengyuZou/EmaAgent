// 定义公网 HTTP 出口的策略、体积、超时和响应状态错误。
export class PublicHttpPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicHttpPolicyError';
  }
}

export class PublicHttpLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicHttpLimitError';
  }
}

export class PublicHttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${sanitizeUrlForLog(url)}`);
    this.name = 'PublicHttpStatusError';
    this.url = sanitizeUrlForLog(url);
  }
}

export class PublicHttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`公网请求超过 ${timeoutMs}ms 未完成`);
    this.name = 'PublicHttpTimeoutError';
  }
}

/** 错误和日志不保留 URL query/hash，避免泄漏签名和 token。 */
function sanitizeUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(invalid-url)';
  }
}
