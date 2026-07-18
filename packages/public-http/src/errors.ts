// 定义公网 HTTP 出口的策略、体积和响应状态错误。
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
    this.status = status;
    this.statusText = statusText;
    this.url = sanitizeUrlForLog(url);
  }
}

/** 日志中的 URL 去掉 query 和 hash——里面可能带 API key/token。 */
function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid-url)';
  }
}
