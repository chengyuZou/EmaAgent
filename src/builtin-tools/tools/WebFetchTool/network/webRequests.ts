import { Agent, Pool, ProxyAgent } from 'undici';
import { ToolExecutionError } from '@ema-agent/tools';
import { readWebProxy } from './webProxy.js';

export type WebRequest = (
  url: string,
  init: {
    readonly signal: AbortSignal;
    readonly headers?: HeadersInit;
    readonly redirect: 'follow' | 'manual';
  },
) => Promise<Response>;

interface WebRequests {
  readonly request: WebRequest;
  close(): Promise<void>;
}

let connections: WebRequests | undefined;

/** Main Agents and subagents share connections in this Server process, not the global fetch dispatcher. */
export const requestWeb: WebRequest = async (url, init) => {
  init.signal.throwIfAborted();
  connections ??= createWebRequests(process.env);
  return connections.request(url, init);
};

/** Server stops Turns and subagents before releasing their connections. */
export async function closeWebRequests(): Promise<void> {
  const current = connections;
  connections = undefined;
  await current?.close();
}

function createWebRequests(env: NodeJS.ProcessEnv): WebRequests {
  let proxy: ReturnType<typeof readWebProxy> | undefined;
  let configurationError: unknown;
  try {
    proxy = readWebProxy(env);
  } catch (error) {
    // A web proxy error must not prevent conversations or the desktop from starting.
    configurationError = error;
  }
  const dispatcher = new Agent({
    factory(origin) {
      const uri = proxy!.select(new URL(origin));
      // The factory runs for each origin, including a redirect's destination.
      return uri ? new ProxyAgent({ uri }) : new Pool(origin);
    },
  });

  return {
    async request(url, init) {
      init.signal.throwIfAborted();
      if (configurationError) throw configurationError;
      try {
        const requestInit = { ...init, dispatcher };
        const response = await fetch(url, requestInit);
        if (!response.ok) {
          const secrets = [...proxy!.secrets, ...requestSecrets(url, init.headers)];
          throw await httpFailure(response, init.signal, secrets);
        }
        return response;
      } catch (error) {
        throw webRequestFailure(error, init.signal);
      }
    },
    async close() {
      // Server shutdown cancels Turns first. Destroy also releases any unfinished response body.
      await dispatcher.destroy();
    },
  };
}

export class WebHttpError extends ToolExecutionError {
  constructor(readonly status: number, message: string) {
    super(undefined, message, `web/http_${status}`);
  }
}

/** Also used around response-body reads, which can fail after fetch has returned headers. */
export function webRequestFailure(error: unknown, signal: AbortSignal): unknown {
  signal.throwIfAborted();
  if (error instanceof ToolExecutionError) return error;
  let cause = error;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth += 1) {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
    const issue = NETWORK_ERRORS[code];
    if (issue) return new ToolExecutionError(undefined, `${issue.message} (${code}).`, issue.code);
    cause = cause.cause;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ToolExecutionError(undefined, 'Web request timed out.', 'web/timeout');
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return new ToolExecutionError(undefined, 'Web connection failed. No HTTP response was received.', 'web/connection');
  }
  return error;
}

const NETWORK_ERRORS: Readonly<Record<string, { code: string; message: string }>> = {
  UND_ERR_CONNECT_TIMEOUT: {
    code: 'web/connect_timeout',
    message: 'Connection timed out before receiving an HTTP response. Check the network and configured proxy',
  },
  UND_ERR_HEADERS_TIMEOUT: {
    code: 'web/timeout',
    message: 'Timed out waiting for HTTP response headers',
  },
  UND_ERR_BODY_TIMEOUT: {
    code: 'web/timeout',
    message: 'Timed out reading the HTTP response body',
  },
  ENOTFOUND: {
    code: 'web/dns',
    message: 'DNS could not resolve the destination or proxy host',
  },
  EAI_AGAIN: {
    code: 'web/dns',
    message: 'DNS lookup temporarily failed for the destination or proxy host',
  },
  ECONNREFUSED: {
    code: 'web/connection_refused',
    message: 'The destination or configured proxy refused the connection. No direct fallback was attempted',
  },
  ECONNRESET: {
    code: 'web/connection_reset',
    message: 'The connection was reset while communicating with the destination or proxy',
  },
  UND_ERR_SOCKET: {
    code: 'web/connection_reset',
    message: 'The connection closed before the response finished',
  },
  CERT_HAS_EXPIRED: {
    code: 'web/tls',
    message: 'TLS certificate has expired',
  },
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    code: 'web/tls',
    message: 'TLS certificate is self-signed and not trusted',
  },
  SELF_SIGNED_CERT_IN_CHAIN: {
    code: 'web/tls',
    message: 'TLS certificate chain contains an untrusted self-signed certificate',
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    code: 'web/tls',
    message: 'TLS certificate could not be verified',
  },
  ERR_TLS_CERT_ALTNAME_INVALID: {
    code: 'web/tls',
    message: 'TLS certificate does not match the requested host',
  },
};

async function httpFailure(response: Response, signal: AbortSignal, secrets: readonly string[]): Promise<WebHttpError> {
  let explanation = '';
  switch (response.status) {
    case 401:
      explanation = ' Authentication is required.';
      break;
    case 403:
      explanation = ' The server refused access; a proxy does not grant access or satisfy browser verification.';
      break;
    case 404:
      explanation = ' The requested resource was not found.';
      break;
    case 407:
      explanation = ' The proxy requires authentication.';
      break;
    case 429:
      explanation = ' The server rate-limited this request. Do not retry immediately.';
      break;
    default:
      if (response.status >= 500) explanation = ' The server or an upstream service failed.';
  }
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && /^\d+$/u.test(retryAfter.trim()) && Number.isSafeInteger(Number(retryAfter))) {
    explanation += ` Retry-After: ${retryAfter.trim()} seconds.`;
  } else if (retryAfter && Number.isFinite(Date.parse(retryAfter))) {
    explanation += ` Retry-After: ${new Date(retryAfter).toUTCString()}.`;
  }
  const excerpt = redact(await errorExcerpt(response, signal), secrets);
  const details = excerpt ? ` Server error excerpt (untrusted): ${excerpt}` : '';
  return new WebHttpError(response.status, `HTTP ${response.status}.${explanation}${details}`);
}

async function errorExcerpt(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/|json|xml/iu.test(type)) {
    await response.body.cancel();
    return '';
  }
  const reader = response.body.getReader();
  const budget = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(budget.reason);
    budget.addEventListener('abort', onAbort, { once: true });
  });
  try {
    budget.throwIfAborted();
    while (size < 4_096) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      const part = value.subarray(0, 4_096 - size);
      chunks.push(part);
      size += part.byteLength;
    }
  } catch {
    // Keep the HTTP status even if the optional error excerpt is slow or unreadable.
    signal.throwIfAborted();
  } finally {
    budget.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let excerpt = Buffer.concat(chunks).toString('utf8');
  if (/html|xml/iu.test(type)) {
    // The byte limit can cut a tag before its closing >. Discard that unfinished tag too.
    excerpt = excerpt
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/giu, '')
      .replace(/<[^>]*(?:>|$)/gu, ' ');
  }
  return excerpt
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function requestSecrets(url: string, headers: HeadersInit | undefined): string[] {
  const address = new URL(url);
  const values = [address.username, address.password, ...address.searchParams.values()];
  new Headers(headers).forEach((value, name) => {
    if (/authorization|cookie|key|token/iu.test(name)) values.push(value);
  });
  return values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value)]);
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/giu, '$1[redacted]')
    .slice(0, 500);
}
