import { randomUUID }       from 'node:crypto';
import type { McpToolOwner, McpToolRegistration, ToolRegistry } from '@ema-agent/tools';
import type { McpServerStore }                            from './store.js';
import type {
  McpServerConfig,
  McpStdioConfig,
  McpStdioLaunchIntent,
  McpConnection,
  McpProbeResult,
  McpToolInfo,
} from './types.js';
import { openConnection }                                from './connection.js';
import type { OpenedConnection }                         from './connection.js';
import { discoverServerTools, buildMcpBuiltTool }       from './discovery.js';
import { callMcpTool }                                   from './execution.js';
import {
  McpServerNotFoundError,
  McpStdioPermissionError,
  McpTimeoutError,
} from './errors.js';

const TOOL_DISCOVERY_TIMEOUT_MS = 15_000;

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
  intent: McpStdioLaunchIntent,
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
    const authorizedConfig = await this.authorizeLaunch('connect', serverName, config);

    await this.disconnect(serverName);

    const opened = await openConnection(serverName, authorizedConfig);
    let retained = false;
    try {
      const tools = await withTimeout(
        discoverServerTools(serverName, opened.client),
        TOOL_DISCOVERY_TIMEOUT_MS,
        () => new McpTimeoutError(serverName, 'tool discovery', TOOL_DISCOVERY_TIMEOUT_MS),
      );
      const info: McpConnection = {
        serverName,
        status:      'connected',
        tools,
        connectedAt: Date.now(),
      };

      this.toolRegistry.registerMcpBatch(toRegistrations(tools, this));
      this.connections.set(serverName, { ...opened, info });
      retained = true;

      // Persist the live tool list so next startup can prime the registry without
      // connecting (fast/offline). Best-effort — caching failure must not break connect.
      try { this.store.cacheTools(serverName, tools); } catch { /* ignore */ }

      return info;
    } finally {
      // 只有成功写入 connections 后，transport 生命周期才移交给 disconnect()。
      if (!retained) {
        try { await opened.cleanup(); } catch { /* ignore cleanup failure */ }
      }
    }
  }

  /**
   * Register cached tools for all enabled servers WITHOUT connecting. Tools
   * become visible to the LLM immediately at startup; the actual transport is
   * opened lazily on first callTool (see below). Call once at boot, before/instead
   * of an eager connect-all.
   */
  primeFromCache(): number {
    const registrations: McpToolRegistration[] = [];
    const pending = new Map<string, McpToolInfo[]>();
    for (const record of this.store.listEnabled()) {
      if (this.connections.has(record.name)) continue;          // already live
      const tools = record.cachedTools;
      if (!tools || tools.length === 0) continue;
      registrations.push(...toRegistrations(tools, this));
      pending.set(record.name, tools);
    }

    this.toolRegistry.registerMcpBatch(registrations);
    for (const [serverName, tools] of pending) this.primed.set(serverName, tools);
    return registrations.length;
  }

  async disconnect(serverName: string): Promise<void> {
    // Unregister cache-primed tools (registered without a live connection).
    const primedTools = this.primed.get(serverName);
    if (primedTools) {
      for (const tool of primedTools) {
        this.toolRegistry.unregisterMcp(tool.qualifiedName, ownerOf(tool));
      }
      this.primed.delete(serverName);
    }

    const conn = this.connections.get(serverName);
    if (!conn) return;

    for (const tool of conn.info.tools) {
      this.toolRegistry.unregisterMcp(tool.qualifiedName, ownerOf(tool));
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

  async probe(serverName: string, config: McpServerConfig): Promise<McpProbeResult> {
    const probeName = serverName.trim() || `probe-${randomUUID()}`;
    let connection: OpenedConnection | undefined;
    try {
      const authorizedConfig = await this.authorizeLaunch('probe', probeName, config);
      connection = await openConnection(probeName, authorizedConfig);
      const tools = await withTimeout(
        discoverServerTools(probeName, connection.client),
        TOOL_DISCOVERY_TIMEOUT_MS,
        () => new McpTimeoutError(probeName, 'tool discovery', TOOL_DISCOVERY_TIMEOUT_MS),
      );
      return { ok: true, tools };
    } catch (err) {
      return { ok: false, tools: [], error: (err as Error).message };
    } finally {
      if (connection) {
        try { await connection.cleanup(); } catch { /* ignore cleanup failure */ }
      }
    }
  }

  private async authorizeLaunch(
    operation: 'connect' | 'probe',
    serverName: string,
    config: McpServerConfig,
  ): Promise<McpServerConfig> {
    if (config.type !== 'stdio') return config;

    // 建立一份审批与执行共享的运行时不可变快照，等待用户期间不能原地改参。
    const snapshot = freezeStdioConfig(config);
    if (!this.stdioGate) {
      throw new McpStdioPermissionError(operation, serverName, 'gate_unavailable');
    }

    const intent: McpStdioLaunchIntent = Object.freeze({
      operation,
      serverName,
      command: snapshot.command,
      args: snapshot.args,
      cwd: snapshot.cwd,
      environment: snapshot.env,
    });
    if (!await this.stdioGate(intent)) {
      throw new McpStdioPermissionError(operation, serverName, 'denied');
    }
    return snapshot;
  }
}

function ownerOf(tool: McpToolInfo): McpToolOwner {
  return {
    serverName: tool.originalServerName,
    serverToolName: tool.serverToolName,
  };
}

function toRegistrations(
  tools: readonly McpToolInfo[],
  registry: McpRegistry,
): McpToolRegistration[] {
  return tools.map((tool) => ({
    tool: buildMcpBuiltTool(tool, registry),
    owner: ownerOf(tool),
  }));
}

function freezeStdioConfig(config: McpStdioConfig): McpStdioConfig {
  const args = [...config.args];
  Object.freeze(args);
  const env = config.env ? { ...config.env } : undefined;
  if (env) Object.freeze(env);
  return Object.freeze({
    type: 'stdio',
    command: config.command,
    args,
    cwd: config.cwd,
    env,
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
