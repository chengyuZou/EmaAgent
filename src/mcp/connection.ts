import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';
import { McpConnectionError, McpTimeoutError } from './errors.js';
import { linkedAbortController, waitForPromise, withTimeout } from './utils.js';

const CLIENT_NAME    = 'ema-agent';
const CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 30_000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

// SDK 用 shell:false 启动已获准的命令, 此处只检查空命令和参数控制字符.
function assertSafeStdioConfig(command: string, args: readonly string[]): void {
  if (!command.trim()) throw new Error('MCP stdio command must not be empty.');
  for (const arg of args) {
    if (CONTROL_CHAR_RE.test(arg)) {
      throw new Error('MCP stdio args must not contain control characters.');
    }
  }
}

async function buildTransport(
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  // Windows 本地两种传输独立导入各约 0.19s, 含共享依赖且随环境变化; 只加载实际使用的一种.
  if (config.type === 'stdio') {
    assertSafeStdioConfig(config.command, config.args);
    const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    signal?.throwIfAborted();
    return new StdioClientTransport({
      command: config.command,
      args:    config.args,
      cwd:     config.cwd,
      // 保留 SDK 默认环境, 否则只传用户 env 会丢失 PATH 等命令解析所需的变量.
      // 合并顺序: SDK 默认 < envPassthrough 透传 < 用户显式 env.
      env:     {
        ...getDefaultEnvironment(),
        ...pickPassthroughEnv(config.envPassthrough),
        ...(config.env ?? {}),
      },
    });
  }
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  signal?.throwIfAborted();
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers ? { requestInit: { headers: config.headers } } : undefined,
  );
}

/** 按配置的名字从宿主进程透传环境变量, 未设置的名字跳过. */
function pickPassthroughEnv(names: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export interface OpenedConnection {
  client:  Client;
  cleanup: () => Promise<void>;
}

/**
 * 调用时加载 SDK, 握手完成(initialize -> initialized)后返回连接.
 * 加载期间取消不会启动连接; 30 秒超时从 SDK 握手开始计算.
 */
export async function openConnection(
  serverName: string,
  config:     McpServerConfig,
  signal?:    AbortSignal,
): Promise<OpenedConnection> {
  signal?.throwIfAborted();
  // Windows 本地 Client 及其依赖独立导入约 0.40s, 实际耗时随环境变化.
  // 无连接需求时不加载 Client; 模块由 import 缓存, 每次连接仍创建独立实例.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  signal?.throwIfAborted();
  const transport = await buildTransport(config, signal);

  // 外部取消或本地超时都要中止 SDK 握手, 不能只返回错误却留下子进程或 HTTP 请求.
  const linked = linkedAbortController(signal);
  try {
    // 等待 buildTransport 返回时也可能取消, 此时关闭传输对象但不调用 connect.
    linked.controller.signal.throwIfAborted();
    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {} },
    );
    await waitForPromise(
      withTimeout(
        client.connect(transport, {
          signal: linked.controller.signal,
          timeout: CONNECT_TIMEOUT_MS,
          maxTotalTimeout: CONNECT_TIMEOUT_MS,
        }),
        CONNECT_TIMEOUT_MS,
        () => new McpTimeoutError(serverName, 'connect', CONNECT_TIMEOUT_MS),
        (error) => linked.controller.abort(error),
      ),
      linked.controller.signal,
    );
    return {
      client,
      cleanup: async () => {
        try {
          await client.close();
        } catch {
          // 连接可能已经断开, 清理失败不影响其他连接继续关闭.
        }
      },
    };
  } catch (err) {
    try {
      await transport.close();
    } catch {
      // 保留连接失败或取消的原始原因.
    }
    if (err instanceof McpTimeoutError || linked.controller.signal.aborted) throw err;
    throw new McpConnectionError(serverName, (err as Error).message ?? String(err));
  } finally {
    linked.dispose();
  }
}
