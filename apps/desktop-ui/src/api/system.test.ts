/**
 * system.test.ts — systemApi.getCapabilities 的 fail-closed 契约。
 *
 * 任何异常(网络抛错 / 响应体缺字段)都必须归一成 FEATURES_DISABLED,
 * 绝不让未完成功能入口因加载异常漏出来。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// sidecarClient.request 是唯一出网点,mock 掉。
vi.mock('./sidecar-client.js', () => ({
  sidecarClient: { request: vi.fn() },
}));

import { systemApi, FEATURES_DISABLED } from './system.js';
import { sidecarClient } from './sidecar-client.js';

const mockedRequest = vi.mocked(sidecarClient.request);

describe('systemApi.getCapabilities (fail-closed)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockedRequest.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('正常返回时透传 features', async () => {
    mockedRequest.mockResolvedValueOnce({
      release: 'v1',
      features: { artifacts: true },
    });
    const body = await systemApi.getCapabilities();
    expect(body.features.artifacts).toBe(true);
    expect(body.release).toBe('v1');
  });

  it('request 抛错时返回 FEATURES_DISABLED(不抛)', async () => {
    mockedRequest.mockRejectedValueOnce(new Error('sidecar unreachable'));
    const body = await systemApi.getCapabilities();
    expect(body.features.artifacts).toBe(false);
    expect(body.features).toEqual(FEATURES_DISABLED);
  });

  it('响应体缺 features 字段时返回 FEATURES_DISABLED', async () => {
    mockedRequest.mockResolvedValueOnce({ release: 'v1' } as unknown);
    const body = await systemApi.getCapabilities();
    expect(body.features.artifacts).toBe(false);
    expect(body.features).toEqual(FEATURES_DISABLED);
  });

  it('响应体为 null 时返回 FEATURES_DISABLED', async () => {
    mockedRequest.mockResolvedValueOnce(null as unknown);
    const body = await systemApi.getCapabilities();
    expect(body.features.artifacts).toBe(false);
  });
});
