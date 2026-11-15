import { logging } from '@ema-agent/logging';
import { randomUUID }       from 'node:crypto';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolRegistry } from '@ema-agent/tools';
import type { McpOAuthCredentialsRepo } from '@ema-agent/storage';
import type { McpServerStore }                            from './store.js';
import type { McpEvent }                                  from './events.js';
import type {
  McpAuthType,
  McpServerConfig,
  McpServerRecord,
  McpConnection,
  McpConnectionStatus,
  McpProbeResult,
  McpServerDetail,
  McpServerSummary,
  McpToolInfo,
  McpInstallProvenance,
} from './types.js';
import { openConnection }                                from './connections/connection.js';
import type { OpenedConnection }                         from './connections/connection.js';
import { discoverServerTools, buildMcpBuiltTool }       from './tools/discovery.js';
import { callMcpTool }                                   from './tools/execution.js';
import type { McpToolOutput }                            from './tools/execution.js';
import { McpOAuthService }                               from './auth/oauthService.js';
import type { McpOAuthLoginResult }                      from './auth/types.js';
import {
  linkedAbortController,
  waitForPromise,
  withTimeout,
} from './connections/requestControl.js';
import {
  McpServerNotFoundError,
  McpConnectionError,
  McpConnectionSupersededError,
  McpTimeoutError,
  McpUnsupportedTransportError,
} from './errors.js';

const TOOL_DISCOVERY_TIMEOUT_MS = 15_000;

/** 单台 MCP 服务器在当前进程内的连接状态与活动任务. */
interface McpServer {
  /** 断开, 替换连接或意外断线时递增; 异步任务跨 await 后发现版本不一致即放弃写入. */
  connectionVersion: number;
  /** 当前已连或建连中的配置 JSON 快照, 供相同配置请求复用 pendingConnectTask 或已建连接. */
  activeConfigJson?: string;
  status: McpConnectionStatus;
  /** 当前已登记到全局 ToolRegistry 的工具列表 (含启动时预登记缓存; 断开或失败时注销并清空). */
  registeredTools: McpToolInfo[];
  error?: string;
  /** 仅握手与初次工具发现都完成后保存底层连接句柄. */
  connection?: OpenedConnection;
  /** 进行中的建连任务, 供并发连接或工具调用复用等待. */
  pendingConnectTask?: Promise<McpConnection>;
  /** 断开或替换连接时取消握手, 初次工具发现与后台工具刷新循环. */
  lifecycleAbort?: AbortController;
  /** 同一在线连接最多运行一个工具列表刷新循环, 响应 notifications/tools/list_changed. */
  pendingToolRefreshTask?: Promise<void>;
  /** 建连或工具刷新期间收到 list_changed 时置位, 待本轮结束后补刷一次. */
  needsToolRefresh?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export class McpServerManager {
  private servers = new Map<string, McpServer>();
  private readonly oauthService?: McpOAuthService;

  constructor(
    private readonly store:        McpServerStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly onEvent:      (event: McpEvent) => void = () => {},
    oauthCredentialsRepo?:         McpOAuthCredentialsRepo,
  ) {
    this.oauthService = oauthCredentialsRepo
      ? new McpOAuthService(oauthCredentialsRepo)
      : undefined;
  }

  async connect(serverName: string): Promise<McpConnection> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    if (!record.enabled) {
      throw new McpConnectionError(serverName, 'server is disabled');
    }
    return this.connectConfig(serverName, record.config);
  }

  private connectConfig(serverName: string, config: McpServerConfig): Promise<McpConnection> {
    const server = this.getOrCreateServer(serverName);
    const configJson = JSON.stringify(config);

    // 后台连接尚未完成时, 首次工具调用等待同一任务, 避免重复启动子进程.
    if (server.activeConfigJson === configJson) {
      if (server.pendingConnectTask) return server.pendingConnectTask;
      if (server.connection && server.status === 'connected') {
        return Promise.resolve(connectionSnapshot(serverName, server));
      }
    }

    return this.startConnection(serverName, config, configJson, server);
  }

  connectEnabled(): void {
    for (const record of this.store.listEnabled()) {
      void this.connect(record.name).catch(() => undefined);
    }
  }

