import { randomUUID }       from 'node:crypto';
import type { ToolRegistry } from '@ema-agent/tool';
import type { McpServerStore }                            from './store.js';
import type { McpServerConfig, McpConnection, McpToolInfo } from './types.js';
import { openConnection }                                from './connection.js';
import type { OpenedConnection }                         from './connection.js';
import { discoverServerTools, buildMcpBuiltTool }       from './discovery.js';
import { callMcpTool }                                   from './execution.js';
import { McpServerNotFoundError }                        from './errors.js';

// ── McpRegistry ───────────────────────────────────────────────────────────────

/**
 * Optional callback injected by apps/core to gate stdio MCP server spawning
 * through PermissionEngine before the subprocess is created.
 *
 * Return true to allow the connection, false to block it.
 * Only called for `type === 'stdio'` configs; HTTP/SSE servers connect freely
 * (they don't spawn local subprocesses under the sidecar's privileges).
 */
export type McpStdioPermissionGate = (
  serverName: string,
  command:    string,
  args?:      string[],
) => Promise<boolean>;

export class McpRegistry {
  private connections = new Map<string, OpenedConnection & { info: McpConnection }>();
  /** Tools registered from cache (server not yet connected). Keyed by server name. */
  private primed = new Map<string, McpToolInfo[]>();

  constructor(
    private readonly store:        McpServerStore,
    private readonly toolRegistry: ToolRegistry,
    /**
     * When provided, stdio server connections are gated through this callback.
     * Apps/core wires a PermissionEngine.gate() call here so that enabling a
     * stdio MCP server requires explicit user approval — identical to how
     * shell tool calls are gated.
     */
    private readonly stdioGate?:   McpStdioPermissionGate,
  ) {}

  // ── Connection management ─────────────────────────────────────────────────

  async connect(serverName: string): Promise<McpConnection> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    return this.connectConfig(serverName, record.config);
  }

  async connectConfig(serverName: string, config: McpServerConfig): Promise<McpConnection> {
    // Gate stdio connections through PermissionEngine BEFORE spawning.
    // stdio servers run as subprocesses with the sidecar's full OS privileges;
    // they must be treated as execute-class actions, not passive config.
    if (config.type === 'stdio' && this.stdioGate) {
      const allowed = await this.stdioGate(serverName, config.command, config.args);
      if (!allowed) {
        throw new Error(
          `MCP stdio server "${serverName}" was blocked by the permission system. ` +
          `Approve it from Settings → MCP Servers to connect.`,
        );
      }
    }

    await this.disconnect(serverName);

    const opened = await openConnection(serverName, config);
    const tools  = await discoverServerTools(serverName, opened.client);

    const info: McpConnection = {
      serverName,
      status:      'connected',
      tools,
      connectedAt: Date.now(),
    };

    this.connections.set(serverName, { ...opened, info });

    for (const toolInfo of tools) {
      this.toolRegistry.registerMcp(buildMcpBuiltTool(toolInfo, this));
    }

    // Persist the live tool list so next startup can prime the registry without
    // connecting (fast/offline). Best-effort — caching failure must not break connect.
    try { this.store.cacheTools(serverName, tools); } catch { /* ignore */ }

    return info;
  }

  /**
   * Register cached tools for all enabled servers WITHOUT connecting. Tools
   * become visible to the LLM immediately at startup; the actual transport is
   * opened lazily on first callTool (see below). Call once at boot, before/instead
   * of an eager connect-all.
   */
  primeFromCache(): number {
    let primedCount = 0;
    for (const record of this.store.listEnabled()) {
      if (this.connections.has(record.name)) continue;          // already live
      const tools = record.cachedTools;
      if (!tools || tools.length === 0) continue;
      for (const toolInfo of tools) {
        this.toolRegistry.registerMcp(buildMcpBuiltTool(toolInfo, this));
      }
      this.primed.set(record.name, tools);
      primedCount += tools.length;
    }
    return primedCount;
  }

  async disconnect(serverName: string): Promise<void> {
    // Unregister cache-primed tools (registered without a live connection).
    const primedTools = this.primed.get(serverName);
    if (primedTools) {
      for (const tool of primedTools) this.toolRegistry.unregisterMcp(tool.qualifiedName);
      this.primed.delete(serverName);
    }

    const conn = this.connections.get(serverName);
    if (!conn) return;

    for (const tool of conn.info.tools) {
      this.toolRegistry.unregisterMcp(tool.qualifiedName);
    }

    try { await conn.cleanup(); } catch { /* ignore */ }
    this.connections.delete(serverName);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((n) => this.disconnect(n)));
  }

  // ── Tool call ─────────────────────────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    signal?:    AbortSignal,
  ): Promise<unknown> {
    let conn = this.connections.get(serverName);
    // Lazy connect: tools may have been primed from cache (visible but not yet
    // connected). Open the transport on first actual call.
    if (!conn || conn.info.status !== 'connected') {
      await this.connect(serverName);                 // throws if server unknown / connect fails
      conn = this.connections.get(serverName);
    }
    if (!conn || conn.info.status !== 'connected') {
      throw new McpServerNotFoundError(`${serverName} (not connected)`);
    }
    return callMcpTool({ client: conn.client, serverName, toolName, args, signal });
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  getConnection(serverName: string): McpConnection | null {
    return this.connections.get(serverName)?.info ?? null;
  }

  getAllConnections(): McpConnection[] {
    return [...this.connections.values()].map((c) => c.info);
  }

  getTools(serverName: string): McpToolInfo[] {
    return this.connections.get(serverName)?.info.tools ?? [];
  }

  // ── Server CRUD (delegated to store) ─────────────────────────────────────

  register(name: string, config: McpServerConfig, sourceUrl?: string): string {
    return this.store.register(name, config, sourceUrl);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.store.setEnabled(name, enabled);
  }

  remove(name: string): void {
    this.store.remove(name);
  }

  listRecords() {
    return this.store.listAll();
  }

  async startAll(): Promise<void> {
    const enabled = this.store.listEnabled();
    await Promise.allSettled(
      enabled.map((r) =>
        this.connectConfig(r.name, r.config).catch((err) => {
          console.warn(`[mcp] Failed to connect "${r.name}": ${(err as Error).message}`);
        }),
      ),
    );
  }

  // ── Probe ────────────────────────────────────────────────────────────────

  async probe(config: McpServerConfig): Promise<{ ok: boolean; tools: string[]; error?: string }> {
    const tempName = `__probe_${randomUUID()}`;
    try {
      const conn  = await openConnection(tempName, config);
      const tools = await discoverServerTools(tempName, conn.client);
      await conn.cleanup();
      return { ok: true, tools: tools.map((t) => t.serverToolName) };
    } catch (err) {
      return { ok: false, tools: [], error: (err as Error).message };
    }
  }
}
