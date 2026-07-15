import { Client }             from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
// SSEClientTransport 在 MCP SDK 已弃用(优先 StreamableHTTPClientTransport),
// 但很多已发布服务器(如智谱、百度)仍用旧式 SSE 协议。
// 迁移期保留向后兼容。
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { SSEClientTransport }   from '@modelcontextprotocol/sdk/client/sse.js';
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


function buildTransport(config: McpServerConfig): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
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
  if (config.type === 'sse') {
    return new SSEClientTransport(
      new URL(config.url),
      config.headers ? { requestInit: { headers: config.headers } } : undefined,
    );
  }
  // http
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
): Promise<OpenedConnection> {
  const transport = buildTransport(config);
  const client    = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} },
  );

  // 用超时包 connect。race 定局后必须清 timer - 否则每次成功 connect 都留一个
  // 30s 延迟的无监听 reject(unhandledRejection;--unhandled-rejections=strict 下致命)。
  // 同 execution.ts 模式。
  const connectPromise = client.connect(transport);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new McpTimeoutError(serverName, 'connect', CONNECT_TIMEOUT_MS)),
      CONNECT_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([connectPromise, timeout]);
  } catch (err) {
    // 失败时尝试优雅关闭 transport
    try { await transport.close(); } catch { /* ignore */ }
    if (err instanceof McpTimeoutError) throw err;
    throw new McpConnectionError(serverName, (err as Error).message ?? String(err));
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const cleanup = async () => {
    try { await client.close(); } catch { /* ignore */ }
  };

  return { client, cleanup };
}
