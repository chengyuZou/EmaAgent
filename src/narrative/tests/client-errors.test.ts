// 测试 Narrative Client 对整体不可用、单请求失败和损坏响应的错误分类。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NarrativeClient,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from '../index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NarrativeClient 错误分类', () => {
  it('503 表示 Bridge Narrative 整体不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

    await expect(new NarrativeClient().queryOne('1st_Loop', 'query'))
      .rejects.toMatchObject({
        name: 'NarrativeUnavailableError',
        code: 'narrative/unavailable',
        retryable: true,
        status: 503,
      });
  });

  it('单 timeline 的 500 保留为可重试请求错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

    await expect(new NarrativeClient().queryOne('2nd_Loop', 'query'))
      .rejects.toBeInstanceOf(NarrativeRequestError);
    await expect(new NarrativeClient().queryOne('2nd_Loop', 'query'))
      .rejects.not.toBeInstanceOf(NarrativeUnavailableError);
  });

  it('成功状态下的损坏 JSON 不伪装成 Bridge 不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(new NarrativeClient().queryOne('3rd_Loop', 'query'))
      .rejects.toMatchObject({
        code: 'narrative/invalid_response',
        retryable: false,
      });
  });
});
