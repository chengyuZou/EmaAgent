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

export class McpRegistry {
  private connections = new Map<string, OpenedConnection & { info: McpConnection }>();

  constructor(
    private readonly store:        McpServerStore,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  // ── Connection management ─────────────────────────────────────────────────

  async connect(serverName: string): Promise<McpConnection> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    return this.connectConfig(serverName, record.config);
  }

  async connectConfig(serverName: string, config: McpServerConfig): Promise<McpConnection> {
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

    return info;
  }

  async disconnect(serverName: string): Promise<void> {
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
    const conn = this.connections.get(serverName);
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
