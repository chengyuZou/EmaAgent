// 这里提供 MCP Registry 使用的超时、取消、并发和连接状态基础辅助函数。

import type { OpenedConnection } from './connection.js';
import type { McpConnection, McpToolInfo } from './types.js';

export async function cleanupQuietly(connection: OpenedConnection): Promise<void> {
  try { await connection.cleanup(); } catch { /* ignore cleanup failure */ }
}

export function connectionInfo(
  serverName: string,
  status: McpConnection['status'],
  tools: readonly McpToolInfo[],
  error?: string,
  connectedAt?: number,
): McpConnection {
  return {
    serverName,
    status,
    tools: [...tools],
    ...(error ? { error } : {}),
    ...(connectedAt !== undefined ? { connectedAt } : {}),
  };
}

export function copyConnection(info: McpConnection): McpConnection {
  return { ...info, tools: [...info.tools] };
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item !== undefined) await worker(item);
      }
    },
  );
  await Promise.all(workers);
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
  onTimeout?: (error: Error) => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = timeoutError();
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function linkedAbortController(signal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', relayAbort),
  };
}

export async function waitForPromise<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The MCP operation was aborted', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
