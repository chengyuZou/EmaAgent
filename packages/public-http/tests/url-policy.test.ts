// 测试公共网络出口拒绝本机、私网、特殊用途地址和跨站重定向，同时允许公网显式端口。
import { describe, expect, it } from 'vitest';
import {
  assertSafePublicRedirect,
  isObviouslyUnsafePublicUrl,
  isPublicNetworkAddress,
} from '../src/index.js';

describe('公网 URL 策略', () => {
  it.each([
    'http://127.0.0.1/admin',
    'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.10/',
    'http://192.0.2.1/docs',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[2002:7f00:0001::]/',
    'http://[3fff::1]/',
    'file:///etc/passwd',
    'http://localhost/',
    'http://router.local/',
    'http://192.0.0.1/',
    'http://[2001::1]/',
    'http://[2001:2::1]/',
    'http://[2001:20::1]/',
  ])('拒绝危险 URL: %s', url => {
    expect(isObviouslyUnsafePublicUrl(url)).toBe(true);
  });

  it('区分公开地址与文档、私网和 IPv4 映射地址', () => {
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
    // IANA 标记全球可达的地址不得误杀。
    expect(isPublicNetworkAddress('192.0.0.9')).toBe(true);
    expect(isPublicNetworkAddress('192.0.0.10')).toBe(true);
    expect(isPublicNetworkAddress('192.0.0.1')).toBe(false);
    expect(isPublicNetworkAddress('192.0.0.170')).toBe(false);
    expect(isPublicNetworkAddress('203.0.113.1')).toBe(false);
    expect(isPublicNetworkAddress('192.0.2.1')).toBe(false);
    expect(isPublicNetworkAddress('198.51.100.1')).toBe(false);
    expect(isPublicNetworkAddress('2001:db8::1')).toBe(false);
    expect(isPublicNetworkAddress('3fff::1')).toBe(false);
    expect(isPublicNetworkAddress('2001::1')).toBe(false);
    expect(isPublicNetworkAddress('2001:2::1')).toBe(false);
    expect(isPublicNetworkAddress('2001:20::1')).toBe(false);
    expect(isPublicNetworkAddress('::ffff:192.168.1.1')).toBe(false);
    expect(isPublicNetworkAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('公网地址允许显式非标准端口，端口授权不冒充地址分类', () => {
    expect(isObviouslyUnsafePublicUrl('http://8.8.8.8/')).toBe(false);
    expect(isObviouslyUnsafePublicUrl('http://8.8.8.8:443/')).toBe(false);
    expect(isObviouslyUnsafePublicUrl('http://8.8.8.8:22/')).toBe(false);
    expect(isObviouslyUnsafePublicUrl('http://8.8.8.8:8080/')).toBe(false);
    expect(isObviouslyUnsafePublicUrl('http://127.0.0.1:8080/')).toBe(true);
  });

  it('只允许同主机重定向(含 www 等价)和标准 HTTP 到 HTTPS 升级', () => {
    expect(() => assertSafePublicRedirect(
      new URL('http://example.com/start'),
      new URL('https://example.com/end'),
    )).not.toThrow();
    // www 与裸域视为同一站点(Claude 同款, 互联网最普遍的等价跳转)。
    expect(() => assertSafePublicRedirect(
      new URL('http://example.com/start'),
      new URL('https://www.example.com/end'),
    )).not.toThrow();
    expect(() => assertSafePublicRedirect(
      new URL('https://www.example.com/start'),
      new URL('https://example.com/end'),
    )).not.toThrow();
    // 其他子域与跨域仍然拒绝。
    expect(() => assertSafePublicRedirect(
      new URL('https://example.com/start'),
      new URL('https://api.example.com/end'),
    )).toThrow('跨站重定向');
    expect(() => assertSafePublicRedirect(
      new URL('https://example.com/start'),
      new URL('https://attacker.example/end'),
    )).toThrow('跨站重定向');
    // HTTPS 降级到 HTTP 也拒绝。
    expect(() => assertSafePublicRedirect(
      new URL('https://example.com/start'),
      new URL('http://example.com/end'),
    )).toThrow('跨站重定向');
    // 初始请求可以使用公网显式端口，但重定向不能借机切换到另一端口。
    expect(() => assertSafePublicRedirect(
      new URL('https://example.com:8443/start'),
      new URL('https://example.com:8443/end'),
    )).not.toThrow();
    expect(() => assertSafePublicRedirect(
      new URL('https://example.com:8443/start'),
      new URL('https://example.com:9443/end'),
    )).toThrow('跨站重定向');
  });
});
