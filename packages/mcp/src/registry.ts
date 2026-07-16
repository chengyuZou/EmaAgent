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
  McpConnectionSupersededError,
  McpStdioPermissionError,
  McpTimeoutError,
} from './errors.js';

const TOOL_DISCOVERY_TIMEOUT_MS = 15_000;

interface McpServerRuntime {
  generation: number;
  configKey?: string;
  info: McpConnection;
  opened?: OpenedConnection;
  connectTask?: Promise<McpConnection>;
}

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
  /** 每个 Server 只有一个生命周期槽，generation 阻止迟到任务复活旧连接。 */
  private runtimes = new Map<string, McpServerRuntime>();
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

  connectConfig(serverName: string, config: McpServerConfig): Promise<McpConnection> {
    const runtime = this.runtimeFor(serverName);
    const configKey = JSON.stringify(config);

    // 相同配置的启动、手动连接和首次工具调用共享同一条连接流水线。
    if (runtime.configKey === configKey) {
      if (runtime.connectTask) return runtime.connectTask;
      if (runtime.opened && runtime.info.status === 'connected') {
        return Promise.resolve(copyConnection(runtime.info));
      }
    }

    return this.startConnection(serverName, config, configKey, runtime);
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
      const runtime = this.runtimes.get(record.name);
      if (runtime?.opened || runtime?.connectTask) continue;    // 已在线或正在连接
      const tools = record.cachedTools;
      if (!tools || tools.length === 0) continue;
      registrations.push(...toRegistrations(tools, this));
      pending.set(record.name, tools);
    }

    this.toolRegistry.registerMcpBatch(registrations);
    for (const [serverName, tools] of pending) {
      this.primed.set(serverName, tools);
      const runtime = this.runtimeFor(serverName);
      if (runtime.info.status === 'disconnected') {
        runtime.info = connectionInfo(serverName, 'disconnected', tools);
      }
    }
    return registrations.length;
  }

  async disconnect(serverName: string): Promise<void> {
    const runtime = this.runtimeFor(serverName);
    runtime.generation += 1;
    const opened = runtime.opened;
    const liveTools = runtime.info.status === 'connected' ? runtime.info.tools : [];
    runtime.opened = undefined;
    runtime.connectTask = undefined;
    runtime.configKey = undefined;
    runtime.info = connectionInfo(serverName, 'disconnected', []);

    // 注销缓存 primed 的工具(无实时连接时注册的)。
    const primedTools = this.primed.get(serverName);
    if (primedTools) {
      for (const tool of primedTools) {
        this.toolRegistry.unregisterMcp(tool.qualifiedName, ownerOf(tool));
      }
      this.primed.delete(serverName);
    }

    unregisterTools(this.toolRegistry, liveTools);
    if (opened) await cleanupQuietly(opened);
  }

  async disconnectAll(): Promise<void> {
    const pendingTasks = [...this.runtimes.values()]
      .map((runtime) => runtime.connectTask)
      .filter((task): task is Promise<McpConnection> => task !== undefined);
    const names = new Set([...this.runtimes.keys(), ...this.primed.keys()]);
    await Promise.all([...names].map((name) => this.disconnect(name)));
    await Promise.allSettled(pendingTasks);
  }

  // ── 工具调用 ─────────────────────────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    signal?:    AbortSignal,
  ): Promise<unknown> {
    let conn = this.runtimes.get(serverName)?.opened;
    // 懒连接:工具可能从缓存 primed(可见但未连接)。首次实际调用时开 transport。
    if (!conn) {
      await this.connect(serverName);                 // throws if server unknown / connect fails
      conn = this.runtimes.get(serverName)?.opened;
    }
    if (!conn) {
      throw new McpServerNotFoundError(`${serverName} (not connected)`);
    }
    return callMcpTool({ client: conn.client, serverName, toolName, args, signal });
  }

  // ── 自省 ─────────────────────────────────────────────────────────────────

  getConnection(serverName: string): McpConnection | null {
    const info = this.runtimes.get(serverName)?.info;
    return info ? copyConnection(info) : null;
  }

  getAllConnections(): McpConnection[] {
    return [...this.runtimes.values()].map((runtime) => copyConnection(runtime.info));
  }

  getTools(serverName: string): McpToolInfo[] {
    return [...(this.runtimes.get(serverName)?.info.tools ?? [])];
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

  private runtimeFor(serverName: string): McpServerRuntime {
    let runtime = this.runtimes.get(serverName);
    if (!runtime) {
      runtime = {
        generation: 0,
        info: connectionInfo(serverName, 'disconnected', this.primed.get(serverName) ?? []),
      };
      this.runtimes.set(serverName, runtime);
    }
    return runtime;
  }

  private startConnection(
    serverName: string,
    config: McpServerConfig,
    configKey: string,
    runtime: McpServerRuntime,
  ): Promise<McpConnection> {
    runtime.generation += 1;
    const generation = runtime.generation;
    const previous = runtime.opened;
    const previousTools = runtime.info.status === 'connected' ? runtime.info.tools : [];

    runtime.opened = undefined;
    runtime.configKey = configKey;
    runtime.info = connectionInfo(serverName, 'connecting', this.primed.get(serverName) ?? []);
    unregisterTools(this.toolRegistry, previousTools);

    const task = this.runConnection(serverName, config, runtime, generation, previous);
    runtime.connectTask = task;
    return task;
  }

  private async runConnection(
    serverName: string,
    config: McpServerConfig,
    runtime: McpServerRuntime,
    generation: number,
    previous?: OpenedConnection,
  ): Promise<McpConnection> {
    let opened: OpenedConnection | undefined;
    let retained = false;
    try {
      if (previous) await cleanupQuietly(previous);
      this.assertCurrent(serverName, runtime, generation);

      const authorizedConfig = await this.authorizeLaunch('connect', serverName, config);
      this.assertCurrent(serverName, runtime, generation);

      opened = await openConnection(serverName, authorizedConfig);
      this.assertCurrent(serverName, runtime, generation);

      const tools = await withTimeout(
        discoverServerTools(serverName, opened.client),
        TOOL_DISCOVERY_TIMEOUT_MS,
        () => new McpTimeoutError(serverName, 'tool discovery', TOOL_DISCOVERY_TIMEOUT_MS),
      );
      this.assertCurrent(serverName, runtime, generation);

      // 新批次先整体校验并提交，再移除缓存中已经消失的旧工具，避免半注册。
      this.toolRegistry.registerMcpBatch(toRegistrations(tools, this));
      const primedTools = this.primed.get(serverName) ?? [];
      const liveNames = new Set(tools.map((tool) => tool.qualifiedName));
      unregisterTools(
        this.toolRegistry,
        primedTools.filter((tool) => !liveNames.has(tool.qualifiedName)),
      );
      this.primed.delete(serverName);

      const info = connectionInfo(serverName, 'connected', tools, undefined, Date.now());
      runtime.info = info;
      runtime.opened = opened;
      retained = true;

      // 工具缓存失败不能破坏已经建立的实时连接。
      try { this.store.cacheTools(serverName, tools); } catch { /* ignore */ }
      return copyConnection(info);
    } catch (err) {
      if (runtime.generation !== generation) {
        throw err instanceof McpConnectionSupersededError
          ? err
          : new McpConnectionSupersededError(serverName);
      }
      const error = err instanceof Error ? err.message : String(err);
      runtime.info = connectionInfo(
        serverName,
        'failed',
        this.primed.get(serverName) ?? [],
        error,
      );
      throw err;
    } finally {
      if (!retained && opened) await cleanupQuietly(opened);
      if (runtime.generation === generation) runtime.connectTask = undefined;
    }
  }

  private assertCurrent(
    serverName: string,
    runtime: McpServerRuntime,
    generation: number,
  ): void {
    if (runtime.generation !== generation) {
      throw new McpConnectionSupersededError(serverName);
    }
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

function unregisterTools(toolRegistry: ToolRegistry, tools: readonly McpToolInfo[]): void {
  for (const tool of tools) {
    toolRegistry.unregisterMcp(tool.qualifiedName, ownerOf(tool));
  }
}

async function cleanupQuietly(connection: OpenedConnection): Promise<void> {
  try { await connection.cleanup(); } catch { /* ignore cleanup failure */ }
}

function connectionInfo(
  serverName: string,
  status: McpConnection['status'],
  tools: readonly McpToolInfo[],
  error?: string,
  connectedAt?: number,
): McpConnection {
  return {
    serverName,
    status,
    tools: [...tools],
    ...(error ? { error } : {}),
    ...(connectedAt !== undefined ? { connectedAt } : {}),
  };
}

function copyConnection(info: McpConnection): McpConnection {
  return { ...info, tools: [...info.tools] };
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
