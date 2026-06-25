import { Client }             from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
// SSEClientTransport is deprecated in the MCP SDK (prefer StreamableHTTPClientTransport),
// but many published servers (e.g. Zhipu, Baidu) still use the legacy SSE protocol.
// We keep it for backward compatibility during the migration period.
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { SSEClientTransport }   from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';
import { McpConnectionError, McpTimeoutError } from './errors.js';

const CLIENT_NAME    = 'ema-agent';
const CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 30_000;

// 鈹€鈹€ stdio safety validation (defense-in-depth on top of the permission gate) 鈹€鈹€

const SHELL_META_RE   = /[;&|`$(){}<>\n\r]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

/**
 * Reject obviously-unsafe stdio configs before spawning a subprocess: shell
 * metacharacters in the command, control characters in args, and inline-code
 * flags (python -c, node -e/--eval) that would run arbitrary code outside the
 * intended MCP server entrypoint.
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

// 鈹€鈹€ Transport factory 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function buildTransport(config: McpServerConfig): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (config.type === 'stdio') {
    assertSafeStdioConfig(config.command, config.args);
    return new StdioClientTransport({
      command: config.command,
      args:    config.args,
      cwd:     config.cwd,
      // MUST merge the SDK's default env (PATH, HOME, 鈥?. Passing only the
      // user's env would strip PATH and break `npx`/`node`/`uvx` resolution 鈥?      // the #1 cause of "stdio server won't start". User keys override defaults.
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

// 鈹€鈹€ Connection 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface OpenedConnection {
  client:  Client;
  cleanup: () => Promise<void>;
}

/**
 * Open a connection to an MCP server. Resolves when the SDK handshake
 * completes (initialize 鈫?initialized). Throws on timeout or protocol error.
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

  // Wrap connect in a timeout. The timer MUST be cleared once the race
  // settles 鈥?otherwise every successful connect leaves a 30s-delayed
  // rejection with no listener (unhandledRejection; fatal under
  // --unhandled-rejections=strict). Same pattern as execution.ts.
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
    // Attempt graceful transport close on failure
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
