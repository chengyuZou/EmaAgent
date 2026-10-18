import { randomUUID }       from 'node:crypto';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolRegistry } from '@ema-agent/tools';
import type { McpServerStore }                            from './store.js';
import type {
  McpServerConfig,
  McpServerRecord,
  McpConnection,
  McpProbeResult,
  McpServerDetail,
  McpServerSummary,
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
  /** 断开或替换连接时递增. 旧异步任务只能清理自身, 不能再改写连接和工具. */
  generation: number;
  /** 相同配置的并发请求共用 connectTask, 配置改变时重新连接. */
  configJson?: string;
  info: McpConnection;
  /** 只有握手和初次工具发现都完成后才保存连接. */
  opened?: OpenedConnection;
  connectTask?: Promise<McpConnection>;
  /** 断开或替换连接时取消握手和工具刷新. */
  lifecycleAbort?: AbortController;
  /** 同一连接最多运行一个工具刷新循环. */
  refreshTask?: Promise<void>;
  /** 连接或刷新期间收到的 list_changed 合并到下一次刷新. */
  refreshRequested?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryAttempt?: number;
}

export class McpRegistry {
  private servers = new Map<string, McpServer>();
  /** 尚未被在线工具替换的启动缓存, 用于失败或断开时注销工具. */
  private primed = new Map<string, McpToolInfo[]>();

  constructor(
    private readonly store:        McpServerStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly connectionChanged: (connection: McpConnection) => void = () => {},
  ) {}

  async connect(serverName: string): Promise<McpConnection> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    if (!record.enabled) {
      throw new McpConnectionError(serverName, 'server is disabled');
    }
    return this.connectConfig(serverName, record.config);
  }

  connectConfig(serverName: string, config: McpServerConfig): Promise<McpConnection> {
    const server = this.serverFor(serverName);
    const configJson = JSON.stringify(config);

    // 后台连接尚未完成时, 首次工具调用等待同一任务, 避免重复启动子进程.
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
   * 启动时先注册已启用服务器的缓存工具, 随后由宿主启动后台连接.
   * 缓存工具被调用时仍需等待实时连接和工具发现完成.
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

  private primableTools(record: McpServerRecord): McpToolInfo[] | null {
    const server = this.servers.get(record.name);
    if (server?.opened || server?.connectTask) return null;
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

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    signal?:    AbortSignal,
  ): Promise<McpToolOutput> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    // 运行中的 Turn 可能仍持有该服务器的工具, 禁用后不能因旧引用重新连接.
    if (!record.enabled) {
      throw new McpConnectionError(serverName, 'server is disabled');
    }
    const timeoutMs = record.config.toolTimeoutSec !== undefined
      ? record.config.toolTimeoutSec * 1000
      : undefined;
    // 单次调用取消只结束自身等待, 不取消其他调用共享的连接任务.
    await waitForPromise(this.connectConfig(serverName, record.config), signal);
    const conn = this.servers.get(serverName)?.opened;
    if (!conn) {
      throw new McpServerNotFoundError(`${serverName} (not connected)`);
    }
    return callMcpTool({ client: conn.client, serverName, toolName, args, signal, timeoutMs });
  }

  listServers(): McpServerSummary[] {
    return this.store.listSettings().map((settings) => {
      const connection = this.servers.get(settings.name)?.info;
      return {
        name: settings.name,
        provenance: settings.provenance,
        config: settings.config,
        enabled: settings.enabled,
        connectionStatus: connection?.status ?? 'disconnected',
        ...(connection?.error ? { connectionError: connection.error } : {}),
        toolCount: connection?.status === 'connected'
          ? connection.tools.length
          : settings.cachedToolCount,
      };
    });
  }

  getServer(serverName: string): McpServerDetail | null {
    const record = this.store.findByName(serverName);
    if (!record) return null;
    const connection = this.servers.get(serverName)?.info;
    const tools = connection?.status === 'connected'
      ? connection.tools
      : (record.cachedTools ?? []);
    return {
      name: record.name,
      provenance: record.provenance,
      config: record.config,
      enabled: record.enabled,
      connectionStatus: connection?.status ?? 'disconnected',
      ...(connection?.error ? { connectionError: connection.error } : {}),
      toolCount: tools.length,
      tools: [...tools],
    };
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

  /**
   * 禁用后断开连接并注销工具; 启用后开始后台连接.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    this.store.setEnabled(name, enabled);
    if (!enabled) {
      await this.disconnect(name);
      return;
    }
    this.connectInBackground(name);
  }

  /** 先断开并注销工具, 再删除配置, 避免留下仍在运行的子进程. */
  async remove(name: string): Promise<void> {
    await this.disconnect(name);
    this.store.remove(name);
  }

  /** 临时连接并发现工具, 最后关闭连接. 不保存配置或注册工具. */
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
        await cleanupQuietly(connection);
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

      // onerror 不一定导致连接关闭, 此时先保存错误供 onclose 使用.
      // 显式断开先增加 generation, 避免关闭回调把新状态改为 failed.
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

      // 先监听再读取工具, 连接期间收到的变化在初次注册完成后刷新, 避免漏掉通知.
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

      // 批量注册先校验整批工具, 成功后再移除缓存里已经消失的工具.
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

      try {
        this.store.cacheTools(serverName, tools);
      } catch {
        // 缓存写入失败时保留已经建立的实时连接.
      }
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
          try {
            this.store.cacheTools(serverName, tools);
          } catch {
            // 在线工具已替换成功, 缓存写入失败不撤销刷新.
          }
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
    // 验证整批并同步注册, 然后在同一段同步代码里移除旧工具.
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

// ToolRegistry 保存不同输入和结果类型的工具, MCP 工具由 buildMcpBuiltTool 创建.
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
