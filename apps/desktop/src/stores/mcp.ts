import { create } from 'zustand';
import {
  mcpApi,
  type McpImportResult,
  type McpInstallProvenance,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerItem,
} from '../api/mcp.js';

interface McpStoreState {
  servers: McpServerItem[];
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  refresh(): Promise<void>;
  save(name: string, config: McpServerConfig, provenance?: McpInstallProvenance): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  connect(name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  probe(serverName: string, config: McpServerConfig): Promise<McpProbeResult>;
  importFromJson(payload: object | string): Promise<McpImportResult['items']>;
}

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,

  async load() {
    if (!get().servers.length) await get().refresh();
  },
  async refresh() {
    set({ loading: true, error: null });
    try {
      const { items } = await mcpApi.list();
      set({ servers: items, loading: false });
    } catch (error) {
      set({ error: messageOf(error), loading: false });
    }
  },
  async save(name, config, provenance) {
    await mcpApi.save({ name, config, ...(provenance ? { provenance } : {}) });
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
  probe(serverName, config) {
    return mcpApi.probe({ serverName, config });
  },
  async importFromJson(payload) {
    const { items } = await mcpApi.import(payload);
    await get().refresh();
    return items;
  },
}));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
