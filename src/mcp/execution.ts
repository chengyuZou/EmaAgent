import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client }          from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolResultContentPart } from '@ema-agent/llm';
import { Buffer }               from 'node:buffer';
import { McpToolCallError }     from './errors.js';
import { linkedAbortController, waitForPromise, withTimeout } from './utils.js';

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_BINARY_DATA_BYTES = 256 * 1024;
const MAX_CONTENT_BLOCKS = 100;
const RESULT_NOTICE_RESERVE_BYTES = 512;
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;

/**
 * 工具执行结果保存的内容. content 和 structuredContent 分别限制大小,
 * 随后由 projectMcpToolOutput 转换成模型可读取的内容块.
 */
export interface McpToolOutput {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
}

export interface CallToolOptions {
  client:      Client;
  serverName:  string;
  toolName:    string;            // 未限定,服务器上注册的原样
  args:        Record<string, unknown>;
  signal?:     AbortSignal;
  timeoutMs?:  number;
}

/**
 * 使用已连接的 Client 执行工具. isError 结果转为 McpToolCallError.
 * 调用取消或超时时, 同时取消 SDK 请求.
 */
export async function callMcpTool(opts: CallToolOptions): Promise<McpToolOutput> {
  const { client, serverName, toolName, args, signal, timeoutMs } = opts;
  const ms = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const linked = linkedAbortController(signal);

  try {
    const result = await waitForPromise(
      withTimeout(
        client.callTool(
          { name: toolName, arguments: args },
          CallToolResultSchema,
          {
            signal: linked.controller.signal,
            timeout: ms,
            maxTotalTimeout: ms,
          },
        ),
        ms,
        () => new McpToolCallError(serverName, toolName, `timed out after ${ms}ms`),
        (error) => linked.controller.abort(error),
      ),
      linked.controller.signal,
    );

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

    const content = boundMcpContent(
      Array.isArray(result.content) ? result.content : [],
    );

    // structuredContent 有独立的 1 MiB 限制. 对象不能像文本一样截断, 超限时整体丢弃.
    let structuredContent: unknown = result.structuredContent;
    if (structuredContent !== undefined && jsonBytes(structuredContent) > MAX_RESULT_BYTES) {
      structuredContent = undefined;
      content.push({
        type: 'text',
        text: `[EmaAgent: MCP structuredContent exceeded ${MAX_RESULT_BYTES} bytes and was dropped.]`,
      });
    }

    return {
      content,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
  } finally {
    linked.dispose();
  }
}

export function projectMcpToolOutput(output: McpToolOutput): ToolResultContentPart[] {
  const parts: ToolResultContentPart[] = [];
  for (const block of output.content) {
    parts.push(projectContentBlock(block));
  }
  if (output.structuredContent !== undefined) {
    parts.push({
      type: 'text',
      text: JSON.stringify(output.structuredContent, null, 2),
    });
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', text: '(empty result)' });
  }
  return parts;
}

function projectContentBlock(block: unknown): ToolResultContentPart {
  if (!isRecord(block) || typeof block.type !== 'string') {
    return { type: 'text', text: `[MCP: unrecognized content block] ${safePreview(block)}` };
  }

  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    return {
      type: 'image_data',
      data: block.data,
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
    };
  }

  if (block.type === 'audio') {
    return {
      type: 'text',
      text: `[MCP: audio content omitted (${describeMime(block)}, ${byteSizeOf(block.data)}); this version cannot play audio]`,
    };
  }

  if (block.type === 'resource' && isRecord(block.resource)) {
    const resource = block.resource;
    const uri = typeof resource.uri === 'string' ? resource.uri : '';
    if (typeof resource.text === 'string') {
      return { type: 'text', text: `[Resource from ${uri}]\n${resource.text}` };
    }
    if (typeof resource.blob === 'string') {
      const mime = describeMime(resource);
      if (mime.startsWith('image/')) {
        return { type: 'image_data', data: resource.blob, mimeType: mime };
      }
      return {
        type: 'text',
        text: `[MCP: resource blob omitted (${mime}, ${byteSizeOf(resource.blob)}) from ${uri}]`,
      };
    }
    return { type: 'text', text: `[MCP: empty resource block from ${uri}]` };
  }

  if (block.type === 'resource_link') {
    const name = typeof block.name === 'string' ? block.name : 'resource';
    const uri = typeof block.uri === 'string' ? block.uri : '';
    return { type: 'text', text: `[Resource link: ${name}] ${uri}` };
  }

  return { type: 'text', text: `[MCP: unsupported content block type "${block.type}"]` };
}

function describeMime(block: Record<string, unknown>): string {
  return typeof block.mimeType === 'string' ? block.mimeType : 'unknown mime';
}

function byteSizeOf(value: unknown): string {
  if (typeof value !== 'string') return '0 B';
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

function safePreview(value: unknown): string {
  try {
    return truncateUtf8(JSON.stringify(value) ?? '', 256);
  } catch {
    return '[unserializable]';
  }
}

function boundMcpContent(content: readonly unknown[]): unknown[] {
  // 为删减说明留出空间, 防止说明本身使 content 超过大小限制.
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
