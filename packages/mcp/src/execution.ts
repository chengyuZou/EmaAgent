import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client }          from '@modelcontextprotocol/sdk/client/index.js';
import { McpToolCallError }     from './errors.js';

const DEFAULT_TOOL_TIMEOUT_MS = 120_000; // 2 分钟 - 同 bash 默认

export interface CallToolOptions {
  client:      Client;
  serverName:  string;
  toolName:    string;            // 未限定,服务器上注册的原样
  args:        Record<string, unknown>;
  signal?:     AbortSignal;
  timeoutMs?:  number;
}

/**
 * 在已连接的 MCP 服务器 client 上调一个工具。
 * 返回原始 MCP result content。
 */
export async function callMcpTool(opts: CallToolOptions): Promise<unknown> {
  const { client, serverName, toolName, args, signal, timeoutMs } = opts;
  const ms = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new McpToolCallError(serverName, toolName, `timed out after ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  const cancelled = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(abortReason(controller.signal, serverName, toolName));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });

  try {
    const callPromise = client.callTool(
      { name: toolName, arguments: args },
      CallToolResultSchema,
      {
        signal: controller.signal,
        timeout: ms,
        maxTotalTimeout: ms,
      },
    );
    const result = await Promise.race([
      callPromise,
      timeoutPromise,
      cancelled,
    ]);

    if (result.isError) {
      const text = Array.isArray(result.content) && result.content.length > 0
        ? (result.content[0] as { text?: string }).text ?? 'unknown error'
        : 'unknown error';
      throw new McpToolCallError(serverName, toolName, text);
    }

    return result.content;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', relayAbort);
  }
}

function abortReason(
  signal: AbortSignal,
  serverName: string,
  toolName: string,
): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new McpToolCallError(serverName, toolName, 'aborted');
}
