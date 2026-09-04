// MCP 服务器注册表管理连接、工具发现、调用和断线重试。

import { randomUUID }       from 'node:crypto';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolRegistry } from '@ema-agent/tools';
import type { McpServerStore }                            from './store.js';
import type {
  McpServerConfig,
  McpServerRecord,
  McpConnection,
  McpProbeResult,
  McpToolInfo,
  McpInstallProvenance,
} from './types.js';
import { openConnection }                                from './connection.js';
import type { OpenedConnection }                         from './connection.js';
import { discoverServerTools, buildMcpBuiltTool }       from './discovery.js';
import { callMcpTool }                                   from './execution.js';
import type { McpToolOutput }                            from './execution.js';
import {
  cleanupQuietly,
  connectionInfo,
  copyConnection,
  linkedAbortController,
  waitForPromise,
  withTimeout,
} from './utils.js';
import {
  McpServerNotFoundError,
  McpConnectionError,
  McpConnectionSupersededError,
  McpTimeoutError,
} from './errors.js';

const TOOL_DISCOVERY_TIMEOUT_MS = 15_000;

interface McpServer {
  /** 代际令牌:每次生命周期操作递增;迟到任务据此识别自己已被取代,不得复活旧连接。 */
  generation: number;
  /** 当前配置的 JSON:同配置的并发调用共享同一条连接管道,配置变化触发重连。 */
  configJson?: string;
  /** 对外状态投影(UI/路由只读):状态、已知工具与最近错误。 */
  info: McpConnection;
  /** 已提交的实时连接;undefined = 连接中/已断开/已失败。 */
  opened?: OpenedConnection;
  /** 在建连接 Promise:并发 connect/callTool 共享同一管道,避免重复拉起进程与重复权限询问。 */
  connectTask?: Promise<McpConnection>;
  /** 中止本代在建连接与刷新循环的执行手柄;disconnect/被新一代取代时触发。 */
  lifecycleAbort?: AbortController;
  /** 工具刷新循环 Promise:防止 list_changed 连发产生多个并发刷新。 */
  refreshTask?: Promise<void>;
  /** 脏标志:连接期间或循环中途收到的 list_changed 合并为一次刷新。 */
  refreshRequested?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryAttempt?: number;
}

// ── McpRegistry ───────────────────────────────────────────────────────────────

export class McpRegistry {
  /** 每个 Server 只有一个生命周期槽，generation 阻止迟到任务复活旧连接。 */
  private servers = new Map<string, McpServer>();
  /** 从缓存注册的工具(服务器尚未连接)。按服务器名索引。 */
  private primed = new Map<string, McpToolInfo[]>();

  constructor(
    private readonly store:        McpServerStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly connectionChanged: (connection: McpConnection) => void = () => {},
  ) {}

  // ── 连接管理 ─────────────────────────────────────────────────────────────

