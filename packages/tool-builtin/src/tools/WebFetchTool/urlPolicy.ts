// 这里负责解析 WebFetch URL、解析 DNS，并拒绝所有本机、私网、保留和非 HTTP 目标。
import dns from 'node:dns/promises';
import net from 'node:net';
import { WebFetchPolicyError } from './errors.js';

const MAX_URL_LENGTH = 2_048;

export interface ApprovedWebTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export function isObviouslyUnsafeUrl(rawUrl: string): boolean {
  try {
    const parsed = parsePublicHttpUrl(rawUrl);
    const hostname = normalizeIpHostname(parsed.hostname);
    return net.isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname);
  } catch {
    return true;
  }
}

export async function approveWebTarget(rawUrl: string): Promise<ApprovedWebTarget> {
  const url = parsePublicHttpUrl(rawUrl);
  const hostname = normalizeIpHostname(url.hostname);
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new WebFetchPolicyError(`域名 ${url.hostname} 没有可用地址`);
  }
  for (const candidate of addresses) {
    if (!isPublicNetworkAddress(candidate.address)) {
      throw new WebFetchPolicyError(
        `拒绝访问 ${url.hostname}：DNS 解析包含本机、私网或保留地址 ${candidate.address}`,
      );
    }
  }
  const selected = addresses[0]!;
  const family = selected.family === 6 ? 6 : 4;
  return { url, address: selected.address, family };
}

export function assertSafeRedirect(previous: URL, next: URL): void {
  const previousHost = stripWww(previous.hostname);
  const nextHost = stripWww(next.hostname);
  const sameHost = previousHost === nextHost;
  const sameProtocol = previous.protocol === next.protocol;
  const upgradesToHttps = previous.protocol === 'http:' && next.protocol === 'https:';
  const samePort = effectivePort(previous) === effectivePort(next);
  const standardHttpsUpgrade = upgradesToHttps
    && effectivePort(previous) === '80'
    && effectivePort(next) === '443';
  if (!sameHost || (!sameProtocol && !upgradesToHttps) || (!samePort && !standardHttpsUpgrade)) {
    throw new WebFetchPolicyError(
      `重定向目标 ${next.origin} 需要单独授权，请对该 URL 再调用一次 WebFetch`,
    );
  }
}

function parsePublicHttpUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) throw new WebFetchPolicyError('URL 过长');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchPolicyError(`无法解析 URL：${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchPolicyError(`不支持协议 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new WebFetchPolicyError('URL 不能携带用户名或密码');
  }
  const normalizedHostname = normalizeIpHostname(url.hostname);
  if (!normalizedHostname.includes('.') && net.isIP(normalizedHostname) === 0) {
    throw new WebFetchPolicyError(`拒绝访问单标签主机 ${url.hostname}`);
  }
  if (url.hostname.toLowerCase() === 'localhost' || url.hostname.toLowerCase().endsWith('.local')) {
    throw new WebFetchPolicyError(`拒绝访问本地主机 ${url.hostname}`);
  }
  return url;
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const groups = parseIpv6Groups(address);
  if (!groups) return false;
  const first = groups[0]!;
  const isAllZero = groups.every(group => group === 0);
  const isLoopback = groups.slice(0, 7).every(group => group === 0) && groups[7] === 1;
  if (isAllZero || isLoopback) return false;

  const isMappedIpv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  if (isMappedIpv4) return isPublicIpv4(groupsToIpv4(groups[6]!, groups[7]!));

  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  // 只允许 IANA 全局单播 2000::/3，并排除文档地址 2001:db8::/32。
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;

  // 6to4 会在地址中编码 IPv4；编码的是私网/保留地址时同样拒绝。
  if (first === 0x2002) {
    return isPublicIpv4(groupsToIpv4(groups[1]!, groups[2]!));
  }
  return true;
}

function normalizeIpHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function parseIpv6Groups(address: string): number[] | null {
  let normalized = normalizeIpHostname(address.toLowerCase()).split('%')[0]!;
  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    if (!isValidIpv4(dottedTail)) return null;
    const octets = dottedTail.split('.').map(Number);
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    normalized = normalized.slice(0, -dottedTail.length) + `${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const texts = [...left, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...right];
  if (texts.length !== 8 || texts.some(text => !/^[0-9a-f]{1,4}$/.test(text))) return null;
  return texts.map(text => Number.parseInt(text, 16));
}

function groupsToIpv4(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isValidIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  return octets.length === 4
    && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255);
}
