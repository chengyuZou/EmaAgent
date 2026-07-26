// 解析公网 URL 和 DNS，拒绝本机、私网、特殊用途地址以及危险重定向。
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { PublicHttpPolicyError } from './errors.js';
import type { ApprovedPublicTarget } from './types.js';

const MAX_URL_LENGTH = 2_048;

// IANA 特殊用途 IPv4 网段: 全部不可作为公网目标。
// 交给 ipaddr.js 匹配, 不再手写八位组判断(注册表会变, 手写表已出现漏判与误杀)。
const IPV4_DENY_CIDRS = [
  '0.0.0.0/8',        // 本机/未指定
  '10.0.0.0/8',       // RFC1918 私网
  '100.64.0.0/10',    // CGNAT 运营商级 NAT
  '127.0.0.0/8',      // 回环
  '169.254.0.0/16',   // 链路本地
  '172.16.0.0/12',    // RFC1918 私网
  '192.0.0.0/24',     // IETF 协议分配(下方单独放行全球可达的 .9/.10)
  '192.0.2.0/24',     // TEST-NET-1 文档段
  '192.88.99.0/24',   // 6to4 中继任播
  '192.168.0.0/16',   // RFC1918 私网
  '198.18.0.0/15',    // 网络基准测试
  '198.51.100.0/24',  // TEST-NET-2 文档段
  '203.0.113.0/24',   // TEST-NET-3 文档段
  '224.0.0.0/4',      // 组播
  '240.0.0.0/4',      // 保留(含 255.255.255.255 广播)
] as const;

// IANA 将 PCP/TURN Anycast 标为全球可达，不能因同属 192.0.0.0/24 而误杀。
const IPV4_PUBLIC_EXCEPTIONS = new Set(['192.0.0.9', '192.0.0.10']);

// IPv6 只放行全球单播(2000::/3)中的非特殊段;
// 未指定/回环/ULA/链路本地/组播/保留段一律拒绝。
const IPV6_GLOBAL_UNICAST = '2000::/3';
const IPV6_DENY_CIDRS = [
  '2001::/32',      // Teredo 隧道，内嵌地址会绕过普通目标审批
  '2001:2::/48',    // 网络基准测试
  '2001:10::/28',   // ORCHID(已弃用)
  '2001:20::/28',   // ORCHIDv2，不作为普通公网目标
  '2001:db8::/32',  // 文档段
  '3fff::/20',      // 2024 新增文档段
] as const;

export function isObviouslyUnsafePublicUrl(rawUrl: string): boolean {
  try {
    const parsed = parsePublicHttpUrl(rawUrl);
    const hostname = normalizeIpHostname(parsed.hostname);
    return net.isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname);
  } catch {
    return true;
  }
}

export async function approvePublicTarget(rawUrl: string): Promise<ApprovedPublicTarget> {
  const url = parsePublicHttpUrl(rawUrl);
  const hostname = normalizeIpHostname(url.hostname);
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new PublicHttpPolicyError(`域名 ${url.hostname} 没有可用地址`);
  }
  for (const candidate of addresses) {
    if (!isPublicNetworkAddress(candidate.address)) {
      throw new PublicHttpPolicyError(
      `拒绝访问 ${url.hostname}: DNS 解析包含本机, 私网或保留地址 ${candidate.address}`,
      );
    }
  }
  const selected = addresses[0]!;
  return {
    url,
    address: selected.address,
    family: selected.family === 6 ? 6 : 4,
  };
}

export function assertSafePublicRedirect(previous: URL, next: URL): void {
  // 重定向只允许同主机同端口; www 与裸域视为同一站点
  // (互联网最普遍的等价跳转, Claude 同样放行 www 加/减)。
  // 标准 80 -> 443 的 HTTPS 升级是唯一例外。
  const sameHost = stripWww(previous.hostname) === stripWww(next.hostname);
  const sameProtocol = previous.protocol === next.protocol;
  const upgradesToHttps = previous.protocol === 'http:' && next.protocol === 'https:';
  const samePort = effectivePort(previous) === effectivePort(next);
  const standardHttpsUpgrade = upgradesToHttps
    && effectivePort(previous) === '80'
    && effectivePort(next) === '443';
  if (!sameHost || (!sameProtocol && !upgradesToHttps) || (!samePort && !standardHttpsUpgrade)) {
    throw new PublicHttpPolicyError(
      `重定向目标 ${next.origin} 需要单独授权, 拒绝跨站重定向`,
    );
  }
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parsePublicHttpUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) throw new PublicHttpPolicyError('URL 过长');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PublicHttpPolicyError(`无法解析 URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicHttpPolicyError(`不支持协议 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new PublicHttpPolicyError('URL 不能携带用户名或密码');
  }
  const normalizedHostname = normalizeIpHostname(url.hostname);
  if (!normalizedHostname.includes('.') && net.isIP(normalizedHostname) === 0) {
    throw new PublicHttpPolicyError(`拒绝访问单标签主机 ${url.hostname}`);
  }
  if (url.hostname.toLowerCase() === 'localhost' || url.hostname.toLowerCase().endsWith('.local')) {
    throw new PublicHttpPolicyError(`拒绝访问本地主机 ${url.hostname}`);
  }
  return url;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function isPublicIpv4(address: string): boolean {
  if (!ipaddr.IPv4.isIPv4(address)) return false;
  const ip = ipaddr.IPv4.parse(address);
  if (IPV4_PUBLIC_EXCEPTIONS.has(ip.toString())) return true;
  return !IPV4_DENY_CIDRS.some(cidr => ip.match(ipaddr.IPv4.parseCIDR(cidr)));
}

function isPublicIpv6(address: string): boolean {
  if (!ipaddr.IPv6.isIPv6(address)) return false;
  const ip = ipaddr.IPv6.parse(address);

  // IPv4 映射地址按 IPv4 规则判定(::ffff:a.b.c.d)。
  if (ip.isIPv4MappedAddress()) {
    return isPublicIpv4(ip.toIPv4Address().toString());
  }

  // 只放行全球单播段; 未指定/回环/ULA/链路本地/组播/保留段一律拒绝。
  if (!ip.match(ipaddr.IPv6.parseCIDR(IPV6_GLOBAL_UNICAST))) return false;
  if (IPV6_DENY_CIDRS.some(cidr => ip.match(ipaddr.IPv6.parseCIDR(cidr)))) return false;

  // 6to4(2002::/16): 内嵌 IPv4 地址按 IPv4 规则判定。
  if (ip.match(ipaddr.IPv6.parseCIDR('2002::/16'))) {
    const parts = ip.parts;
    return isPublicIpv4(
      `${parts[1]! >>> 8}.${parts[1]! & 0xff}.${parts[2]! >>> 8}.${parts[2]! & 0xff}`,
    );
  }
  return true;
}

function normalizeIpHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}