  async connect(serverName: string): Promise<McpConnection> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    // 禁用即不可连接:不拉进程、不发请求,与 setEnabled(false) 的断开配对。
    if (!record.enabled) {
      throw new McpConnectionError(serverName, 'server is disabled');
    }
    return this.connectConfig(serverName, record.config);
  }

  connectConfig(serverName: string, config: McpServerConfig): Promise<McpConnection> {
    const server = this.serverFor(serverName);
    const configJson = JSON.stringify(config);

    // 相同配置的启动、手动连接和首次工具调用共享同一条连接流水线。
    if (server.configJson === configJson) {
      if (server.connectTask) return server.connectTask;
      if (server.opened && server.info.status === 'connected') {
        return Promise.resolve(copyConnection(server.info));
      }
    }

    return this.startConnection(serverName, config, configJson, server);
  }

  connectInBackground(serverName: string): void {
    void this.connect(serverName).catch(() => undefined);
  }

  connectEnabledInBackground(): void {
    for (const record of this.store.listEnabled()) this.connectInBackground(record.name);
  }

  /**
   * 为所有启用的服务器注册缓存工具。装配点紧接着并发连接全部启用服务器,
   * 缓存只覆盖连接完成前的启动窗口。
   */
  primeFromCache(): number {
    const tools: AnyMcpTool[] = [];
    const pending = new Map<string, McpToolInfo[]>();
    for (const record of this.store.listEnabled()) {
      const cached = this.primableTools(record);
      if (!cached) continue;
      tools.push(...toTools(cached, this));
      pending.set(record.name, cached);
    }

    this.toolRegistry.registerMcpBatch(tools);
    for (const [serverName, cached] of pending) {
      this.primed.set(serverName, cached);
      const server = this.serverFor(serverName);
      if (server.info.status === 'disconnected') {
        server.info = connectionInfo(serverName, 'disconnected', cached);
        this.publish(server.info);
      }
    }
    return tools.length;
  }

  /** 可预填则返回缓存工具;已在线/连接中或无缓存时返回 null。 */
  private primableTools(record: McpServerRecord): McpToolInfo[] | null {
    const server = this.servers.get(record.name);
    if (server?.opened || server?.connectTask) return null;    // 已在线或正在连接
    const cached = record.cachedTools;
    return cached && cached.length > 0 ? cached : null;
  }

  async disconnect(serverName: string): Promise<void> {
    const server = this.serverFor(serverName);
    server.generation += 1;
    if (server.retryTimer) clearTimeout(server.retryTimer);
    const superseded = new McpConnectionSupersededError(serverName);
    server.lifecycleAbort?.abort(superseded);
    const opened = server.opened;
    const liveTools = server.info.status === 'connected' ? server.info.tools : [];
    server.opened = undefined;
    server.connectTask = undefined;
    server.lifecycleAbort = undefined;
    server.refreshTask = undefined;
    server.refreshRequested = false;
    server.retryTimer = undefined;
    server.retryAttempt = undefined;
    server.configJson = undefined;
    server.info = connectionInfo(serverName, 'disconnected', []);
    this.publish(server.info);

    // 注销缓存 primed 的工具(无实时连接时注册的)。
    const primedTools = this.primed.get(serverName);
    if (primedTools) {
      unregisterTools(this.toolRegistry, primedTools);
      this.primed.delete(serverName);
    }

    unregisterTools(this.toolRegistry, liveTools);
    if (opened) await cleanupQuietly(opened);
  }

  async disconnectAll(): Promise<void> {
    const pendingTasks = [...this.servers.values()]
      .flatMap((server) => [server.connectTask, server.refreshTask])
      .filter((task) => task !== undefined);
    const names = new Set([...this.servers.keys(), ...this.primed.keys()]);
    await Promise.all([...names].map((name) => this.disconnect(name)));
    await Promise.allSettled(pendingTasks);
  }

  // ── 工具调用 ─────────────────────────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    signal?:    AbortSignal,
  ): Promise<McpToolOutput> {
    // per-server toolTimeoutSec 覆盖默认 120s;记录只在此处查一次(SQLite µs 级)。
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    // 禁用服务器的工具可能仍冻结在运行中的旧 ToolPool 里;不得为它拉起进程。
    if (!record.enabled) {
      throw new McpConnectionError(serverName, 'server is disabled');
    }
    const timeoutMs = record.config.toolTimeoutSec !== undefined
      ? record.config.toolTimeoutSec * 1000
      : undefined;
    // Tool 调用兜底重连与后台连接共用同一条管道。
    await waitForPromise(this.connectConfig(serverName, record.config), signal);
    const conn = this.servers.get(serverName)?.opened;
    if (!conn) {
      throw new McpServerNotFoundError(`${serverName} (not connected)`);
    }
    return callMcpTool({ client: conn.client, serverName, toolName, args, signal, timeoutMs });
  }

  // ── 自省 ─────────────────────────────────────────────────────────────────

  getConnection(serverName: string): McpConnection | null {
    const info = this.servers.get(serverName)?.info;
    return info ? copyConnection(info) : null;
  }

  getAllConnections(): McpConnection[] {
    return [...this.servers.values()].map((server) => copyConnection(server.info));
  }

  getTools(serverName: string): McpToolInfo[] {
    return [...(this.servers.get(serverName)?.info.tools ?? [])];
  }

  // ── 服务器 CRUD(委托 store)─────────────────────────────────────────────

  register(
    name: string,
    config: McpServerConfig,
    provenance?: McpInstallProvenance,
  ): string {
    return this.store.register(name, config, provenance);
  }

  async save(
    name: string,
    config: McpServerConfig,
    provenance?: McpInstallProvenance,
  ): Promise<string> {
    if (this.store.findByName(name)) await this.disconnect(name);
    const id = this.store.register(name, config, provenance);
    this.connectInBackground(name);
    return id;
  }

  findByName(name: string) {
    return this.store.findByName(name);
  }

  /**
   * 启用/禁用与连接生命周期配对,不变量收在领域内而不是交给调用方:
   * 禁用 = 断开并摘除全部工具;启用 = 立即后台连接。
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    this.store.setEnabled(name, enabled);
    if (!enabled) {
      await this.disconnect(name);
      return;
    }
    this.connectInBackground(name);
  }

  /** 删除即先断开:不得留下运行中的子进程或仍注册的工具。 */
  async remove(name: string): Promise<void> {
    await this.disconnect(name);
    this.store.remove(name);
  }

  listRecords() {
    return this.store.listAll();
  }

  // ── 探测 ────────────────────────────────────────────────────────────────

  async probe(
    serverName: string,
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<McpProbeResult> {
    const probeName = serverName.trim() || `probe-${randomUUID()}`;
    const linked = linkedAbortController(signal);
    let connection: OpenedConnection | undefined;
    try {
      linked.controller.signal.throwIfAborted();
      connection = await openConnection(probeName, config, linked.controller.signal);
      const tools = await withTimeout(
        discoverServerTools(probeName, connection.client, linked.controller.signal),
        TOOL_DISCOVERY_TIMEOUT_MS,
        () => new McpTimeoutError(probeName, 'tool discovery', TOOL_DISCOVERY_TIMEOUT_MS),
        (error) => linked.controller.abort(error),
      );
      return { ok: true, tools };
    } catch (err) {
      return { ok: false, tools: [], error: (err as Error).message };
    } finally {
      linked.dispose();
      if (connection) {
        try { await connection.cleanup(); } catch { /* ignore cleanup failure */ }
      }
    }
  }

  private serverFor(serverName: string): McpServer {
    let server = this.servers.get(serverName);
    if (!server) {
      server = {
        generation: 0,
        info: connectionInfo(serverName, 'disconnected', this.primed.get(serverName) ?? []),
      };
      this.servers.set(serverName, server);
    }
    return server;
  }

  private startConnection(
    serverName: string,
    config: McpServerConfig,
    configJson: string,
    server: McpServer,
  ): Promise<McpConnection> {
    if (server.retryTimer) clearTimeout(server.retryTimer);
    server.retryTimer = undefined;
    server.retryAttempt = undefined;
    server.generation += 1;
    const generation = server.generation;
    const superseded = new McpConnectionSupersededError(serverName);
    server.lifecycleAbort?.abort(superseded);
    const lifecycleAbort = new AbortController();
    const previous = server.opened;
    const previousTools = server.info.status === 'connected' ? server.info.tools : [];

    server.opened = undefined;
    server.configJson = configJson;
    server.lifecycleAbort = lifecycleAbort;
    server.refreshTask = undefined;
    server.refreshRequested = false;
    server.info = connectionInfo(serverName, 'connecting', this.primed.get(serverName) ?? []);
    this.publish(server.info);
    unregisterTools(this.toolRegistry, previousTools);

    const task = this.runConnection(
      serverName,
      config,
      server,
      generation,
      lifecycleAbort,
      previous,
    );
    server.connectTask = task;
    return task;
  }

  private async runConnection(
    serverName: string,
    config: McpServerConfig,
    server: McpServer,
    generation: number,
    lifecycleAbort: AbortController,
    previous?: OpenedConnection,
  ): Promise<McpConnection> {
    let opened: OpenedConnection | undefined;
    let retained = false;
    let connectionCommitted = false;
    let lastTransportError: Error | undefined;
    let closedError: Error | undefined;
    try {
      if (previous) await cleanupQuietly(previous);
      this.assertCurrent(serverName, server, generation);

      opened = await openConnection(serverName, config, lifecycleAbort.signal);
      this.assertCurrent(serverName, server, generation);

      // SDK 的 onerror 可能是可恢复协议错误，因此只记住诊断；只有 onclose
      // 才表示当前 Client 已不可继续使用。显式 disconnect/reconnect 会先推进
      // generation，迟到的 close 回调不能覆盖新一代状态。
      const previousOnError = opened.client.onerror;
      const previousOnClose = opened.client.onclose;
      opened.client.onerror = (error) => {
        lastTransportError = error;
        previousOnError?.(error);
      };
      opened.client.onclose = () => {
        const error = lastTransportError ?? new Error(
          `[MCP:${serverName}] transport closed unexpectedly`,
        );
        closedError = error;
        if (connectionCommitted && opened) {
          this.handleUnexpectedClose(serverName, server, generation, opened, error);
        }
        previousOnClose?.();
      };

      // 先监听变化，再做初次 listTools。连接阶段收到的通知会先记账，
      // 初次提交完成后立即刷新，避免 handler 安装窗口丢失变化事件。
      opened.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.requestToolRefresh(serverName, server, generation, opened?.client);
      });

      const tools = await withTimeout(
        discoverServerTools(serverName, opened.client, lifecycleAbort.signal),
        TOOL_DISCOVERY_TIMEOUT_MS,
        () => new McpTimeoutError(serverName, 'tool discovery', TOOL_DISCOVERY_TIMEOUT_MS),
        (error) => lifecycleAbort.abort(error),
      );
      this.assertCurrent(serverName, server, generation);
      if (closedError) throw closedError;

      // 新批次先整体校验并提交，再移除缓存中已经消失的旧工具，避免半注册。
      this.toolRegistry.registerMcpBatch(toTools(tools, this));
      const primedTools = this.primed.get(serverName) ?? [];
      const liveNames = new Set(tools.map((tool) => tool.qualifiedName));
      unregisterTools(
        this.toolRegistry,
        primedTools.filter((tool) => !liveNames.has(tool.qualifiedName)),
      );
      this.primed.delete(serverName);

      const info = connectionInfo(serverName, 'connected', tools);
      server.info = info;
      server.retryAttempt = 0;
      this.publish(info);
      server.opened = opened;
      retained = true;
      connectionCommitted = true;

      // 工具缓存失败不能破坏已经建立的实时连接。
      try { this.store.cacheTools(serverName, tools); } catch { /* ignore */ }
      this.startRequestedToolRefresh(serverName, server, generation, opened.client);
      return copyConnection(info);
    } catch (err) {
      if (server.generation !== generation) {
        throw err instanceof McpConnectionSupersededError
          ? err
          : new McpConnectionSupersededError(serverName);
      }
      const error = err instanceof Error ? err.message : String(err);
      server.info = connectionInfo(
        serverName,
        'failed',
        this.primed.get(serverName) ?? [],
        error,
      );
      const primedTools = this.primed.get(serverName);
      if (primedTools) {
        unregisterTools(this.toolRegistry, primedTools);
        this.primed.delete(serverName);
      }
      this.publish(server.info);
      throw err;
    } finally {
      if (!retained && opened) await cleanupQuietly(opened);
      if (server.generation === generation) {
        server.connectTask = undefined;
        if (!retained) server.lifecycleAbort = undefined;
      }
    }
  }

  private handleUnexpectedClose(
    serverName: string,
    server: McpServer,
    generation: number,
    opened: OpenedConnection,
    error: Error,
  ): void {
    if (
      server.generation !== generation
      || server.opened !== opened
      || server.info.status !== 'connected'
    ) {
      return;
    }

    const tools = server.info.tools;
    server.generation += 1;
    server.lifecycleAbort?.abort(error);
    server.opened = undefined;
    server.connectTask = undefined;
    server.lifecycleAbort = undefined;
    server.refreshTask = undefined;
    server.refreshRequested = false;
    server.info = connectionInfo(serverName, 'failed', tools, error.message);
    unregisterTools(this.toolRegistry, tools);
    this.publish(server.info);
    const record = this.store.findByName(serverName);
    if (record?.enabled && record.config.type === 'http') {
      this.scheduleHttpRetry(serverName, server, server.retryAttempt ?? 0);
    }
  }

  private assertCurrent(
    serverName: string,
    server: McpServer,
    generation: number,
  ): void {
    if (server.generation !== generation) {
      throw new McpConnectionSupersededError(serverName);
    }
  }

  private requestToolRefresh(
    serverName: string,
    server: McpServer,
    generation: number,
    client: OpenedConnection['client'] | undefined,
  ): void {
    if (server.generation !== generation || !client) return;
    server.refreshRequested = true;
    this.startRequestedToolRefresh(serverName, server, generation, client);
  }

  private startRequestedToolRefresh(
    serverName: string,
    server: McpServer,
    generation: number,
    client: OpenedConnection['client'],
  ): void {
    if (
      !server.refreshRequested ||
      server.refreshTask ||
      server.generation !== generation ||
      server.info.status !== 'connected' ||
      server.opened?.client !== client
    ) {
      return;
    }

    const task = this.runToolRefreshLoop(serverName, server, generation, client);
    server.refreshTask = task;
    void task.catch((err) => {
      console.warn(`[mcp] Failed to refresh tools for "${serverName}": ${(err as Error).message}`);
    });
  }

  private async runToolRefreshLoop(
    serverName: string,
    server: McpServer,
    generation: number,
    client: OpenedConnection['client'],
  ): Promise<void> {
    try {
      while (server.refreshRequested && server.generation === generation) {
        server.refreshRequested = false;
        const linked = linkedAbortController(server.lifecycleAbort?.signal);
        try {
          const tools = await withTimeout(
            discoverServerTools(serverName, client, linked.controller.signal),
            TOOL_DISCOVERY_TIMEOUT_MS,
            () => new McpTimeoutError(serverName, 'tool refresh', TOOL_DISCOVERY_TIMEOUT_MS),
            (error) => linked.controller.abort(error),
          );
          this.assertCurrent(serverName, server, generation);
          if (server.opened?.client !== client || server.info.status !== 'connected') return;

          this.replaceRegisteredTools(server.info.tools, tools);
          server.info = connectionInfo(
            serverName,
            'connected',
            tools,
          );
          this.publish(server.info);
          try { this.store.cacheTools(serverName, tools); } catch { /* ignore */ }
        } finally {
          linked.dispose();
        }
      }
    } finally {
      if (server.generation === generation) {
        server.refreshTask = undefined;
        if (server.refreshRequested) {
          queueMicrotask(() => {
            this.startRequestedToolRefresh(serverName, server, generation, client);
          });
        }
      }
    }
  }

  private replaceRegisteredTools(
    previousTools: readonly McpToolInfo[],
    nextTools: readonly McpToolInfo[],
  ): void {
    // registerMcpBatch 会先验证整批再同步提交；随后在同一事件循环片段移除旧工具。
    this.toolRegistry.registerMcpBatch(toTools(nextTools, this));
    const nextNames = new Set(nextTools.map((tool) => tool.qualifiedName));
    unregisterTools(
      this.toolRegistry,
      previousTools.filter((tool) => !nextNames.has(tool.qualifiedName)),
    );
  }

  private scheduleHttpRetry(
    serverName: string,
    server: McpServer,
    attempt: number,
  ): void {
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    if (attempt >= delays.length || server.retryTimer) return;
    server.retryAttempt = attempt + 1;
    server.info = connectionInfo(serverName, 'connecting', this.store.findByName(serverName)?.cachedTools ?? []);
    this.publish(server.info);
    server.retryTimer = setTimeout(() => {
      server.retryTimer = undefined;
      const current = this.store.findByName(serverName);
      if (!current?.enabled || current.config.type !== 'http') return;
      void this.connectConfig(serverName, current.config).catch(() => {
        const slot = this.servers.get(serverName);
        if (slot) this.scheduleHttpRetry(serverName, slot, attempt + 1);
      });
    }, delays[attempt]);
  }

  private publish(connection: McpConnection): void {
    this.connectionChanged(copyConnection(connection));
  }
}

// ToolRegistry 保存类型各异的 Tool;MCP 侧统一由 buildMcpBuiltTool 产生。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMcpTool = Tool<any, any, any, any>;

function toTools(
  tools: readonly McpToolInfo[],
  registry: McpRegistry,
): AnyMcpTool[] {
  return tools.map((tool) => buildMcpBuiltTool(tool, registry));
}

function unregisterTools(toolRegistry: ToolRegistry, tools: readonly McpToolInfo[]): void {
  for (const tool of tools) {
    toolRegistry.unregisterMcp(tool.originalServerName, tool.serverToolName);
  }
}
