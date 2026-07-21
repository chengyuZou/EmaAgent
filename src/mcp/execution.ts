import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult }  from '@modelcontextprotocol/sdk/types.js';
import type { Client }          from '@modelcontextprotocol/sdk/client/index.js';
import { Buffer }               from 'node:buffer';
import { McpToolCallError }     from './errors.js';

const DEFAULT_TOOL_TIMEOUT_MS = 120_000; // 2 分钟 - 同 bash 默认
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_BINARY_DATA_BYTES = 256 * 1024;
const MAX_CONTENT_BLOCKS = 100;
const RESULT_NOTICE_RESERVE_BYTES = 512;
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;

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
    ]) as CallToolResult;

    if (result.isError) {
      const text = Array.isArray(result.content) && result.content.length > 0
        ? (result.content[0] as { text?: string }).text ?? 'unknown error'
        : 'unknown error';
      throw new McpToolCallError(
        serverName,
        toolName,
        truncateUtf8(text, MAX_ERROR_MESSAGE_BYTES),
      );
    }

    return boundMcpContent(result.content);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', relayAbort);
  }
}

function boundMcpContent(content: readonly unknown[]): unknown[] {
  const bounded: unknown[] = [];
  const contentBudget = MAX_RESULT_BYTES - RESULT_NOTICE_RESERVE_BYTES;
  let usedBytes = 2;
  let omittedBlocks = Math.max(0, content.length - MAX_CONTENT_BLOCKS);
  let truncatedTextBlocks = 0;

  for (const block of content.slice(0, MAX_CONTENT_BLOCKS)) {
    const binaryBytes = binaryDataBytes(block);
    if (binaryBytes !== null && binaryBytes > MAX_BINARY_DATA_BYTES) {
      omittedBlocks += 1;
      continue;
    }

    const blockBytes = jsonBytes(block);
    if (blockBytes <= contentBudget - usedBytes) {
      bounded.push(block);
      usedBytes += blockBytes + 1;
      continue;
    }

    const truncated = truncateTextBlock(block, contentBudget - usedBytes);
    if (truncated) {
      bounded.push(truncated);
      usedBytes += jsonBytes(truncated) + 1;
      truncatedTextBlocks += 1;
    } else {
      omittedBlocks += 1;
    }
  }

  if (omittedBlocks > 0 || truncatedTextBlocks > 0) {
    const notice = {
      type: 'text',
      text:
        `[EmaAgent: MCP result limited to ${MAX_RESULT_BYTES} bytes and ` +
        `${MAX_CONTENT_BLOCKS} blocks; omitted ${omittedBlocks} block(s), ` +
        `truncated ${truncatedTextBlocks} text block(s).]`,
    };
    bounded.push(notice);
  }

  return bounded;
}

function binaryDataBytes(block: unknown): number | null {
  if (!isRecord(block)) return null;
  if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
    return Buffer.byteLength(block.data, 'utf8');
  }
  if (block.type === 'resource' && isRecord(block.resource)) {
    const blob = block.resource.blob;
    return typeof blob === 'string' ? Buffer.byteLength(blob, 'utf8') : null;
  }
  return null;
}

function truncateTextBlock(block: unknown, budgetBytes: number): unknown | null {
  if (!isRecord(block) || budgetBytes < 128) return null;
  if (block.type === 'text' && typeof block.text === 'string') {
    const empty = { type: 'text', text: '' };
    const textBudget = Math.max(0, budgetBytes - jsonBytes(empty) - 32);
    return {
      type: 'text',
      text: `${truncateUtf8(block.text, textBudget)}\n[truncated]`,
    };
  }
  if (
    block.type === 'resource' &&
    isRecord(block.resource) &&
    typeof block.resource.text === 'string'
  ) {
    const uri = typeof block.resource.uri === 'string'
      ? truncateUtf8(block.resource.uri, 2_048)
      : '';
    const mimeType = typeof block.resource.mimeType === 'string'
      ? truncateUtf8(block.resource.mimeType, 256)
      : undefined;
    const empty = {
      type: 'resource',
      resource: { uri, ...(mimeType ? { mimeType } : {}), text: '' },
    };
    const textBudget = Math.max(0, budgetBytes - jsonBytes(empty) - 32);
    return {
      ...empty,
      resource: {
        ...empty.resource,
        text: `${truncateUtf8(block.resource.text, textBudget)}\n[truncated]`,
      },
    };
  }
  return null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortReason(
  signal: AbortSignal,
  serverName: string,
  toolName: string,
): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new McpToolCallError(serverName, toolName, 'aborted');
}
