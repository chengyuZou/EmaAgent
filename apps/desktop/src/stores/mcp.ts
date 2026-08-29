// 管理 MCP Server 连接状态与 Registry 条目读取,不混入 Skill 站点语义.
import { create } from 'zustand';
import {
  mcpApi,
  type McpConnection,
  type McpImportResult,
  type McpInstallProvenance,
  type McpRegistryEntry,
  type McpRegistryEntryList,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerItem,
} from '../api/mcp.js';

// ── Store interface ───────────────────────────────────────────────────────────

export interface McpStoreState {
  servers:  McpServerItem[];
  loading:  boolean;
  error:    string | null;

  registryEntries: McpRegistryEntry[];
  registryReports: McpRegistryEntryList['sources'];
  registryLoading: boolean;
  registryError:   string | null;

  /** Load all registered MCP servers + their connection status. */
  load(): Promise<void>;
  /** Force-reload the server list. */
  refresh(): Promise<void>;

  /**
   * Register a new MCP server config.
   * `connect: false` saves it disconnected (market installs needing env first).
   * Returns the connection status from the registration attempt.
   */
  register(name: string, config: McpServerConfig, sourceUrl?: string, connect?: boolean, provenance?: McpInstallProvenance): Promise<void>;

  /** Enable a server (persists to DB + attempts reconnect). */
  enable(name: string): Promise<void>;
  /** Disable a server (persists to DB + disconnects). */
  disable(name: string): Promise<void>;

  /** Connect an already-registered server (one-shot, does not persist enabled flag). */
  connect(name: string): Promise<McpConnection>;
  /** Disconnect a connected server. */
  disconnect(name: string): Promise<void>;

  /** Unregister and remove a server. */
  remove(name: string): Promise<void>;

  /**
   * Probe a server config without registering it.
   * Used to validate before saving (e.g. in the "Add server" dialog).
   */
  probe(serverName: string, config: McpServerConfig): Promise<McpProbeResult>;

  /**
   * Bulk-import servers from a Claude Desktop / mcp.so JSON config.
   * Refreshes server list on completion. Returns per-server results.
   */
  importFromJson(payload: object | string): Promise<McpImportResult['items']>;

  /** 聚合读取所有已启用 MCP Registry 来源的可安装条目. */
  loadRegistryEntries(): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  loading: false,
  error:   null,

  registryEntries: [],
  registryReports: [],
  registryLoading: false,
  registryError:   null,

  async load() {
    if (get().servers.length > 0) return;
    return get().refresh();
  },

  async refresh() {
    set({ loading: true, error: null });
    try {
      const { items } = await mcpApi.list();
      set({ servers: [...items], loading: false });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load MCP servers',
        loading: false,
      });
    }
  },

  async register(name, config, sourceUrl, connect = true, provenance) {
    try {
      await mcpApi.register({
        name,
        config,
        connect,
        ...(sourceUrl !== undefined ? { sourceUrl } : {}),
        ...(provenance !== undefined ? { provenance } : {}),
      });
      await get().refresh();
      // 注册结果以重读后的 Server 记录为准，不在前端伪造连接状态。
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to register MCP server' });
      throw err;
    }
  },

  async enable(name) {
    try {
      await mcpApi.enable(name);
      await get().refresh();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to enable MCP server' });
      throw err;
    }
  },

  async disable(name) {
    try {
      await mcpApi.disable(name);
      await get().refresh();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to disable MCP server' });
      throw err;
    }
  },

  async connect(name) {
    try {
      const { connection } = await mcpApi.connect(name);
      // Patch the connection status in-place without a full reload.
      set((s) => ({
        servers: s.servers.map((sv) =>
          sv.name === name ? { ...sv, connection } : sv,
        ),
      }));
      return connection;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to connect MCP server' });
      throw err;
    }
  },

  async disconnect(name) {
    try {
      await mcpApi.disconnect(name);
      set((s) => ({
        servers: s.servers.map((sv) =>
          sv.name === name
            ? { ...sv, connection: { ...sv.connection, status: 'disconnected' } as McpConnection }
            : sv,
        ),
      }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to disconnect MCP server' });
      throw err;
    }
  },

  async remove(name) {
    try {
      await mcpApi.remove(name);
      set((s) => ({ servers: s.servers.filter((sv) => sv.name !== name) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to remove MCP server' });
      throw err;
    }
  },

  async probe(serverName, config) {
    return mcpApi.probe({ serverName, config });
  },

  async importFromJson(payload) {
    try {
      const { items } = await mcpApi.import(payload);
      await get().refresh();
      return items;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to import MCP servers' });
      throw err;
    }
  },

  async loadRegistryEntries() {
    set({ registryLoading: true, registryError: null });
    try {
      const res = await mcpApi.listEntries();
      set({
        registryEntries: [...res.items],
        registryReports: [...res.sources],
        registryLoading: false,
      });
    } catch (err: unknown) {
      set({
        registryError: err instanceof Error ? err.message : '加载 MCP Registry 失败',
        registryLoading: false,
      });
    }
  },
}));
