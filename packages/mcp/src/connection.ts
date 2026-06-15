import { Client }             from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

// ── Transport factory ─────────────────────────────────────────────────────────

function buildTransport(config: McpServerConfig): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args:    config.args,
      env:     config.env,
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

// ── Connection ────────────────────────────────────────────────────────────────

export interface OpenedConnection {
  client:  Client;
  cleanup: () => Promise<void>;
}

/**
 * Open a connection to an MCP server. Resolves when the SDK handshake
 * completes (initialize ↔ initialized). Throws on timeout or protocol error.
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
  // settles — otherwise every successful connect leaves a 30s-delayed
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
