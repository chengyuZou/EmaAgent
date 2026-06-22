import { z } from 'zod';

// ── Server configuration ──────────────────────────────────────────────────────
//
// V1 supports three transport types that cover the vast majority of mcp.so servers:
//   stdio   — spawn a local subprocess (npx, uvx, node, python, etc.)
//   sse     — connect to a remote SSE endpoint (legacy HTTP streaming)
//   http    — connect to a remote HTTP endpoint (modern MCP protocol)

export const McpStdioConfigSchema = z.object({
  type:    z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args:    z.array(z.string()).default([]),
  env:     z.record(z.string(), z.string()).optional(),
  /** Working directory for the spawned subprocess. Some servers require it. */
  cwd:     z.string().optional(),
});

// 'sse' uses the legacy SSEClientTransport (deprecated in MCP SDK ≥1.x).
// Many servers on mcp.so (Zhipu, Baidu, etc.) still publish SSE endpoints.
// Keep registering new servers with 'http' when the server supports it.
export const McpSseConfigSchema = z.object({
  type:    z.literal('sse'),
  url:     z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpHttpConfigSchema = z.object({
  type:    z.literal('http'),
  url:     z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  McpStdioConfigSchema,
  McpSseConfigSchema,
  McpHttpConfigSchema,
]);

export type McpStdioConfig  = z.infer<typeof McpStdioConfigSchema>;
export type McpSseConfig    = z.infer<typeof McpSseConfigSchema>;
export type McpHttpConfig   = z.infer<typeof McpHttpConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ── Persisted server record ───────────────────────────────────────────────────

export interface McpServerRecord {
  id:          string;
  name:        string;           // user-facing alias
  sourceUrl?:  string;           // mcp.so page URL (optional)
  config:      McpServerConfig;  // parsed transport config
  /** Tools from the last successful listTools — used to prime the registry at
   *  startup without connecting, and to show tools while a server is offline. */
  cachedTools?: McpToolInfo[];
  cachedAt:    number;           // ms; 0 = never cached
  enabled:     boolean;
  installedAt: number;
}

// ── Connection state machine ──────────────────────────────────────────────────
//
// connected    — SDK Client open, tools discovered
// connecting   — in progress (async connect)
// failed       — connect threw or timed out
// disconnected — explicitly stopped, or not yet started

export type McpConnectionStatus = 'connecting' | 'connected' | 'failed' | 'disconnected';

export interface McpToolInfo {
  /** Unqualified tool name as the server reports it, e.g. "search". */
  serverToolName:     string;
  /** Qualified name registered in ToolRegistry, e.g. "mcp__brave_search__search". */
  qualifiedName:      string;
  /**
   * Original server name as configured by the user, e.g. "brave-search".
   * Used as the key into McpRegistry.connections — must NOT be sanitized.
   * Kept separate from qualifiedName because buildMcpToolName() replaces
   * hyphens/dots/spaces with underscores for the LLM-visible identifier,
   * but the connection map is keyed by the original name.
   */
  originalServerName: string;
  description:        string;
  inputSchema:        Record<string, unknown>;
  isReadOnly:         boolean;
  isDestructive:      boolean;
}

export interface McpConnection {
  serverName: string;
  status:     McpConnectionStatus;
  tools:      McpToolInfo[];
  error?:     string;
  connectedAt?: number;
}

// ── Tool naming ───────────────────────────────────────────────────────────────

export function buildMcpToolName(serverName: string, toolName: string): string {
  // Sanitize: replace non-alphanumeric with underscore
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
  return `mcp__${safe(serverName)}__${safe(toolName)}`;
}
