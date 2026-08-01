// 测试 llm 流式运行时共享的 HTTP 状态提取与可重试分类。
import { describe, expect, it } from 'vitest';
import { httpStatus, isRetryable } from '../retry.js';

function httpErr(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('httpStatus', () => {
  it('优先读 status，回退 statusCode，都没有为 0', () => {
    expect(httpStatus(httpErr(429))).toBe(429);
    expect(httpStatus(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(503);
    expect(httpStatus(new Error('parse error'))).toBe(0);
  });
});

describe('isRetryable', () => {
  it('429 / 408 / 5xx 可重试', () => {
    expect(isRetryable(httpErr(429))).toBe(true);
    expect(isRetryable(httpErr(408))).toBe(true);
    expect(isRetryable(httpErr(500))).toBe(true);
    expect(isRetryable(httpErr(503))).toBe(true);
  });

  it('4xx 配置类故障与非 HTTP 错误不重试', () => {
    expect(isRetryable(httpErr(400))).toBe(false);
    expect(isRetryable(httpErr(401))).toBe(false);
    expect(isRetryable(httpErr(404))).toBe(false);
    expect(isRetryable(new Error('parse error'))).toBe(false);
  });
});
