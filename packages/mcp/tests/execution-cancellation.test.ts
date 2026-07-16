// 这里测试 MCP 工具调用在 Turn 取消或超时时真正取消 SDK 请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callMcpTool } from '../src/execution.js';

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
});
