// 这里管理 MCP 服务器的连接、工具发现、调用和本地进程启动门禁。

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
 * apps/core 注入的可选回调,在创建子进程前经 PermissionEngine 门禁 stdio MCP server 拉起。
 *
 * 返回 true 允许连接,false 阻止。
 * 仅对 `type === 'stdio'` 配置调用;HTTP/SSE 服务器自由连接
 * (它们不在 sidecar 权限下拉起本地子进程)。
 */
export type McpStdioPermissionGate = (
  intent: McpStdioLaunchIntent,
) => Promise<boolean>;

export class McpRegistry {
  private connections = new Map<string, OpenedConnection & { info: McpConnection }>();
  /** 从缓存注册的工具(服务器尚未连接)。按服务器名索引。 */
  private primed = new Map<string, McpToolInfo[]>();

  constructor(
    private readonly store:        McpServerStore,
    private readonly toolRegistry: ToolRegistry,
    /**
     * 提供时,stdio 服务器连接经此回调门禁。
     * apps/core 在此接 PermissionEngine.gate() 调用,使启用 stdio MCP server
     * 需用户显式批准 - 与 shell 工具调用门禁一致。
     */
    private readonly stdioGate?:   McpStdioPermissionGate,
    /** false 时不连接或展示需要启动本地进程的 stdio MCP。 */
    private readonly stdioEnabled = true,
  ) {}

  // ── 连接管理 ─────────────────────────────────────────────────────────────

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

      // 持久化实时工具列表,使下次启动可不连接即 priming 注册表(快速/离线)。
      // 尽力而为 - 缓存失败不能破坏 connect。
      try { this.store.cacheTools(serverName, tools); } catch { /* ignore */ }

      return info;
    } finally {
      // 只有成功写入 connections 后,transport 生命周期才移交给 disconnect()。
      if (!retained) {
        try { await opened.cleanup(); } catch { /* ignore cleanup failure */ }
      }
    }
  }

  /**
   * 为所有启用的服务器注册缓存工具,不连接。工具在启动时即对 LLM 可见;
   * 实际 transport 在首次 callTool 时懒开(见下)。启动时调一次,
   * 在/替代急切 connect-all 之前。
   */
  primeFromCache(): number {
    const registrations: McpToolRegistration[] = [];
    const pending = new Map<string, McpToolInfo[]>();
    for (const record of this.store.listEnabled()) {
      if (record.config.type === 'stdio' && !this.stdioEnabled) continue;
      if (this.connections.has(record.name)) continue;          // 已在线
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
    // 注销缓存 primed 的工具(无实时连接时注册的)。
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

  // ── 工具调用 ─────────────────────────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    signal?:    AbortSignal,
  ): Promise<unknown> {
    let conn = this.connections.get(serverName);
    // 懒连接:工具可能从缓存 primed(可见但未连接)。首次实际调用时开 transport。
    if (!conn || conn.info.status !== 'connected') {
      await this.connect(serverName);                 // throws if server unknown / connect fails
      conn = this.connections.get(serverName);
    }
    if (!conn || conn.info.status !== 'connected') {
      throw new McpServerNotFoundError(`${serverName} (not connected)`);
    }
    return callMcpTool({ client: conn.client, serverName, toolName, args, signal });
  }

  // ── 自省 ─────────────────────────────────────────────────────────────────

  getConnection(serverName: string): McpConnection | null {
    return this.connections.get(serverName)?.info ?? null;
  }

  getAllConnections(): McpConnection[] {
    return [...this.connections.values()].map((c) => c.info);
  }

  getTools(serverName: string): McpToolInfo[] {
    return this.connections.get(serverName)?.info.tools ?? [];
  }

  // ── 服务器 CRUD(委托 store)─────────────────────────────────────────────

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
    const enabled = this.store.listEnabled().filter(
      record => record.config.type !== 'stdio' || this.stdioEnabled,
    );
    await Promise.allSettled(
      enabled.map((r) =>
        this.connectConfig(r.name, r.config).catch((err) => {
          console.warn(`[mcp] Failed to connect "${r.name}": ${(err as Error).message}`);
        }),
      ),
    );
  }

  // ── 探测 ────────────────────────────────────────────────────────────────

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
    if (!this.stdioEnabled) {
      throw new McpStdioPermissionError(operation, serverName, 'denied');
    }

    // 建立一份审批与执行共享的运行时不可变快照,等待用户期间不能原地改参。
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
