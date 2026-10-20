import { z } from 'zod';
import { ToolExecutionError } from '@ema-agent/tools';

// Native-to-Server startup data. Automatic proxy scripts cannot be reduced to one fixed address.
const systemProxySchema = z.object({
  proxy: z.string(),
  bypass: z.string(),
  automatic: z.boolean(),
  readFailed: z.boolean(),
}).strict();

export function readWebProxy(env: NodeJS.ProcessEnv): {
  select: (url: URL) => string | undefined;
  secrets: readonly string[];
} {
  const read = (name: string): string =>
    (env[name.toLowerCase()] ?? env[name] ?? '').trim();
  const http = read('HTTP_PROXY');
  const https = read('HTTPS_PROXY');
  const all = read('ALL_PROXY');
  const noProxy = read('NO_PROXY');
  const secrets: string[] = [];

  if (http || https || all) {
    const httpProxy = normalizeProxy(http || all, secrets);
    const httpsProxy = normalizeProxy(https || http || all, secrets);
    return {
      select: url => {
        if (bypasses(url, noProxy, false)) return undefined;
        return url.protocol === 'https:' ? httpsProxy : httpProxy;
      },
      secrets,
    };
  }

  if (!env.EMA_WEB_SYSTEM_PROXY) {
    // Standalone Server and non-Windows hosts currently use environment proxy settings only.
    return { select: () => undefined, secrets };
  }
  let settings: z.infer<typeof systemProxySchema>;
  try {
    settings = systemProxySchema.parse(JSON.parse(env.EMA_WEB_SYSTEM_PROXY));
  } catch {
    throw configurationError('Invalid system proxy configuration from the desktop host.');
  }
  if (settings.readFailed) {
    throw configurationError('Windows system proxy settings could not be read. Configure HTTP_PROXY/HTTPS_PROXY explicitly or restart Ema.');
  }
  if (settings.automatic) {
    throw configurationError('PAC/WPAD automatic proxy resolution is not supported by web tools. Configure HTTP_PROXY/HTTPS_PROXY explicitly; no direct fallback was attempted.');
  }

  let httpProxy: string | undefined;
  let httpsProxy: string | undefined;
  if (settings.proxy.includes('=')) {
    for (const entry of settings.proxy.split(/[;\s]+/u).filter(Boolean)) {
      const separator = entry.indexOf('=');
      const protocol = entry.slice(0, separator).toLowerCase();
      const address = entry.slice(separator + 1);
      if (separator < 1 || !address || !['http', 'https'].includes(protocol)) {
        throw configurationError('Unsupported Windows proxy entry. Configure an HTTP or HTTPS proxy explicitly.');
      }
      if (protocol === 'http') httpProxy = normalizeProxy(address, secrets);
      if (protocol === 'https') httpsProxy = normalizeProxy(address, secrets);
    }
  } else {
    httpProxy = normalizeProxy(settings.proxy, secrets);
    httpsProxy = httpProxy;
  }
  return {
    select: url => {
      if (bypasses(url, noProxy, false) || bypasses(url, settings.bypass, true)) {
        return undefined;
      }
      return url.protocol === 'https:' ? httpsProxy : httpProxy;
    },
    secrets,
  };
}

function normalizeProxy(value: string, secrets: string[]): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Unsupported proxy URL');
    }
    for (const credential of [url.username, url.password]) {
      if (credential) {
        secrets.push(credential, decodeURIComponent(credential));
      }
    }
    return url.toString();
  } catch {
    // Do not echo the proxy URL: it can contain credentials.
    throw configurationError('Invalid proxy address. Web tools support HTTP/HTTPS proxies, not SOCKS URLs.');
  }
}

function bypasses(url: URL, list: string, windows: boolean): boolean {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (let entry of list.toLowerCase().split(/[;,\s]+/u).filter(Boolean)) {
    if (entry === '*') return true;
    if (windows && entry === '<local>') {
      if (!hostname.includes('.') && !hostname.includes(':')) return true;
      continue;
    }
    const scheme = entry.match(/^(https?):\/\//u);
    if (scheme) {
      if (`${scheme[1]}:` !== url.protocol) continue;
      entry = entry.slice(scheme[0].length);
    }
    const withPort = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/u);
    if (withPort) {
      if (withPort[2] !== port) continue;
      entry = withPort[1]!;
    }
    if (windows) {
      const pattern = entry.split('*').map(part =>
        part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
      ).join('.*');
      if (new RegExp(`^${pattern}$`, 'u').test(hostname)) return true;
    } else if (entry.startsWith('.') || entry.startsWith('*')) {
      if (hostname.endsWith(entry.replace(/^\*/u, ''))) return true;
    } else if (hostname === entry) {
      return true;
    }
  }
  return false;
}

function configurationError(message: string): ToolExecutionError {
  return new ToolExecutionError(undefined, message, 'web/proxy_configuration');
}