  /**
   * 启动时先注册已启用服务器的缓存工具, 随后由宿主启动后台连接.
   * 缓存工具被调用时仍需等待实时连接和工具发现完成.
   */
  registerCachedToolsOnStartup(): number {
    const tools: AnyMcpTool[] = [];
    const pending: Array<[string, McpToolInfo[]]> = [];
    for (const record of this.store.listEnabled()) {
      const cached = this.startupCachedToolsFor(record);
      if (!cached) continue;
      tools.push(...toTools(cached, this));
      pending.push([record.name, cached]);
    }

    this.toolRegistry.registerMcpBatch(tools);
    for (const [serverName, cached] of pending) {
      const server = this.getOrCreateServer(serverName);
      if (server.status === 'disconnected') {
        server.registeredTools = [...cached];
        this.emitConnectionChanged();
      }
    }
    return tools.length;
  }

  private startupCachedToolsFor(record: McpServerRecord): McpToolInfo[] | null {
    const server = this.servers.get(record.name);
    if (server?.connection || server?.pendingConnectTask) return null;
    const cached = record.cachedTools;
    return cached && cached.length > 0 ? cached : null;
  }

  async disconnect(serverName: string): Promise<void> {
    const record = this.store.findByName(serverName);
    const hadPendingOAuth = Boolean(
      record?.config.type === 'http'
      && this.oauthService?.getStatus(serverName, record.authType, record.config.url)?.status === 'authorizing',
    );
    await this.teardownConnection(serverName, 'disconnected', undefined, true);
    this.emitConnectionChanged();
    if (hadPendingOAuth) {
      this.emitOAuthChanged();
    }
  }

  private async teardownConnection(
    serverName: string,
    nextStatus: McpConnectionStatus,
    nextError: string | undefined,
    cancelPendingOAuth: boolean,
  ): Promise<void> {
    const server = this.getOrCreateServer(serverName);
    server.connectionVersion += 1;
    if (server.retryTimer) clearTimeout(server.retryTimer);
    if (cancelPendingOAuth) {
      await this.oauthService?.cancelLogin(serverName);
    }
    const superseded = new McpConnectionSupersededError(serverName);
    server.lifecycleAbort?.abort(superseded);
    const previousConnection = server.connection;
    server.connection = undefined;
    server.pendingConnectTask = undefined;
    server.lifecycleAbort = undefined;
    server.pendingToolRefreshTask = undefined;
    server.needsToolRefresh = false;
    server.retryTimer = undefined;
    server.activeConfigJson = undefined;
    server.status = nextStatus;
    server.error = nextError;

    unregisterTools(this.toolRegistry, server.registeredTools);
    server.registeredTools = [];
    if (previousConnection) await previousConnection.cleanup();
  }

  async disconnectAll(): Promise<void> {
    const pendingTasks = [...this.servers.values()]
      .flatMap((server) => [server.pendingConnectTask, server.pendingToolRefreshTask])
      .filter((task) => task !== undefined);
    await Promise.all([...this.servers.keys()].map((name) => this.disconnect(name)));
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

    // 若为 HTTP 服务且启用了 OAuth, 并在调用工具前发现 Token 已过期或临近过期,
    // 提前触发并排队等待续期, 消除并发调用时的 401 往返与并发刷新竞争.
    if (record.config.type === 'http' && this.oauthService && record.authType === 'oauth') {
      await this.oauthService.ensureFreshToken(record.name, record.config.url, signal);
    }

    // 等待续期期间服务可能被禁用, 删除或变更配置, 醒来后重查最新状态.
    signal?.throwIfAborted();
    const latestRecord = this.store.findByName(serverName);
    if (!latestRecord) throw new McpServerNotFoundError(serverName);
    if (!latestRecord.enabled) {
      throw new McpConnectionError(serverName, 'server is disabled');
    }
    if (
      latestRecord.id !== record.id ||
      latestRecord.authType !== record.authType ||
      JSON.stringify(latestRecord.config) !== JSON.stringify(record.config)
    ) {
      throw new McpConnectionSupersededError(serverName);
    }
    const timeoutMs = latestRecord.config.toolTimeoutSec !== undefined
      ? latestRecord.config.toolTimeoutSec * 1000
      : undefined;

    // 单次调用取消只结束自身等待, 不取消其他调用共享的连接任务.
    await waitForPromise(this.connectConfig(serverName, latestRecord.config), signal);
    const conn = this.servers.get(serverName)?.connection;
    if (!conn) {
      throw new McpServerNotFoundError(`${serverName} (not connected)`);
    }
    return callMcpTool({ client: conn.client, serverName, toolName, args, signal, timeoutMs });
  }

