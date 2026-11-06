import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const connect = vi.fn();
  const clientClose = vi.fn(async () => undefined);
  const transportClose = vi.fn(async () => undefined);

  class FakeClient {
    connect = connect;
    close = clientClose;
  }

  class FakeHttpTransport {
    close = transportClose;
  }

  class FakeStdioTransport {
    close = transportClose;
  }

  return {
    connect,
    clientClose,
    transportClose,
    FakeClient,
    FakeHttpTransport,
    FakeStdioTransport,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: sdk.FakeClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: sdk.FakeStdioTransport,
  getDefaultEnvironment: vi.fn(() => ({})),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: sdk.FakeHttpTransport,
}));

import { openConnection } from '../connections/connection.js';
import { McpStdioConfigSchema } from '../types.js';

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP 底层连接取消', () => {
  it('已建立连接的关闭失败不向调用方抛出', async () => {
    sdk.connect.mockResolvedValueOnce(undefined);
    sdk.clientClose.mockRejectedValueOnce(new Error('transport already closed'));
    const connection = await openConnection('remote', { type: 'http', url: 'https://example.com/mcp' });
    await expect(connection.cleanup()).resolves.toBeUndefined();
    expect(sdk.clientClose).toHaveBeenCalledOnce();
  });

  it.each(['EMA_SHARED_SECRET', 'ema_shared_secret'])('配置和实际启动都拒绝控制口令 %s', async name => {
    for (const config of [
      { type: 'stdio' as const, command: 'node', args: [], env: { [name]: 'fake-secret' } },
      { type: 'stdio' as const, command: 'node', args: [], envPassthrough: [name] },
    ]) {
      expect(McpStdioConfigSchema.safeParse(config).success).toBe(false);
      await expect(openConnection('test', config)).rejects.toThrow('Ema control credentials');
    }
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('用户自己的凭据仍可通过配置传递', () => {
    expect(McpStdioConfigSchema.safeParse({
      command: 'node',
      env: { EXAMPLE_TOKEN: 'fake-user-token' },
      envPassthrough: ['HTTPS_PROXY'],
    }).success).toBe(true);
  });
  it('外部取消会传入 SDK connect 并关闭 transport', async () => {
    sdk.connect.mockImplementation((_transport: unknown, options: { signal: AbortSignal }) => (
      new Promise<never>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      })
    ));
    const controller = new AbortController();
    const cancellation = new Error('disconnect requested');

    const pending = openConnection('remote', {
      type: 'http',
      url: 'https://example.com/mcp',
    }, controller.signal);
    await vi.waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(1));

    const sdkSignal = sdk.connect.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(sdkSignal.aborted).toBe(false);
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(sdkSignal.aborted).toBe(true);
    expect(sdk.transportClose).toHaveBeenCalledTimes(1);
  });

  it('30 秒连接超时会 abort SDK 请求并关闭 transport', async () => {
    vi.useFakeTimers();
    sdk.connect.mockImplementation((_transport: unknown, options: { signal: AbortSignal }) => (
      new Promise<never>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      })
    ));

    const pending = openConnection('slow', {
      type: 'http',
      url: 'https://example.com/mcp',
    });
    const rejected = expect(pending).rejects.toThrow(/timed out after 30000ms/i);
    // SDK 采用异步导入, 等握手开始后再推进它的超时计时器.
    await vi.waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(1));
    const sdkSignal = sdk.connect.mock.calls[0]?.[1]?.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(30_000);

    await rejected;
    expect(sdkSignal.aborted).toBe(true);
    expect(sdk.transportClose).toHaveBeenCalledTimes(1);
  });
});
