// 这里测试请求头白名单, 错误 URL 脱敏和并发闸门的边界.

import { describe, expect, it } from 'vitest';
import { buildRequestHeaders, PublicEgressLimiter } from '../src/client.js';
import { PublicHttpStatusError } from '../src/errors.js';

describe('请求头白名单', () => {
  it('剥离凭证/Host/连接指令与默认头覆盖, 保留白名单头', () => {
    const headers = buildRequestHeaders({
      'Authorization': 'Bearer secret',
      'Cookie': 'sid=1',
      'Host': 'evil.example',
      'User-Agent': 'Evil/1.0',
      'Connection': 'keep-alive',
      'Accept-Language': 'zh-CN',
    });

    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Cookie']).toBeUndefined();
    expect(headers['Host']).toBeUndefined();
    expect(headers['Connection']).toBeUndefined();
    expect(headers['User-Agent']).toBe('EmaAgent/1.0');
    expect(headers['Accept-Encoding']).toBe('identity');
    expect(headers['Accept-Language']).toBe('zh-CN');
  });

  it('无调用方头时保持安全默认', () => {
    expect(buildRequestHeaders(undefined)).toEqual({
      'Accept-Encoding': 'identity',
      'User-Agent': 'EmaAgent/1.0',
    });
  });
});

describe('PublicHttpStatusError URL 脱敏', () => {
  it('query 中的 key 不进入错误消息与字段', () => {
    const err = new PublicHttpStatusError(403, 'Forbidden', 'https://api.example.com/v1/search?key=SECRET&q=test');
    expect(err.message).not.toContain('SECRET');
    expect(err.url).toBe('https://api.example.com/v1/search');
  });
});

describe('并发闸门(PublicEgressLimiter)', () => {
  it('每 host 达上限时排队, 释放后放行', async () => {
    const limiter = new PublicEgressLimiter();
    const c = new AbortController();
    const r1 = await limiter.acquire('a.com', c.signal);
    const r2 = await limiter.acquire('a.com', c.signal);

    let thirdGranted = false;
    const p3 = limiter.acquire('a.com', c.signal).then((release) => {
      thirdGranted = true;
      return release;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(thirdGranted).toBe(false);

    r1();
    const r3 = await p3;
    expect(thirdGranted).toBe(true);
    r2();
    r3();
  });

  it('排队中取消立即拒绝, 不占槽位', async () => {
    const limiter = new PublicEgressLimiter();
    const c1 = new AbortController();
    const c2 = new AbortController();
    await limiter.acquire('a.com', c1.signal);
    await limiter.acquire('a.com', c1.signal);

    const pending = limiter.acquire('a.com', c2.signal);
    c2.abort();
    await expect(pending).rejects.toThrow();
  });

  it('全局槽位占满时, 其他 host 也排队', async () => {
    const limiter = new PublicEgressLimiter();
    const c = new AbortController();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 8; i++) {
      releases.push(await limiter.acquire(`host-${i}.example`, c.signal));
    }

    let granted = false;
    const pending = limiter.acquire('other.example', c.signal).then((release) => {
      granted = true;
      return release;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(granted).toBe(false);

    for (const release of releases) release();
    await pending;
    expect(granted).toBe(true);
  });

  it('并发取消信号已中止时直接拒绝', async () => {
    const limiter = new PublicEgressLimiter();
    const c = new AbortController();
    c.abort();
    await expect(limiter.acquire('a.com', c.signal)).rejects.toThrow();
  });
});
