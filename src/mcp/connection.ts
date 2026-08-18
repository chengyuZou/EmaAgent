// 为 stdio 或 Streamable HTTP 配置创建 MCP SDK 连接并负责清理。
import { Client }             from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';
import { McpConnectionError, McpTimeoutError } from './errors.js';
import { linkedAbortController, waitForPromise, withTimeout } from './utils.js';

const CLIENT_NAME    = 'ema-agent';
const CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 30_000;

// ── stdio 基础校验(权限门禁之上只留机械合法性)────────────────────────────────
//
// 不设命令白名单/元字符检查:SDK spawn 走 shell:false,元字符不被解释;
// python -c / node -e 这类"猜测式拦截"会在用户批准后误伤合法配置(假阳性工厂)。
// 真正的安全边界是 McpRegistry 的 stdioGate(用户批准完整启动意图)。

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

function assertSafeStdioConfig(command: string, args: readonly string[]): void {
  if (!command.trim()) throw new Error('MCP stdio command must not be empty.');
  for (const arg of args) {
    if (CONTROL_CHAR_RE.test(arg)) {
      throw new Error('MCP stdio args must not contain control characters.');
    }
  }
}


function buildTransport(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.type === 'stdio') {
    assertSafeStdioConfig(config.command, config.args);
    return new StdioClientTransport({
      command: config.command,
      args:    config.args,
      cwd:     config.cwd,
      // 必须合并 SDK 默认 env(PATH、HOME 等)。只传用户 env 会丢 PATH,
      // 破坏 `npx`/`node`/`uvx` 解析 - 这是"stdio server 起不来"的头号原因。
      // 合并顺序:SDK 默认 < envPassthrough 白名单透传 < 用户显式 env。
      env:     {
        ...getDefaultEnvironment(),
        ...pickPassthroughEnv(config.envPassthrough),
        ...(config.env ?? {}),
      },
    });
  }
  // 远程 MCP 统一使用 Streamable HTTP；旧 SSE transport 已从配置层移除。
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers ? { requestInit: { headers: config.headers } } : undefined,
  );
}

/** 按名字白名单从宿主进程透传环境变量;未设置的名字静默跳过。 */
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
 * 打开到 MCP 服务器的连接。SDK 握手完成(initialize -> initialized)时 resolve。
 * 超时或协议错误时抛错。
 */
export async function openConnection(
  serverName: string,
  config:     McpServerConfig,
  signal?:    AbortSignal,
): Promise<OpenedConnection> {
  const transport = buildTransport(config);
  const client    = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} },
  );

  // 外部取消经 linked controller 透传给 SDK;本地超时触发时同时 abort 握手,
  // 不能只让外层 Promise 提前返回而让 stdio 子进程或 HTTP 请求继续运行。
  const linked = linkedAbortController(signal);
  try {
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
  } catch (err) {
    // 失败时尝试优雅关闭 transport
    try { await transport.close(); } catch { /* ignore */ }
    if (err instanceof McpTimeoutError || linked.controller.signal.aborted) throw err;
    throw new McpConnectionError(serverName, (err as Error).message ?? String(err));
  } finally {
    linked.dispose();
  }

  const cleanup = async () => {
    try { await client.close(); } catch { /* ignore */ }
  };

  return { client, cleanup };
}
