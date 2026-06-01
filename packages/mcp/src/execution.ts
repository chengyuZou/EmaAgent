import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client }          from '@modelcontextprotocol/sdk/client/index.js';
import { McpToolCallError }     from './errors.js';

const DEFAULT_TOOL_TIMEOUT_MS = 120_000; // 2 min — same as bash default

export interface CallToolOptions {
  client:      Client;
  serverName:  string;
  toolName:    string;            // unqualified, as registered on the server
  args:        Record<string, unknown>;
  signal?:     AbortSignal;
  timeoutMs?:  number;
}

/**
 * Call a tool on an already-connected MCP server client.
 * Returns the raw MCP result content.
 */
export async function callMcpTool(opts: CallToolOptions): Promise<unknown> {
  const { client, serverName, toolName, args, signal, timeoutMs } = opts;
  const ms = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new McpToolCallError(serverName, toolName, `timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    const result = await Promise.race([
      client.callTool(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        { signal },
      ),
      timeoutPromise,
    ]);

    if (result.isError) {
      const text = Array.isArray(result.content) && result.content.length > 0
        ? (result.content[0] as { text?: string }).text ?? 'unknown error'
        : 'unknown error';
      throw new McpToolCallError(serverName, toolName, text);
    }

    return result.content;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
