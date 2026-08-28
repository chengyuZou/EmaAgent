import { create } from 'zustand';
import { mcpApi, type McpServerConfig, type McpServerItem, type McpConnection, type McpProbeResult, type McpImportResult, type McpMarketEntry, type McpInstallProvenance } from '../api/mcp.js';

export type { McpServerConfig, McpServerItem, McpConnection, McpProbeResult, McpImportResult, McpMarketEntry };

// ── Composite type used everywhere in the UI ──────────────────────────────────

/** 列表条目即记录 + 实时连接态（服务端已合成，前端不再拼装）。 */
export type McpServerEntry = McpServerItem;

// ── Store interface ───────────────────────────────────────────────────────────

export interface McpStoreState {
  servers:  McpServerEntry[];
  loading:  boolean;
  error:    string | null;

  marketServers: McpMarketEntry[];
  marketLoading: boolean;
  marketError:   string | null;
  marketSource:  string;

  /** Load all registered MCP servers + their connection status. */
  load(): Promise<void>;
  /** Force-reload the server list. */
  refresh(): Promise<void>;

  /**
   * Register a new MCP server config.
   * `connect: false` saves it disconnected (market installs needing env first).
   * Returns the connection status from the registration attempt.
   */
  register(name: string, config: McpServerConfig, sourceUrl?: string, connect?: boolean, provenance?: McpInstallProvenance): Promise<McpConnection>;

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

  /** Fetch the browsable MCP server marketplace (official registry). */
  listMarket(): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  loading: false,
  error:   null,

  marketServers: [],
  marketLoading: false,
  marketError:   null,
  marketSource:  '',

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
      const result = await mcpApi.register({
        name,
        config,
        connect,
        ...(sourceUrl !== undefined ? { sourceUrl } : {}),
        ...(provenance !== undefined ? { provenance } : {}),
      });
      await get().refresh();
      // 注册成功但首连失败：记录已落库，按未连接如实返回（UI 可稍后再连）。
      if ('connection' in result) return result.connection;
      return { serverName: name, status: 'disconnected', tools: [] };
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

  async listMarket() {
    set({ marketLoading: true, marketError: null });
    try {
      const res = await mcpApi.listEntries();
      const okCount = res.sources.filter((s) => !s.error).length;
      const errCount = res.sources.filter((s) => s.error).length;
      const sourceLabel = errCount > 0
        ? `${okCount} 个源 · ${errCount} 个失败`
        : `${okCount} 个源`;
      set({ marketServers: [...res.items], marketSource: sourceLabel, marketLoading: false });
    } catch (err: unknown) {
      set({
        marketError:   err instanceof Error ? err.message : 'Failed to load MCP market',
        marketLoading: false,
      });
    }
  },
}));
