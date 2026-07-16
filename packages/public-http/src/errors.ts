// 这里定义公网 HTTP 出口会返回的策略, 体积和响应状态错误.
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
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = 'PublicHttpStatusError';
  }
}