  listServers(): McpServerSummary[] {
    return this.store.listSummaries().map((summary) => {
      const server = this.servers.get(summary.name);
      const oauth = summary.config.type === 'http'
        ? (this.oauthService?.getStatus(summary.name, summary.authType, summary.config.url) ?? null)
        : null;
      return {
        id: summary.id,
        name: summary.name,
        provenance: summary.provenance,
        config: summary.config,
        enabled: summary.enabled,
        authType: summary.authType,
        connectionStatus: server?.status ?? 'disconnected',
        ...(server?.error ? { connectionError: server.error } : {}),
        toolCount: server?.status === 'connected'
          ? server.registeredTools.length
          : summary.cachedToolCount,
        ...(oauth ? { oauth } : {}),
      };
    });
  }

  getServer(serverName: string): McpServerDetail | null {
    const record = this.store.findByName(serverName);
    if (!record) return null;
    const server = this.servers.get(serverName);
    const tools = server?.status === 'connected'
      ? server.registeredTools
      : (record.cachedTools ?? []);
    const oauth = record.config.type === 'http'
      ? (this.oauthService?.getStatus(record.name, record.authType, record.config.url) ?? null)
      : null;
    return {
      id: record.id,
      name: record.name,
      provenance: record.provenance,
      config: record.config,
      enabled: record.enabled,
      authType: record.authType,
      connectionStatus: server?.status ?? 'disconnected',
      ...(server?.error ? { connectionError: server.error } : {}),
      toolCount: tools.length,
      tools: [...tools],
      ...(oauth ? { oauth } : {}),
    };
  }

  /**
   * 为指定的 HTTP MCP 服务发起一次 OAuth 授权流程.
   * 启动本地临时回环端口并生成授权 URL 供浏览器打开.
   */
  async startOAuth(serverName: string): Promise<McpOAuthLoginResult> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    if (record.config.type !== 'http') {
      throw new McpUnsupportedTransportError(record.name, record.config.type);
    }
    if (!this.oauthService) {
      throw new Error('未配置 McpOAuthCredentialsRepo, 无法发起 OAuth 授权.');
    }

    const loginResult = await this.oauthService.startLogin({
      serverName: record.name,
      serverUrl: record.config.url,
    });

    // OAuth 登录流程成功发起后将服务认证模式切换为 'oauth', 保证后续连接和状态查询带入凭据.
    if (record.authType !== 'oauth') {
      this.store.setAuthType(serverName, 'oauth');
    }

    const client = this.oauthService.getClient(record.name, record.config.url);
    const pendingLogin = client.getPendingLogin();
    this.emitOAuthChanged();

    if (pendingLogin) {
      void pendingLogin.promise
        .then(async () => {
          this.emitOAuthChanged();
          // 授权成功后重查最新配置, 若仍处于启用状态则自动建立带 OAuth 的连接.
          const latest = this.store.findByName(serverName);
          if (latest?.enabled) {
            // 若此前以无鉴权状态意外保持 connected, 需先断开再以 oauthFetch 重新握手.
            if (this.servers.get(serverName)?.connection) {
              await this.disconnect(serverName);
            }
            await this.connect(serverName).catch(() => undefined);
          }
        })
        .catch((err) => {
          this.emitOAuthChanged();
          logging({
            level: 'warn',
            target: 'mcp',
            event: 'mcp.oauth.session_ended_with_error',
            message: `OAuth login for "${serverName}" ended: ${(err as Error).message}`,
            error: err,
          });
        });
    }

