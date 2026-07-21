// 这里测试 MCP 工具调用在 Turn 取消或超时时真正取消 SDK 请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callMcpTool } from '../execution.js';

function cancellingClient() {
  const callTool = vi.fn((
    _request: unknown,
    _schema: unknown,
    options: { signal: AbortSignal },
  ) => new Promise<never>((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  return { client: { callTool } as unknown as Client, callTool };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP 工具执行取消', () => {
  it('Turn 取消会传入 SDK callTool 并结束等待', async () => {
    const { client, callTool } = cancellingClient();
    const controller = new AbortController();
    const cancellation = new Error('turn cancelled');
    const pending = callMcpTool({
      client,
      serverName: 'remote',
      toolName: 'write_file',
      args: {},
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(cancellation);

    const sdkSignal = callTool.mock.calls[0]?.[2].signal as AbortSignal;
    controller.abort(cancellation);

    await rejected;
    expect(sdkSignal.aborted).toBe(true);
  });

  it('工具调用超时会 abort SDK 请求，而不是只结束外层 Promise', async () => {
    vi.useFakeTimers();
    const { client, callTool } = cancellingClient();
    const pending = callMcpTool({
      client,
      serverName: 'remote',
      toolName: 'write_file',
      args: {},
      timeoutMs: 500,
    });
    const rejected = expect(pending).rejects.toThrow(/timed out after 500ms/i);
    const sdkSignal = callTool.mock.calls[0]?.[2].signal as AbortSignal;

    await vi.advanceTimersByTimeAsync(500);

    await rejected;
    expect(sdkSignal.aborted).toBe(true);
  });

  it('超大文本按 UTF-8 安全截断且总结果不超过 1 MiB', async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: '你'.repeat(600_000) }],
      })),
    } as unknown as Client;

    const result = await callMcpTool({
      client,
      serverName: 'remote',
      toolName: 'large_text',
      args: {},
    }) as Array<{ type: string; text?: string }>;

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    expect(result[0]?.text).toContain('[truncated]');
    expect(result.at(-1)?.text).toContain('MCP result limited');
    expect(result[0]?.text).not.toContain('\uFFFD');
  });

  it('超大二进制块和超过 100 个的尾部块不会进入 Agent 上下文', async () => {
    const content = [
      { type: 'image', data: 'A'.repeat(300 * 1024), mimeType: 'image/png' },
      ...Array.from({ length: 105 }, (_, index) => ({ type: 'text', text: String(index) })),
    ];
    const client = {
      callTool: vi.fn(async () => ({ content })),
    } as unknown as Client;

    const result = await callMcpTool({
      client,
      serverName: 'remote',
      toolName: 'large_binary',
      args: {},
    }) as Array<Record<string, unknown>>;

    expect(result.some((block) => block.type === 'image')).toBe(false);
    expect(result.length).toBeLessThanOrEqual(101);
    expect((result.at(-1)?.text as string)).toContain('omitted');
  });
});
