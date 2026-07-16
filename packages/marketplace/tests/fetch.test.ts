// 这里测试市场镜像降级只发生在真实失败时, 调用方取消后不会继续请求镜像.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchPublicResource = vi.hoisted(() => vi.fn());
vi.mock('@ema-agent/public-http', () => ({ fetchPublicResource }));

import { fetchWithMirror } from '../src/fetch.js';

function response(url: string, body: string) {
  return {
    finalUrl: url,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: Buffer.from(body),
  };
}

beforeEach(() => {
  fetchPublicResource.mockReset();
});

describe('市场镜像下载', () => {
  it('主地址失败后使用镜像，并保留有界请求参数', async () => {
    fetchPublicResource
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce(response('https://mirror.example/index.json', '{}'));

    const result = await fetchWithMirror(
      'https://primary.example/index.json',
      'https://mirror.example/index.json',
      { maxBytes: 1234 },
    );

    expect(result.text()).toBe('{}');
    expect(fetchPublicResource).toHaveBeenCalledTimes(2);
    expect(fetchPublicResource.mock.calls[1]?.[1]).toMatchObject({ maxBytes: 1234 });
  });

  it('调用方取消后不再访问镜像', async () => {
    const controller = new AbortController();
    fetchPublicResource.mockImplementationOnce(async () => {
      controller.abort(new Error('用户取消'));
      throw controller.signal.reason;
    });

    await expect(fetchWithMirror(
      'https://primary.example/index.json',
      'https://mirror.example/index.json',
      { signal: controller.signal },
    )).rejects.toThrow('用户取消');
    expect(fetchPublicResource).toHaveBeenCalledTimes(1);
  });
});
