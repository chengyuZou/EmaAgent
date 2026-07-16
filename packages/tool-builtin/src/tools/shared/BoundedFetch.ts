// 这里负责给固定可信服务的 HTTP 请求加总超时和响应体字节上限。
export interface BoundedFetchOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  init?: RequestInit;
}

export interface BoundedFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

export async function fetchBounded(
  url: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResponse> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal.reason);
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`HTTP 请求超过 ${options.timeoutMs}ms`)),
    options.timeoutMs,
  );
  timer.unref?.();

  try {
    const response = await fetch(url, { ...options.init, signal: controller.signal });
    const body = await readResponseBody(response, options.maxBytes, controller.signal);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`HTTP 响应体超过 ${maxBytes} 字节上限`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel(`HTTP 响应体超过 ${maxBytes} 字节上限`);
        throw new Error(`HTTP 响应体超过 ${maxBytes} 字节上限`);
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('HTTP 请求已取消');
}
