// 这里定义 WebFetchTool 可以稳定识别和测试的网络安全与资源边界错误。
export class WebFetchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchPolicyError';
  }
}

export class WebFetchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchLimitError';
  }
}

export class WebFetchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = 'WebFetchHttpError';
  }
}