    return loginResult;
  }

  /**
   * 取消进行中的 OAuth 浏览器登录, 关闭临时回环端口.
   */
  async cancelOAuth(serverName: string): Promise<void> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);
    await this.oauthService?.cancelLogin(record.name);
    this.emitOAuthChanged();
  }

  /**
   * 清除本机已保存的 OAuth Token.
   * 断开当前连接, 清空 access_token, refresh_token 与过期时间, 保留客户端注册信息.
   */
  async clearOAuthTokens(serverName: string): Promise<void> {
    const record = this.store.findByName(serverName);
    if (!record) throw new McpServerNotFoundError(serverName);

    await this.teardownConnection(
      serverName,
      'failed',
      'OAuth authorization required',
      false,
    );
    if (this.oauthService) {
      await this.oauthService.clearTokens(record.name);
    }
    this.emitConnectionChanged();
    this.emitOAuthChanged();
  }

  /** 新建服务器配置; 仅保存配置, 不自动连接. */
  async create(
    name: string,
    config: McpServerConfig,
    provenance?: McpInstallProvenance,
    authType?: McpAuthType,
  ): Promise<string> {
    return this.store.create(name, config, provenance, authType);
  }

  /** 更新已有服务器配置; 断开旧连接且变更服务地址时清理旧 OAuth 客户端, 不自动重连. */
  async update(
    name: string,
    config: McpServerConfig,
    provenance?: McpInstallProvenance,
    authType?: McpAuthType,
  ): Promise<void> {
    const existing = this.store.findByName(name);
    if (!existing) throw new McpServerNotFoundError(name);

    await this.disconnect(name);
    const urlChanged = existing.config.type === 'http'
      && (config.type !== 'http' || existing.config.url !== config.url);
    if (urlChanged) {
      await this.oauthService?.removeClient(existing.name);
      this.emitOAuthChanged();
    }
    this.store.update(name, config, provenance, authType);
  }

  /**
   * 禁用后断开连接并注销工具; 启用只修改配置标记, 等待用户手动点击连接或下次启动.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    this.store.setEnabled(name, enabled);
    if (!enabled) {
      await this.disconnect(name);
    }
  }

  /** 先断开并注销工具, 再删除配置, 避免留下仍在运行的子进程. */
  async remove(name: string): Promise<void> {
    const existing = this.store.findByName(name);
    if (!existing) throw new McpServerNotFoundError(name);
    await this.disconnect(name);
    await this.oauthService?.removeClient(existing.name);
    this.servers.delete(name);
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
        await connection.cleanup();
      }
    }
  }

  private getOrCreateServer(serverName: string): McpServer {
    let server = this.servers.get(serverName);
    if (!server) {
      server = {
        connectionVersion: 0,
        status: 'disconnected',
        registeredTools: [],
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
    server.connectionVersion += 1;
    const version = server.connectionVersion;
    const superseded = new McpConnectionSupersededError(serverName);
    server.lifecycleAbort?.abort(superseded);
    const lifecycleAbort = new AbortController();
    const previousConnection = server.connection;
    // 已有在线连接被替换时先注销旧在线工具; 启动从 disconnected 建连则保留缓存工具直到完成或失败.
    if (server.status === 'connected') {
      unregisterTools(this.toolRegistry, server.registeredTools);
      server.registeredTools = [];
    }

    server.connection = undefined;
    server.activeConfigJson = configJson;
    server.lifecycleAbort = lifecycleAbort;
    server.pendingToolRefreshTask = undefined;
    server.needsToolRefresh = false;
    server.status = 'connecting';
    server.error = undefined;
    this.emitConnectionChanged();

    const task = this.runConnection(
      serverName,
      config,
      server,
      version,
      lifecycleAbort,
      previousConnection,
    );
    server.pendingConnectTask = task;
    return task;
  }

  private async runConnection(
    serverName: string,
    config: McpServerConfig,
    server: McpServer,
    version: number,
    lifecycleAbort: AbortController,
    previousConnection?: OpenedConnection,
  ): Promise<McpConnection> {
    let opened: OpenedConnection | undefined;
    let committed = false;
    let lastTransportError: Error | undefined;
    let closedError: Error | undefined;
    try {
      if (previousConnection) await previousConnection.cleanup();
      this.assertCurrent(serverName, server, version);

      const record = this.store.findByName(serverName);
      const oauthClient = (
        config.type === 'http'
        && record?.config.type === 'http'
        && record.config.url === config.url
        && record.authType === 'oauth'
      )
        ? this.oauthService?.getClient(record.name, record.config.url)
        : undefined;
      if (oauthClient) {
        await oauthClient.ensureFreshToken(lifecycleAbort.signal);
        this.assertCurrent(serverName, server, version);
      }
      opened = await openConnection(serverName, config, lifecycleAbort.signal, oauthClient?.fetchWithOAuth);
      this.assertCurrent(serverName, server, version);

      // onerror 不一定导致连接关闭, 此时先保存错误供 onclose 使用.
      // 显式断开先递增 connectionVersion, 避免关闭回调把新状态改为 failed.
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
        if (committed && opened) {
          this.handleUnexpectedClose(serverName, server, version, opened, error);
        }
        previousOnClose?.();
      };

      // 先监听再读取工具, 连接期间收到的变化在初次注册完成后刷新, 避免漏掉通知.
      opened.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.requestToolRefresh(serverName, server, version, opened?.client);
      });

      const tools = await withTimeout(
        discoverServerTools(serverName, opened.client, lifecycleAbort.signal),
        TOOL_DISCOVERY_TIMEOUT_MS,
        () => new McpTimeoutError(serverName, 'tool discovery', TOOL_DISCOVERY_TIMEOUT_MS),
        (error) => lifecycleAbort.abort(error),
      );
      this.assertCurrent(serverName, server, version);
      if (closedError) throw closedError;

      this.replaceRegisteredTools(server.registeredTools, tools);
      server.registeredTools = [...tools];
      server.status = 'connected';
      server.error = undefined;
      this.emitConnectionChanged();
      server.connection = opened;
      committed = true;

      try {
        this.store.cacheTools(serverName, tools);
      } catch {
        // 缓存写入失败时保留已经建立的实时连接.
      }
      this.startRequestedToolRefresh(serverName, server, version, opened.client);
      return connectionSnapshot(serverName, server);
    } catch (err) {
      if (server.connectionVersion !== version) {
        throw err instanceof McpConnectionSupersededError
          ? err
          : new McpConnectionSupersededError(serverName);
      }
      const isUnauthorized = isUnauthorizedError(err);
      if (isUnauthorized && server.retryTimer) {
        clearTimeout(server.retryTimer);
        server.retryTimer = undefined;
      }
      const error = isUnauthorized
        ? 'OAuth authorization required'
        : err instanceof Error ? err.message : String(err);
      unregisterTools(this.toolRegistry, server.registeredTools);
      server.registeredTools = [];
      server.status = 'failed';
      server.error = error;
      this.emitConnectionChanged();
      throw err;
    } finally {
      if (!committed && opened) await opened.cleanup();
      if (server.connectionVersion === version) {
        server.pendingConnectTask = undefined;
        if (!committed) server.lifecycleAbort = undefined;
      }
    }
  }

  private handleUnexpectedClose(
    serverName: string,
    server: McpServer,
    version: number,
    opened: OpenedConnection,
    error: Error,
  ): void {
    if (
      server.connectionVersion !== version
      || server.connection !== opened
      || server.status !== 'connected'
    ) {
      return;
    }

    server.connectionVersion += 1;
    server.lifecycleAbort?.abort(error);
    server.connection = undefined;
    server.pendingConnectTask = undefined;
    server.lifecycleAbort = undefined;
    server.pendingToolRefreshTask = undefined;
    server.needsToolRefresh = false;
    server.status = 'failed';
    server.error = error.message;
    unregisterTools(this.toolRegistry, server.registeredTools);
    server.registeredTools = [];
    this.emitConnectionChanged();
    const record = this.store.findByName(serverName);
    if (record?.enabled && record.config.type === 'http' && !isUnauthorizedError(error)) {
      this.scheduleHttpRetry(serverName, server, 0);
    }
  }

  private assertCurrent(
    serverName: string,
    server: McpServer,
    version: number,
  ): void {
    if (server.connectionVersion !== version) {
      throw new McpConnectionSupersededError(serverName);
    }
  }

  private requestToolRefresh(
    serverName: string,
    server: McpServer,
    version: number,
    client: OpenedConnection['client'] | undefined,
  ): void {
    if (server.connectionVersion !== version || !client) return;
    server.needsToolRefresh = true;
    this.startRequestedToolRefresh(serverName, server, version, client);
  }

  private startRequestedToolRefresh(
    serverName: string,
    server: McpServer,
    version: number,
    client: OpenedConnection['client'],
  ): void {
    if (
      !server.needsToolRefresh ||
      server.pendingToolRefreshTask ||
      server.connectionVersion !== version ||
      server.status !== 'connected' ||
      server.connection?.client !== client
    ) {
      return;
    }

    const task = this.runToolRefreshLoop(serverName, server, version, client);
    server.pendingToolRefreshTask = task;
    void task.catch((err) => {
      logging({
        level: 'warn',
        target: 'mcp',
        event: 'mcp.tools_refresh_failed',
        error: err,
        body: { serverName },
      });
    });
  }

  private async runToolRefreshLoop(
    serverName: string,
    server: McpServer,
    version: number,
    client: OpenedConnection['client'],
  ): Promise<void> {
    try {
      while (server.needsToolRefresh && server.connectionVersion === version) {
        server.needsToolRefresh = false;
        const linked = linkedAbortController(server.lifecycleAbort?.signal);
        try {
          const tools = await withTimeout(
            discoverServerTools(serverName, client, linked.controller.signal),
            TOOL_DISCOVERY_TIMEOUT_MS,
            () => new McpTimeoutError(serverName, 'tool refresh', TOOL_DISCOVERY_TIMEOUT_MS),
            (error) => linked.controller.abort(error),
          );
          this.assertCurrent(serverName, server, version);
          if (server.connection?.client !== client || server.status !== 'connected') return;

          this.replaceRegisteredTools(server.registeredTools, tools);
          server.registeredTools = [...tools];
          server.status = 'connected';
          server.error = undefined;
          this.emitConnectionChanged();
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
      if (server.connectionVersion === version) {
        server.pendingToolRefreshTask = undefined;
        if (server.needsToolRefresh) {
          queueMicrotask(() => {
            this.startRequestedToolRefresh(serverName, server, version, client);
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
    retryIndex: number,
  ): void {
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    if (retryIndex >= delays.length || server.retryTimer) return;
    server.status = 'connecting';
    server.error = undefined;
    this.emitConnectionChanged();
    server.retryTimer = setTimeout(() => {
      server.retryTimer = undefined;
      const current = this.store.findByName(serverName);
      if (!current?.enabled || current.config.type !== 'http') return;
      void this.connectConfig(serverName, current.config).catch(() => {
        const slot = this.servers.get(serverName);
        if (slot) this.scheduleHttpRetry(serverName, slot, retryIndex + 1);
      });
    }, delays[retryIndex]);
  }

  private emitConnectionChanged(): void {
    this.onEvent({ type: 'mcp_connection_changed' });
  }

  private emitOAuthChanged(): void {
    this.onEvent({ type: 'mcp_oauth_changed' });
  }
}

function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'UnauthorizedError' || /unauthorized|401/i.test(error.message);
}

// ToolRegistry 保存不同输入和结果类型的工具, MCP 工具由 buildMcpBuiltTool 创建.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMcpTool = Tool<any, any, any, any>;

function toTools(
  tools: readonly McpToolInfo[],
  serverManager: McpServerManager,
): AnyMcpTool[] {
  return tools.map((tool) => buildMcpBuiltTool(tool, serverManager));
}

function unregisterTools(toolRegistry: ToolRegistry, tools: readonly McpToolInfo[]): void {
  for (const tool of tools) {
    toolRegistry.unregisterMcp(tool.originalServerName, tool.serverToolName);
  }
}

function connectionSnapshot(serverName: string, server: McpServer): McpConnection {
  return {
    serverName,
    status: server.status,
    tools: [...server.registeredTools],
    ...(server.error ? { error: server.error } : {}),
  };
}
