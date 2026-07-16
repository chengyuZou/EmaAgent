// 这里为 stdio 或 Streamable HTTP 配置创建 MCP SDK 连接并负责清理。
import { Client }             from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';
import { McpConnectionError, McpTimeoutError } from './errors.js';

const CLIENT_NAME    = 'ema-agent';
const CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 30_000;

// ── stdio 安全校验(权限门禁之上的纵深防御)────────────────────────────────────

const SHELL_META_RE   = /[;&|`$(){}<>\n\r]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

/**
 * 拉起子进程前拒绝明显不安全的 stdio 配置:命令含 shell 元字符、args 含控制字符、
 * 以及会在预期 MCP server 入口外跑任意代码的内联代码标志(python -c、node -e/--eval)。
 */
function assertSafeStdioConfig(command: string, args: readonly string[]): void {
  if (!command.trim()) throw new Error('MCP stdio command must not be empty.');
  if (SHELL_META_RE.test(command)) {
    throw new Error('MCP stdio command contains unsafe shell metacharacters.');
  }
  for (const arg of args) {
    if (CONTROL_CHAR_RE.test(arg)) {
      throw new Error('MCP stdio args must not contain control characters.');
    }
  }
  const base = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') ?? '';
  if (base.startsWith('python') || base === 'py') {
    if (args.some((a) => a === '-c')) {
      throw new Error('MCP stdio Python servers may not use inline code (-c).');
    }
  } else if (base === 'node' || base === 'deno' || base === 'bun' || base.startsWith('node')) {
    if (args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print')) {
      throw new Error('MCP stdio JavaScript servers may not use inline eval (-e/--eval).');
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
      // 用户键覆盖默认。
      env:     { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }
  // 远程 MCP 统一使用 Streamable HTTP；旧 SSE transport 已从配置层移除。
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers ? { requestInit: { headers: config.headers } } : undefined,
  );
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

  // SDK 原生接收 AbortSignal；本地 timeout 触发时同时 abort 握手并关闭 transport，
  // 不能只让外层 Promise 提前返回而让 stdio 子进程或 HTTP 请求继续运行。
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });

  const connectPromise = client.connect(transport, {
    signal: controller.signal,
    timeout: CONNECT_TIMEOUT_MS,
    maxTotalTimeout: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new McpTimeoutError(serverName, 'connect', CONNECT_TIMEOUT_MS);
      controller.abort(error);
      reject(error);
    }, CONNECT_TIMEOUT_MS);
  });

  const cancelled = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(abortReason(controller.signal));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });

  try {
    await Promise.race([connectPromise, timeout, cancelled]);
  } catch (err) {
    // 失败时尝试优雅关闭 transport
    try { await transport.close(); } catch { /* ignore */ }
    if (err instanceof McpTimeoutError || controller.signal.aborted) throw err;
    throw new McpConnectionError(serverName, (err as Error).message ?? String(err));
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', relayAbort);
  }

  const cleanup = async () => {
    try { await client.close(); } catch { /* ignore */ }
  };

  return { client, cleanup };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The MCP connection was aborted', 'AbortError');
}
