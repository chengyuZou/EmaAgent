import { create } from 'zustand';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import {
  mcpApi,
  type McpAuthType,
  type McpImportResult,
  type McpInstallProvenance,
  type McpMarketEntry,
  type McpMarketInstallInput,
  type McpMarketSource,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerSummary,
} from '../api/mcp.js';
import { showToast } from '../lib/notifications/toast.js';

interface McpStoreState {
  servers: McpServerSummary[];
  loading: boolean;
  error: string | null;

  /** Official 市场条目的 externalId. 仅表示配置添加中, 不表示服务器连接状态. */
  addingMarketEntryIds: ReadonlySet<McpMarketEntry['externalId']>;

  load(): Promise<void>;
  /** 返回本次读取的错误或 null, 不从可能被其他刷新改写的 error 判断本次结果. */
  refresh(): Promise<string | null>;
  create(name: string, config: McpServerConfig, provenance?: McpInstallProvenance, authType?: McpAuthType): Promise<void>;
  update(name: string, config: McpServerConfig, provenance?: McpInstallProvenance, authType?: McpAuthType): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  connect(name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  startOAuth(name: string): Promise<string | null>;
  cancelOAuth(name: string): Promise<void>;
  clearOAuthTokens(name: string): Promise<void>;
  probe(serverName: string, config: McpServerConfig): Promise<McpProbeResult>;
  importFromJson(payload: object | string): Promise<McpImportResult['items']>;
  addFromMarket(source: McpMarketSource, input: McpMarketInstallInput): Promise<void>;
}

// 多个市场条目并发添加时, 较早发出的列表读取不能覆盖较新读取的结果.
let serverListRequest = 0;

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  addingMarketEntryIds: new Set(),

  async load() {
    if (!get().servers.length) await get().refresh();
  },
  async refresh() {
    const request = ++serverListRequest;
    set({ loading: true, error: null });
    try {
      const { items } = await mcpApi.list();
      if (request === serverListRequest) {
        set({ servers: items, loading: false });
      }
      return null;
    } catch (error) {
      const message = messageOf(error);
      if (request === serverListRequest) {
        set({ error: message, loading: false });
      }
      return message;
    }
  },
  async create(name, config, provenance, authType) {
    await mcpApi.create({
      name,
      config,
      ...(provenance ? { provenance } : {}),
      ...(authType ? { authType } : {}),
    });
    await get().refresh();
  },
  async update(name, config, provenance, authType) {
    await mcpApi.update(name, {
      config,
      ...(provenance ? { provenance } : {}),
      ...(authType ? { authType } : {}),
    });
    await get().refresh();
  },
  async enable(name) {
    await mcpApi.enable(name);
    await get().refresh();
  },
  async disable(name) {
    await mcpApi.disable(name);
    await get().refresh();
  },
  async connect(name) {
    await mcpApi.connect(name);
    await get().refresh();
  },
  async disconnect(name) {
    await mcpApi.disconnect(name);
    await get().refresh();
  },
  async remove(name) {
    await mcpApi.remove(name);
    set(state => ({ servers: state.servers.filter(server => server.name !== name) }));
  },
  async startOAuth(name) {
    const result = await mcpApi.startOAuth(name);
    await get().refresh();
    return result.authorizationUrl;
  },
  async cancelOAuth(name) {
    await mcpApi.cancelOAuth(name);
    await get().refresh();
  },
  async clearOAuthTokens(name) {
    await mcpApi.clearOAuthTokens(name);
    await get().refresh();
  },
  probe(serverName, config) {
    return mcpApi.probe({ serverName, config });
  },
  async importFromJson(payload) {
    const { items } = await mcpApi.import(payload);
    await get().refresh();
    return items;
  },
  async addFromMarket(source, input) {
    const id = input.externalId;
    if (get().addingMarketEntryIds.has(id)) return;

    set(state => ({
      addingMarketEntryIds: new Set(state.addingMarketEntryIds).add(id),
    }));

    try {
      const result = await mcpApi.installFromMarket(source, input);
      const refreshError = await get().refresh();
      if (refreshError) {
        showToast(`已添加 ${result.name}, 但服务器列表刷新失败: ${refreshError}`, { variant: 'warning' });
      } else {
        showToast(`已添加 ${result.name}.`, { variant: 'success' });
      }
    } catch (error) {
      showToast(`添加失败: ${messageOf(error)}`, { variant: 'danger' });
    } finally {
      set(state => {
        const addingMarketEntryIds = new Set(state.addingMarketEntryIds);
        addingMarketEntryIds.delete(id);
        return { addingMarketEntryIds };
      });
    }
  },
}));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function handleMcpSystemEvent(event: AppEvent): void {
  if (
    (
      event.type === 'mcp_connection_changed'
      || event.type === 'mcp_servers_changed'
      || event.type === 'mcp_oauth_changed'
    )
    && useMcpStore.getState().servers.length > 0
  ) {
    void useMcpStore.getState().refresh().catch(() => {});
  }
}
